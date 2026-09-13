import { randomUUID } from 'node:crypto';
import type { Scenario } from '../../packages/shared/scenario.js';
import {
  proposalSchema,
  judgmentSchema,
  type PublicGameState,
  type Proposal,
  type InventoryItem,
  type Judgment,
  type VoiceState,
} from '../../packages/shared/game.js';
import { GameClock } from './clock.js';
import type { GamePhoto } from './photo.js';
import type { GameAI, AIContext } from './game-ai.js';
export class GameError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export class GameSession {
  readonly id = randomUUID();
  generation = 0;
  status: PublicGameState['status'] = 'briefing';
  obstacleIndex = 0;
  actionsUsed = 0;
  inventory: InventoryItem[] = [];
  photos: GamePhoto[] = [];
  proposal: Proposal | null = null;
  inputRevision = 0;
  revision = 0;
  transcript = '';
  situation: string;
  error: string | null = null;
  lastResult: PublicGameState['lastResult'] = null;
  voiceState: VoiceState = 'connecting';
  readonly clock: GameClock;
  private pending: string | null = null;
  private recognizing = false;
  private recognitionQueued = false;
  private photoBusy = false;
  private actions = new Map<
    string,
    { revision: number; status: 'pending' | 'failed' | 'complete' | 'invalid'; result?: Judgment }
  >();
  constructor(
    readonly scenario: Scenario,
    private ai: GameAI,
    now?: () => number,
    private onEnd: () => void = () => {},
  ) {
    this.situation = scenario.obstacles[0].situation;
    this.clock = new GameClock(scenario.rules.totalTimeSeconds, now);
  }
  get terminal() {
    return ['won', 'lost', 'expired'].includes(this.status);
  }
  check() {
    this.clock.tick();
    if (!this.terminal && this.status !== 'briefing') {
      if (this.clock.waitingRemainingMs <= 0) this.end('expired');
      else if (this.clock.remainingMs <= 0) this.end('lost');
    }
  }
  state(): PublicGameState {
    this.check();
    return structuredClone({
      id: this.id,
      generation: this.generation,
      status: this.status,
      title: this.scenario.title,
      briefing: this.scenario.playerBriefing,
      obstacle: {
        title: this.scenario.obstacles[this.obstacleIndex].title,
        index: this.obstacleIndex,
        count: this.scenario.obstacles.length,
      },
      situation: this.situation,
      actionsRemaining: this.scenario.rules.maxActions - this.actionsUsed,
      remainingMs: this.clock.remainingMs,
      waitingRemainingMs: this.clock.waitingRemainingMs,
      paused: this.clock.paused,
      maxPhotos: this.scenario.rules.maxPhotosPerAction,
      photoCount: this.photos.length,
      inventory: this.inventory,
      proposal: this.proposal,
      inputRevision: this.inputRevision,
      busy: !!this.pending || this.recognizing || this.photoBusy,
      voiceState: this.voiceState,
      transcript: this.transcript,
      lastResult: this.lastResult,
      error: this.error,
    });
  }
  start() {
    this.check();
    if (this.status === 'briefing') {
      if (this.voiceState !== 'connected')
        throw new GameError(409, '音声接続後に開始してください。');
      this.status = 'playing';
      this.clock.start();
    }
    return this.state();
  }
  heartbeat(voice: VoiceState) {
    this.voiceState = voice;
    if (voice === 'closed') {
      this.end('expired');
      return;
    }
    if (voice === 'connected') this.clock.resume('recovery');
    else this.clock.pause('recovery');
    this.check();
  }
  end(status: 'won' | 'lost' | 'expired' = 'expired') {
    if (this.terminal) return;
    this.status = status;
    this.generation++;
    for (const action of this.actions.values())
      if (action.status === 'pending') action.status = 'invalid';
    this.pending = null;
    this.photos = [];
    this.transcript = '';
    this.proposal = null;
    this.clock.stop();
    this.onEnd();
  }
  private editable() {
    this.check();
    if (this.terminal) throw new GameError(410, 'プレイは終了しています。');
    if (this.pending) throw new GameError(409, '判定中です。');
  }
  invalidate() {
    this.inputRevision++;
    this.proposal = null;
    this.error = null;
  }
  /** Invalidate work from the previous tab without restarting the game. */
  changeController() {
    this.generation++;
    for (const action of this.actions.values()) {
      if (action.status === 'pending') action.status = 'invalid';
    }
    this.pending = null;
    this.photoBusy = false;
    if (this.status === 'judging') this.status = 'playing';
    this.clock.resume('judgment');
    this.invalidate();
  }
  beginPhotos() {
    this.editable();
    if (this.photoBusy) throw new GameError(409, '写真を処理中です。');
    this.photoBusy = true;
    this.invalidate();
    return { generation: this.generation, revision: this.inputRevision };
  }
  async finishPhotos(photos: GamePhoto[], ticket: { generation: number; revision: number }) {
    if (this.terminal || ticket.generation !== this.generation)
      throw new GameError(410, 'プレイが失効しました。');
    this.photoBusy = false;
    this.photos = photos;
    this.invalidate();
    await this.recognize(true);
  }
  cancelPhotos() {
    this.photoBusy = false;
  }
  appendTranscript(delta: string) {
    this.editable();
    this.transcript = (this.transcript + delta).slice(-8000);
    this.invalidate();
  }
  private context(): AIContext {
    return {
      scenario: this.scenario,
      obstacleIndex: this.obstacleIndex,
      situation: this.situation,
      inventory: structuredClone(this.inventory),
      photos: [...this.photos],
      transcript: this.transcript,
    };
  }
  async recognize(blocking = false) {
    this.editable();
    if (this.photoBusy) return;
    if (this.proposal?.inputRevision === this.inputRevision) return;
    if (this.recognizing) {
      this.recognitionQueued = true;
      return;
    }
    this.recognizing = true;
    if (blocking) this.clock.pause('recognition');
    try {
      do {
        this.recognitionQueued = false;
        const revision = this.inputRevision,
          generation = this.generation;
        const context = this.context();
        try {
          const proposal = proposalSchema.parse(await this.ai.recognize(context));
          if (this.terminal || this.generation !== generation || this.inputRevision !== revision)
            continue;
          for (const item of proposal.items) {
            if ((item.photoId === null) === (item.inventoryId === null))
              throw new Error('Invalid item source');
            if (item.photoId && !this.photos.some((p) => p.id === item.photoId))
              throw new Error('Unknown photo');
            if (
              item.inventoryId &&
              !this.inventory.some((p) => p.id === item.inventoryId && p.status !== 'consumed')
            )
              throw new Error('Unknown inventory');
          }
          this.proposal = { ...proposal, revision: ++this.revision, inputRevision: revision };
          this.error = null;
        } catch {
          if (this.inputRevision === revision && !this.terminal)
            this.error = '認識できませんでした。写真や音声を訂正して再試行してください。';
        }
      } while (this.recognitionQueued && !this.terminal && !this.photoBusy);
    } finally {
      this.recognizing = false;
      this.clock.resume('recognition');
      this.check();
    }
  }
  async commit(actionId: string, proposalRevision: number) {
    this.check();
    const previous = this.actions.get(actionId);
    if (previous) {
      if (previous.revision !== proposalRevision)
        throw new GameError(409, '同じ行動IDの内容を変更できません。');
      if (previous.status === 'invalid') throw new GameError(410, '行動は失効しました。');
      if (previous.status === 'pending') throw new GameError(409, '行動を処理中です。');
      if (previous.status === 'failed')
        throw new GameError(502, '判定に失敗しました。新しい行動IDで再試行してください。');
      return previous.result!;
    }
    this.editable();
    if (
      this.status !== 'playing' ||
      this.recognizing ||
      this.photoBusy ||
      !this.proposal ||
      this.proposal.revision !== proposalRevision ||
      this.proposal.inputRevision !== this.inputRevision ||
      !this.proposal.usage ||
      !this.proposal.items.length
    )
      throw new GameError(409, '最新の道具と使い方の認識を確認してください。');
    if (this.actions.size >= 100) throw new GameError(429, '操作上限です。');
    const record: {
      revision: number;
      status: 'pending' | 'failed' | 'complete' | 'invalid';
      result?: Judgment;
    } = { revision: proposalRevision, status: 'pending' };
    this.actions.set(actionId, record);
    this.pending = actionId;
    this.status = 'judging';
    this.clock.pause('judgment');
    const generation = this.generation,
      proposal = structuredClone(this.proposal),
      context = this.context();
    const photoIds = new Set<string>();
    const materialized: InventoryItem[] = [];
    const photoInventory = new Map<string, string>();
    for (const item of proposal.items) {
      if (item.photoId && !photoIds.has(item.photoId)) {
        photoIds.add(item.photoId);
        const id = randomUUID();
        photoInventory.set(item.photoId, id);
        materialized.push({ id, name: item.name, description: item.name, status: 'available' });
      }
    }
    context.inventory.push(...materialized);
    for (const item of proposal.items) {
      if (item.photoId) {
        item.inventoryId = photoInventory.get(item.photoId)!;
        item.photoId = null;
      }
    }
    try {
      const result = judgmentSchema.parse(await this.ai.judge(context, proposal));
      this.check();
      if (this.terminal || generation !== this.generation || this.pending !== actionId)
        throw new GameError(410, '行動は失効しました。');
      const ids = new Set<string>();
      for (const change of result.inventoryChanges) {
        if (
          ids.has(change.id) ||
          !context.inventory.some(
            (i) => i.id === change.id && !(i.status === 'consumed' && change.status !== 'consumed'),
          )
        )
          throw new Error('Invalid inventory change');
        ids.add(change.id);
      }
      if (context.inventory.length > 40) throw new Error('Inventory limit');
      for (const change of result.inventoryChanges)
        Object.assign(context.inventory.find((i) => i.id === change.id)!, change);
      this.inventory = context.inventory;
      this.actionsUsed++;
      this.lastResult = { success: result.success, narrative: result.narrative };
      this.situation = result.situation;
      this.photos = [];
      this.transcript = '';
      this.invalidate();
      record.status = 'complete';
      record.result = result;
      this.pending = null;
      this.status = 'playing';
      if (result.success && this.obstacleIndex === this.scenario.obstacles.length - 1)
        this.end('won');
      else if (this.actionsUsed >= this.scenario.rules.maxActions) this.end('lost');
      else if (result.success) {
        this.obstacleIndex++;
        this.situation = this.scenario.obstacles[this.obstacleIndex].situation;
      }
      return result;
    } catch (error) {
      if (record.status !== 'invalid') {
        record.status = 'failed';
        this.error = '判定に失敗しました。行動は消費していません。';
      }
      if (error instanceof GameError) throw error;
      throw new GameError(502, '判定に失敗しました。行動は消費していません。');
    } finally {
      if (this.pending === actionId) this.pending = null;
      if (generation === this.generation) {
        if (!this.terminal) this.status = 'playing';
        this.clock.resume('judgment');
      }
    }
  }
}
