import { randomUUID } from 'node:crypto';
import {
  executeIntentSchema,
  actionResultSchema,
  type ActionTicket,
  type ExecuteIntent,
  type ActionResult,
  type GameFacts,
} from '../../packages/shared/conversation.js';
import type { ScenarioSnapshot } from '../server/scenario-catalog.js';
import { parseCoreJudgment, projectPublicJudgment, type CoreJudgment } from './game-ai.js';
import {
  CreativeAttemptLedger,
  creativeSuccessNarrative,
  normalizeIdea,
} from './creative-acceptance.js';
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
import type { GameEndReason } from '../../packages/shared/ending.js';
import { endingOutcome, type CommittedEndingAction } from './ending.js';
import { GameCredits } from './credits.js';
import { creditCosts, type CreditKind } from '../../packages/shared/credits.js';
export class GameError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
export class GameSession {
  readonly id = randomUUID();
  generation = 0;
  gameVersion = 0;
  actionEpoch = 0;
  controllerEpoch = 0;
  currentContextVersion = 0;
  facts: GameFacts;
  private reservedEvidence = new Set<number>();
  private readonly creativeAttempts?: CreativeAttemptLedger;
  private coreActions = new Map<
    string,
    {
      ticket: ActionTicket;
      context: AIContext;
      proposal: Proposal;
      running: boolean;
      attempts: number;
      controller: AbortController;
      controls: Map<string, ReturnType<typeof setTimeout>>;
      controlWaiters: Set<() => void>;
      result?: ActionResult;
    }
  >();
  status: PublicGameState['status'] = 'briefing';
  obstacleIndex = 0;
  actionsUsed = 0;
  readonly credits: GameCredits;
  readonly clearedIds: string[] = [];
  readonly committedActions: CommittedEndingAction[] = [];
  endReason: GameEndReason | null = null;
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
    readonly coreSnapshot?: ScenarioSnapshot,
    creativeRandom?: () => number,
  ) {
    if (coreSnapshot?.coreConfig.creativity?.enabled)
      this.creativeAttempts = new CreativeAttemptLedger(
        coreSnapshot.coreConfig.creativity.successProbability,
        creativeRandom,
      );
    this.credits = new GameCredits(scenario.rules.initialCredits);
    this.situation = scenario.obstacles[0].situation;
    if (coreSnapshot) this.generation = 1;
    this.facts = {
      obstacleId: scenario.obstacles[0].id,
      values: Object.fromEntries(
        (coreSnapshot?.scenarioV2.core.facts ?? []).map((f) => [f.key, f.initial]),
      ),
    };
    this.clock = new GameClock(scenario.rules.totalTimeSeconds, now);
  }
  get terminal() {
    return ['won', 'lost', 'expired'].includes(this.status);
  }
  check() {
    this.clock.tick();
    if (!this.terminal && this.status !== 'briefing') {
      if (this.clock.waitingRemainingMs <= 0) this.end('expired');
      else if (this.clock.remainingMs <= 0) this.end('lost', 'time_limit');
    }
    this.checkCredits();
  }
  state(): PublicGameState {
    this.check();
    return structuredClone({
      id: this.id,
      ...(this.coreSnapshot?.difficulty ? { difficulty: this.coreSnapshot.difficulty } : {}),
      generation: this.generation,
      status: this.status,
      endingOutcome: endingOutcome(this.status, this.clearedIds),
      endReason: this.endReason,
      clearedCount: this.clearedIds.length,
      title: this.scenario.title,
      briefing: this.scenario.playerBriefing,
      obstacle: {
        title: this.scenario.obstacles[this.obstacleIndex].title,
        index: this.obstacleIndex,
        count: this.scenario.obstacles.length,
      },
      situation: this.situation,
      creditsRemaining: this.credits.remaining,
      initialCredits: this.credits.initial,
      lastCreditCharge: this.credits.lastCharge,
      actionsUsed: this.actionsUsed,
      remainingMs: this.clock.remainingMs,
      waitingRemainingMs: this.clock.waitingRemainingMs,
      paused: this.clock.paused,
      maxPhotos: this.scenario.rules.maxPhotosPerSend,
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
  end(status: 'won' | 'lost' | 'expired' = 'expired', reason?: GameEndReason) {
    if (this.terminal) return;
    this.status = status;
    this.endReason =
      status === 'expired'
        ? 'interrupted'
        : status === 'won'
          ? 'escaped'
          : (reason ?? 'time_limit');
    if (!this.coreSnapshot) this.generation++;
    this.invalidateCoreActions();
    for (const action of this.actions.values())
      if (action.status === 'pending') action.status = 'invalid';
    this.pending = null;
    this.photos = [];
    this.transcript = '';
    this.proposal = null;
    this.creativeAttempts?.clear();
    this.clock.stop();
    this.onEnd();
  }
  private editable() {
    this.check();
    if (this.terminal) throw new GameError(410, 'プレイは終了しています。');
    if (this.pending) throw new GameError(409, '判定中です。');
  }
  reserveCredits(id: string, kind: CreditKind, amount: number) {
    this.check();
    if (this.terminal) throw new GameError(410, 'プレイは終了しています。');
    if (!this.credits.reserve(id, kind, amount))
      throw new GameError(
        409,
        this.coreSnapshot?.locale === 'en' ? 'Not enough credits.' : 'クレジットが不足しています。',
        'INSUFFICIENT_CREDITS',
      );
  }
  settleCredits(id: string) {
    this.credits.settle(id);
    this.checkCredits();
  }
  checkCredits() {
    if (
      !this.terminal &&
      this.status === 'playing' &&
      !this.credits.pending &&
      this.credits.remaining === 0 &&
      !this.pending &&
      !this.recognizing &&
      !this.photoBusy
    )
      this.end('lost', 'credits_exhausted');
  }
  invalidate() {
    this.inputRevision++;
    this.proposal = null;
    this.error = null;
  }
  /** Invalidate work from the previous tab without restarting the game. */
  changeController() {
    this.credits.cancelPending();
    this.generation++;
    this.controllerEpoch++;
    this.invalidateCoreActions();
    for (const action of this.actions.values()) {
      if (action.status === 'pending') action.status = 'invalid';
    }
    this.pending = null;
    this.photoBusy = false;
    if (this.status === 'judging') this.status = 'playing';
    this.clock.resume('judgment');
    this.invalidate();
  }
  beginPhotos(count: number | boolean = 1) {
    this.editable();
    if (this.photoBusy || this.recognizing) throw new GameError(409, '写真を処理中です。');
    if (Number(count) * creditCosts.photo > this.credits.remaining)
      throw new GameError(
        409,
        this.coreSnapshot?.locale === 'en'
          ? 'Not enough credits for this photo.'
          : '写真を送るクレジットが不足しています。',
        'INSUFFICIENT_CREDITS',
      );
    this.photoBusy = true;
    this.invalidate();
    return { generation: this.generation, revision: this.inputRevision, creditId: randomUUID() };
  }
  async finishPhotos(
    photos: GamePhoto[],
    ticket: { generation: number; revision: number; creditId: string },
    deferCredits = false,
  ) {
    if (this.terminal || ticket.generation !== this.generation)
      throw new GameError(410, 'プレイが失効しました。');
    if (!this.photoBusy) throw new GameError(409, '写真の送信はすでに処理済みです。');
    if (photos.length > this.scenario.rules.maxPhotosPerSend)
      throw new GameError(400, '写真の枚数が上限を超えています。');
    if (photos.length)
      this.reserveCredits(ticket.creditId, 'photo', photos.length * creditCosts.photo);
    this.photoBusy = false;
    this.photos = photos;
    this.invalidate();
    try {
      await this.recognize(true);
      if (!this.proposal || ticket.generation !== this.generation)
        this.credits.cancel(ticket.creditId);
      else if (!deferCredits) this.settleCredits(ticket.creditId);
    } catch (error) {
      this.credits.cancel(ticket.creditId);
      throw error;
    }
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
      facts: structuredClone(this.facts),
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
  private invalidateCoreActions() {
    this.actionEpoch++;
    for (const { ticket, context, controller } of this.coreActions.values()) {
      if (ticket.status === 'pending') {
        ticket.status = 'invalid';
        controller.abort();
      }
      context.photos = [];
      context.creativity = undefined;
    }
    for (const record of this.coreActions.values()) this.releaseActionControls(record);
  }

  get pendingActionId(): string | null {
    return this.pending;
  }

  /** Register received speech before asynchronous classification can race the commit. */
  holdPendingAction(actionId: string, controlId: string): boolean {
    const record = this.coreActions.get(actionId);
    if (!record || record.ticket.status !== 'pending' || this.pending !== actionId) return false;
    if (record.controls.has(controlId)) return true;
    if (!controlId || controlId.length > 200 || record.controls.size >= 100) {
      this.cancelPendingAction(actionId);
      return false;
    }
    const timeout = setTimeout(() => this.cancelPendingAction(actionId), 5_000);
    timeout.unref();
    record.controls.set(controlId, timeout);
    return true;
  }

  resolvePendingActionControl(
    actionId: string,
    controlId: string,
    decision: 'keep' | 'cancel',
  ): boolean {
    const record = this.coreActions.get(actionId);
    if (!record || record.ticket.status !== 'pending' || !record.controls.has(controlId))
      return false;
    if (decision === 'cancel') return this.cancelPendingAction(actionId);
    clearTimeout(record.controls.get(controlId)!);
    record.controls.delete(controlId);
    if (!record.controls.size) this.releaseActionControls(record);
    return true;
  }

  /** Cancellation is final for this ticket; a replacement must reserve a new one. */
  cancelPendingAction(actionId: string): boolean {
    const record = this.coreActions.get(actionId);
    if (!record || record.ticket.status !== 'pending' || this.pending !== actionId) return false;
    record.ticket.status = 'invalid';
    record.controller.abort();
    this.actionEpoch++;
    record.context.photos = [];
    this.releaseActionControls(record);
    this.pending = null;
    if (!this.terminal) this.status = 'playing';
    this.clock.resume('judgment');
    return true;
  }

  private releaseActionControls(record: {
    controls: Map<string, ReturnType<typeof setTimeout>>;
    controlWaiters: Set<() => void>;
  }) {
    for (const timer of record.controls.values()) clearTimeout(timer);
    record.controls.clear();
    for (const resolve of record.controlWaiters) resolve();
    record.controlWaiters.clear();
  }

  private recordCommittedAction(
    actionId: string,
    context: AIContext,
    proposal: Proposal,
    result: { success: boolean; narrative: string },
    beforeInventory = context.inventory,
  ) {
    const obstacleId = this.scenario.obstacles[context.obstacleIndex].id;
    const cleared = result.success && !this.clearedIds.includes(obstacleId);
    if (cleared) this.clearedIds.push(obstacleId);
    this.committedActions.push({
      actionId,
      order: this.actionsUsed,
      obstacleId,
      usage: proposal.usage,
      items: proposal.items.map((item) => {
        const before = beforeInventory.find((entry) => entry.id === item.inventoryId)!;
        const after = this.inventory.find((entry) => entry.id === item.inventoryId)!;
        return {
          id: before.id,
          name: before.name,
          beforeStatus: before.status,
          afterStatus: after.status,
        };
      }),
      beforeVersion: this.gameVersion - 1,
      afterVersion: this.gameVersion,
      beforeFacts: structuredClone(context.facts!),
      afterFacts: structuredClone(this.facts),
      success: result.success,
      narrative: result.narrative,
      cleared,
    });
  }

  /** Reserves a fixed instruction synchronously, before any paid judgment begins. */
  reserveAction(
    value: ExecuteIntent,
    expectedContextVersion: number,
    expectedGameVersion: number,
    actionEpoch: number,
    controllerEpoch: number,
  ): ActionTicket {
    this.editable();
    if (!this.coreSnapshot) throw new GameError(409, 'CORE_REQUIRED');
    const intent = executeIntentSchema.parse(value);
    if (
      this.status !== 'playing' ||
      this.voiceState !== 'connected' ||
      this.photoBusy ||
      this.recognizing ||
      expectedContextVersion !== this.currentContextVersion ||
      expectedGameVersion !== this.gameVersion ||
      actionEpoch !== this.actionEpoch ||
      controllerEpoch !== this.controllerEpoch
    ) {
      throw new GameError(409, 'ACTION_CONTEXT_STALE');
    }
    if (intent.mode === 'environment') {
      const currentId = this.coreSnapshot.scenarioV2.obstacles[this.obstacleIndex]!.id;
      const available = new Set(
        this.coreSnapshot.scenarioV2.observationTargets
          .filter((target) => target.id === currentId)
          .map((target) => target.id),
      );
      if (intent.environmentTargetIds!.some((id) => !available.has(id)))
        throw new GameError(409, 'ENVIRONMENT_TARGET_UNAVAILABLE');
    }
    if (intent.origin?.kind === 'photo') {
      const origin = intent.origin;
      const receivedIds = new Set(this.photos.map((photo) => photo.id));
      if (
        origin.photoVersion !== this.inputRevision ||
        origin.photoIds.length !== receivedIds.size ||
        new Set(origin.photoIds).size !== origin.photoIds.length ||
        !origin.photoIds.every((id) => receivedIds.has(id)) ||
        !origin.photoIds.every((id) => this.proposal?.items.some((item) => item.photoId === id))
      )
        throw new GameError(409, 'PHOTO_ORIGIN_STALE');
    }
    if (intent.evidenceSeq.some((seq) => this.reservedEvidence.has(seq)))
      throw new GameError(409, 'EVIDENCE_ALREADY_RESERVED');
    if (this.coreActions.size >= 100) throw new GameError(429, 'ACTION_LIMIT');
    const items = intent.itemRefs.map((ref) => {
      if ('photoId' in ref) {
        const recognized = this.proposal?.items.find((item) => item.photoId === ref.photoId);
        if (!this.photos.some((photo) => photo.id === ref.photoId) || !recognized)
          throw new GameError(409, 'PHOTO_NOT_RECOGNIZED');
        return structuredClone(recognized);
      }
      const item = this.inventory.find(
        (item) => item.id === ref.inventoryId && item.status !== 'consumed',
      );
      if (!item) throw new GameError(409, 'ITEM_UNAVAILABLE');
      return { photoId: null, inventoryId: item.id, name: item.name };
    });
    const context = this.context();
    const proposal: Proposal = {
      ...(intent.mode ? { mode: intent.mode } : {}),
      ...(intent.environmentTargetIds
        ? { environmentTargetIds: [...intent.environmentTargetIds] }
        : {}),
      items,
      usage: intent.usage,
      summary: intent.reason,
      revision: this.revision,
      inputRevision: this.inputRevision,
    };
    // Materialization stays private until the judgment is fully validated.
    for (const item of proposal.items) {
      if (item.photoId) {
        const id = randomUUID();
        context.inventory.push({
          id,
          name: item.name,
          description: item.name,
          status: 'available',
        });
        item.photoId = null;
        item.inventoryId = id;
      }
    }
    if (context.inventory.length > 40) throw new GameError(409, 'INVENTORY_LIMIT');
    if (this.creativeAttempts)
      context.creativity = {
        previousAttempts: this.creativeAttempts.candidates(
          this.creativeIdentity(context, proposal).scope,
        ),
      };
    const ticket: ActionTicket = {
      id: randomUUID(),
      playId: this.id,
      generation: this.generation,
      actionEpoch,
      controllerEpoch,
      gameVersion: this.gameVersion,
      contextVersion: expectedContextVersion,
      evidenceSeq: [...intent.evidenceSeq],
      intent,
      status: 'pending',
    };
    this.coreActions.set(ticket.id, {
      ticket,
      context,
      proposal,
      running: false,
      attempts: 0,
      controller: new AbortController(),
      controls: new Map(),
      controlWaiters: new Set(),
    });
    intent.evidenceSeq.forEach((seq) => this.reservedEvidence.add(seq));
    this.pending = ticket.id;
    this.status = 'judging';
    this.clock.pause('judgment');
    return structuredClone(ticket);
  }

  /** The caller's ticket is an identifier, never the authority for state or AI input. */
  async judgeAction(value: ActionTicket): Promise<ActionResult> {
    const record = this.coreActions.get(value.id);
    if (
      !record ||
      JSON.stringify({ ...value, status: 'pending' }) !==
        JSON.stringify({ ...record.ticket, status: 'pending' })
    )
      throw new GameError(409, 'INVALID_TICKET');
    const { ticket, context, proposal } = record;
    if (record.result) return structuredClone(record.result);
    this.check();
    if (ticket.status === 'failed') throw new GameError(502, 'ACTION_FAILED');
    if (
      ticket.status !== 'pending' ||
      this.terminal ||
      ticket.generation !== this.generation ||
      ticket.actionEpoch !== this.actionEpoch ||
      ticket.controllerEpoch !== this.controllerEpoch ||
      ticket.gameVersion !== this.gameVersion ||
      this.pending !== ticket.id
    )
      throw new GameError(410, 'ACTION_INVALID');
    if (record.running) throw new GameError(409, 'ACTION_PENDING');
    record.running = true;
    try {
      let judgment: CoreJudgment;
      for (;;) {
        this.assertPendingAction(ticket);
        record.attempts++;
        try {
          judgment = parseCoreJudgment(
            await this.ai.judge(
              {
                ...structuredClone(context),
                photos: context.photos.map((photo) => ({
                  id: photo.id,
                  jpeg: Buffer.from(photo.jpeg),
                })),
              },
              structuredClone(proposal),
              record.controller.signal,
            ),
          );
          break;
        } catch (error) {
          // Retry only a known upstream transport failure. Model/schema errors,
          // admission limits and game failures are not transient transport failures.
          const upstream = error as { code?: string; status?: number } | null;
          if (
            record.attempts >= 2 ||
            upstream?.code !== 'UPSTREAM_FAILED' ||
            !(upstream.status! >= 500)
          )
            throw error;
          this.assertPendingAction(ticket);
        }
      }
      while (record.controls.size && ticket.status === 'pending') {
        await new Promise<void>((resolve) => record.controlWaiters.add(resolve));
      }
      return this.commitActionResult(ticket, judgment);
    } catch (error) {
      if (record.ticket.status === 'invalid') throw new GameError(410, 'ACTION_INVALID');
      if (ticket.status === 'pending') {
        ticket.status = 'failed';
        this.error =
          this.coreSnapshot?.locale === 'en'
            ? 'I could not confirm that. Please try asking again.'
            : 'うまく確認できなかった。もう一度お願いできる？';
      }
      if (error instanceof GameError) throw error;
      throw new GameError(502, 'ACTION_FAILED');
    } finally {
      context.photos = [];
      this.releaseActionControls(record);
      if (this.pending === ticket.id) {
        this.pending = null;
        if (!this.terminal) this.status = 'playing';
        this.clock.resume('judgment');
      }
    }
  }

  private assertPendingAction(ticket: ActionTicket): void {
    this.check();
    if (
      ticket.status !== 'pending' ||
      this.terminal ||
      ticket.generation !== this.generation ||
      ticket.actionEpoch !== this.actionEpoch ||
      ticket.controllerEpoch !== this.controllerEpoch ||
      ticket.gameVersion !== this.gameVersion ||
      this.pending !== ticket.id
    )
      throw new GameError(410, 'ACTION_INVALID');
  }

  private commitActionResult(ticket: ActionTicket, judgment: CoreJudgment): ActionResult {
    this.assertPendingAction(ticket);
    const record = this.coreActions.get(ticket.id)!;
    if (record.controls.size) throw new GameError(409, 'ACTION_CONTROL_PENDING');
    const { context, proposal } = record;
    // Validate the hypothetical candidate before drawing or changing any state.
    // Failed/stale/cancelled requests never consume a draw.
    let { facts, inventory } = this.validateCoreJudgment(context, judgment);
    if (this.creativeAttempts && judgment.creativity) {
      if (judgment.creativity.kind === 'stretch' && !judgment.success)
        throw new Error('INVALID_STRETCH_CANDIDATE');
      const identity = this.creativeIdentity(context, proposal);
      const decision = this.creativeAttempts.resolve(
        identity.scope,
        identity.fingerprint,
        judgment.creativity,
      );
      if (
        !decision.allowed ||
        judgment.creativity.kind === 'invalid' ||
        // An earlier ordinary attempt grants no license for a later hypothetical stretch.
        (decision.kind === 'ordinary' && judgment.creativity.kind === 'stretch')
      ) {
        judgment = projectPublicJudgment(this.coreSnapshot!, context, {
          ...judgment,
          success: false,
          factChanges: [],
          inventoryChanges: [],
        });
        ({ facts, inventory } = this.validateCoreJudgment(context, judgment));
      } else if (decision.kind === 'stretch') {
        if (!judgment.success) throw new Error('INVALID_STRETCH_CANDIDATE');
        const description = creativeSuccessNarrative(
          this.coreSnapshot!.locale,
          judgment.creativity!.effect,
          proposal.items.map((item) => item.name),
        );
        judgment = {
          ...judgment,
          narrative: `${description} ${judgment.narrative}`.slice(0, 2000),
        };
      }
    }
    const result = actionResultSchema.parse({
      actionId: ticket.id,
      beforeVersion: this.gameVersion,
      afterVersion: this.gameVersion + 1,
      success: judgment.success,
      factChanges: judgment.factChanges,
      inventoryChanges: judgment.inventoryChanges,
      narrative: judgment.narrative,
      shortReason: judgment.shortReason,
    });
    this.facts = facts;
    this.inventory = inventory;
    this.gameVersion++;
    this.actionsUsed++;
    this.situation = judgment.situation;
    this.lastResult = { success: judgment.success, narrative: judgment.narrative };
    this.photos = [];
    this.transcript = '';
    this.invalidate();
    ticket.status = 'committed';
    record.result = result;
    this.recordCommittedAction(ticket.id, context, proposal, result);
    this.clock.resume('judgment');
    this.pending = null;
    this.status = 'playing';
    if (judgment.success && this.obstacleIndex === this.scenario.obstacles.length - 1)
      this.end('won');
    else if (judgment.success) {
      this.obstacleIndex++;
      this.facts.obstacleId = this.scenario.obstacles[this.obstacleIndex].id;
      this.situation = this.scenario.obstacles[this.obstacleIndex].situation;
    }
    return structuredClone(result);
  }

  private creativeIdentity(context: AIContext, proposal: Proposal) {
    const keys = this.coreSnapshot!.scenarioV2.obstacles[context.obstacleIndex]!.factKeys;
    return {
      // gameVersion, knowledge reveals, new photos and unused inventory do not alter this scope.
      scope: JSON.stringify([
        context.facts!.obstacleId,
        [...keys].sort().map((key) => [key, context.facts!.values[key]]),
      ]),
      fingerprint: JSON.stringify([
        proposal.mode ?? 'tool',
        normalizeIdea(proposal.usage),
        proposal.items
          .map((item) => [
            normalizeIdea(item.name),
            context.inventory.find((entry) => entry.id === item.inventoryId)?.status ?? 'available',
          ])
          .sort(),
      ]),
    };
  }

  private validateCoreJudgment(context: AIContext, judgment: CoreJudgment) {
    const facts = structuredClone(this.facts);
    const obstacle = this.coreSnapshot!.scenarioV2.obstacles[this.obstacleIndex];
    const allowedKeys = obstacle.factKeys;
    const keys = new Set<string>();
    for (const change of judgment.factChanges) {
      const declaration = this.coreSnapshot!.scenarioV2.core.facts.find(
        (f) => f.key === change.key,
      );
      if (
        keys.has(change.key) ||
        !allowedKeys.includes(change.key) ||
        !declaration ||
        facts.values[change.key] !== change.from ||
        !declaration.values.includes(change.to) ||
        !declaration.allowedTransitions.some((t) => t.from === change.from && t.to === change.to)
      )
        throw new Error('INVALID_FACT_CHANGE');
      keys.add(change.key);
      facts.values[change.key] = change.to;
    }
    // A model cannot clear an obstacle by prose alone or silently clear it on a failure.
    // Validate before committing inventory, facts, time or the action counter.
    if (
      obstacle.completionFact &&
      judgment.success !==
        (facts.values[obstacle.completionFact.key] === obstacle.completionFact.value)
    )
      throw new Error('INVALID_COMPLETION_FACT');
    const inventory = structuredClone(context.inventory);
    const ids = new Set<string>();
    for (const change of judgment.inventoryChanges) {
      const item = inventory.find((item) => item.id === change.id);
      if (
        ids.has(change.id) ||
        !item ||
        (item.status === 'consumed' && change.status !== 'consumed')
      )
        throw new Error('INVALID_INVENTORY_CHANGE');
      ids.add(change.id);
      Object.assign(item, change);
    }
    return { facts, inventory };
  }

  async commit(actionId: string, proposalRevision: number) {
    if (this.coreSnapshot) throw new GameError(410, 'LEGACY_ACTION_DISABLED');
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
      const beforeInventory = structuredClone(context.inventory);
      for (const change of result.inventoryChanges)
        Object.assign(context.inventory.find((i) => i.id === change.id)!, change);
      this.inventory = context.inventory;
      this.gameVersion++;
      this.actionsUsed++;
      this.lastResult = { success: result.success, narrative: result.narrative };
      this.situation = result.situation;
      this.photos = [];
      this.transcript = '';
      this.invalidate();
      record.status = 'complete';
      record.result = result;
      this.recordCommittedAction(actionId, context, proposal, result, beforeInventory);
      this.pending = null;
      this.status = 'playing';
      if (result.success && this.obstacleIndex === this.scenario.obstacles.length - 1)
        this.end('won');
      else if (result.success) {
        this.obstacleIndex++;
        this.facts.obstacleId = this.scenario.obstacles[this.obstacleIndex].id;
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
