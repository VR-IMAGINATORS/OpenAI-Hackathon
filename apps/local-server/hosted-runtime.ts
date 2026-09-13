import type { ScenarioSnapshot } from '../server/scenario-catalog.js';
import { createHash, randomUUID } from 'node:crypto';
import { ConversationLedger } from './conversation.js';
import { IntentCoordinator } from './intent-coordinator.js';
import { LiveOutbox } from './live-outbox.js';
import { classifyCoreIntent } from './core-intent-ai.js';
import { GameSession, GameError } from './game.js';
import { createGameAI } from './game-ai.js';
import { decodePhotos } from './photo.js';
import { liveInstructions, openingCommand, factCommand, liveEventSchema } from './live.js';
import type { Scenario } from '../../packages/shared/scenario.js';
import type { LiveCommand } from '../../packages/shared/game.js';
import type { AiService } from '../../packages/server/ai-service.js';
import type { PhotoQueue } from '../server/photo-queue.js';

type Cached<T> = { digest: string; epoch: number; promise: Promise<T> };
export class GameRuntime {
  readonly game: GameSession;
  private ledger?: ConversationLedger;
  private intents?: IntentCoordinator;
  private outbox?: LiveOutbox;
  private notificationFailed = false;
  private epoch = 1;
  private openingIssued = false;
  private seen = new Set<string>();
  private transcriptTimer?: ReturnType<typeof setTimeout>;
  private liveRequests = new Map<
    string,
    Cached<{ sdp: string; generation: number; opening: LiveCommand | null }>
  >();
  private photoRequests = new Map<string, Cached<void>>();
  private liveCreating = false;
  private disposed = false;
  closingAt = Infinity;

  constructor(
    readonly id: string,
    readonly deadline: number,
    scenario: Scenario,
    private ai: AiService,
    private models: { liveModel: string; responseModel: string },
    private queue: PhotoQueue,
    private now = () => performance.now(),
    readonly coreSnapshot?: ScenarioSnapshot,
  ) {
    ai.register(id, deadline);
    this.game = new GameSession(
      scenario,
      createGameAI(
        { respond: (body) => ai.respond(id, body) },
        () => models.responseModel,
        coreSnapshot,
      ),
      now,
      () => {
        clearTimeout(this.transcriptTimer);
        this.seen.clear();
        this.intents?.stop();
        this.closingAt = Math.min(
          deadline,
          now() + (['won', 'lost'].includes(this.game.status) ? 12_000 : 0),
        );
      },
      coreSnapshot,
    );
    if (coreSnapshot) {
      this.game.controllerEpoch = this.epoch;
      this.ledger = new ConversationLedger({ generation: this.game.generation, now });
      this.outbox = new LiveOutbox(this.game.generation, this.epoch);
      this.syncCore();
      this.intents = new IntentCoordinator({
        ledger: this.ledger,
        now,
        classify: async (context) => {
          if (this.game.state().busy || this.notificationFailed)
            return { kind: 'wait', reason: '処理中です。完了してからもう一度話してください。' };
          return classifyCoreIntent({
            respond: (body) => ai.respond(id, body),
            model: models.responseModel,
            snapshot: coreSnapshot,
            conversation: context,
            game: {
              status: this.game.status,
              situation: this.game.situation,
              obstacle: coreSnapshot.scenarioV2.obstacles[this.game.obstacleIndex],
              facts: this.game.facts,
              inventory: this.game.inventory,
              proposal: this.game.proposal,
              photos: this.game.photos.map((p) => ({ id: p.id })),
            },
            photos: this.game.photos,
          });
        },
        execute: async (intent, context, delegation) => {
          this.check();
          this.game.currentContextVersion = this.ledger!.captureUnconsumedContext().contextVersion;
          const ticket = this.game.reserveAction(
            intent,
            context.contextVersion,
            context.gameVersion,
            context.actionEpoch,
            context.controllerEpoch,
          );
          this.enqueue({
            ...factCommand('わかった、それでやってみる！', delegation.id),
            type: 'session.commentary.append',
          });
          const result = await this.game.judgeAction(ticket);
          if (this.disposed || context.controllerEpoch !== this.epoch) return;
          this.syncCore();
          const messageId = randomUUID();
          this.enqueue(
            factCommand(
              '確定結果: ' + result.narrative + ' 現在の状況: ' + this.game.situation,
              delegation.id,
            ),
          );
          this.enqueue(
            { ...factCommand(result.narrative, delegation.id), type: 'session.commentary.append' },
            messageId,
          );
        },
        onDecision: (decision, delegation) => {
          if (decision.kind !== 'execute')
            this.enqueue(factCommand(decision.reason, delegation.id));
        },
        onError: () => {
          if (this.valid()) {
            this.game.error =
              '処理できませんでした。行動は消費していません。指示をもう一度話してください。';
            this.enqueue(factCommand(this.game.error));
          }
          this.syncCore();
        },
      });
    }
  }
  private syncCore(changed = false) {
    if (!this.ledger) return;
    this.game.controllerEpoch = this.epoch;
    this.ledger.updateState({
      generation: this.game.generation,
      gameVersion: this.game.gameVersion,
      actionEpoch: this.game.actionEpoch,
      controllerEpoch: this.epoch,
      judging: this.game.status === 'judging',
    });
    if (changed) this.ledger.contextChanged();
    this.game.currentContextVersion = this.ledger.captureUnconsumedContext().contextVersion;
  }
  private enqueue(command: LiveCommand, messageId: string | null = null) {
    try {
      this.outbox?.append(command, messageId);
    } catch {
      this.notificationFailed = true;
      this.game.error = '音声通知の上限です。画面で結果を確認してください。';
    }
  }
  state() {
    return {
      ...this.game.state(),
      ...(this.coreSnapshot
        ? {
            automaticActions: true,
            transcript:
              this.ledger
                ?.captureUnconsumedContext()
                .fragments.filter((f) => f.speaker === 'user')
                .map((f) => f.delta)
                .join('')
                .slice(-8000) ?? '',
          }
        : {}),
    };
  }
  pollCommands(generation: number, ackThrough: number) {
    this.game.check();
    if (
      !this.outbox ||
      this.disposed ||
      this.now() >= this.deadline ||
      (this.game.terminal && this.now() >= this.closingAt)
    )
      throw new GameError(410, '音声通知は終了しました。');
    return this.outbox.poll(generation, this.epoch, ackThrough);
  }
  private valid(epoch = this.epoch) {
    return (
      !this.disposed && !this.game.terminal && epoch === this.epoch && this.now() < this.deadline
    );
  }
  private check(epoch = this.epoch) {
    this.game.check();
    if (!this.valid(epoch)) throw new GameError(410, 'プレイまたは操作権が失効しました。');
  }
  async transferControl() {
    this.epoch++;
    this.game.changeController();
    this.syncCore();
    this.intents?.reset();
    this.outbox?.reset(this.game.generation, this.epoch);
    clearTimeout(this.transcriptTimer);
    this.seen.clear();
    this.liveRequests.clear();
    this.game.heartbeat('disconnected');
    return this.ai.closeLive(this.id);
  }
  live(requestId: string, sdp: string) {
    this.check();
    const digest = createHash('sha256').update(sdp).digest('hex');
    const previous = this.liveRequests.get(requestId);
    if (previous) {
      if (previous.digest !== digest || previous.epoch !== this.epoch)
        throw new GameError(409, '接続要求が変更されています。');
      return previous.promise;
    }
    if (this.liveCreating) throw new GameError(409, '音声接続を処理中です。');
    if (this.liveRequests.size >= 3) throw new GameError(429, '音声接続の試行上限です。');
    this.liveCreating = true;
    const epoch = this.epoch;
    const promise = (async () => {
      try {
        if (!(await this.ai.closeLive(this.id)))
          throw new GameError(502, '前の音声の終了を確認できません。');
        this.check(epoch);
        const answer = await this.ai.createLive(this.id, {
          session: {
            model: this.models.liveModel,
            instructions: liveInstructions(this.game.state(), this.coreSnapshot),
            delegation: { type: 'client' },
            store: false,
          },
          transport: { type: 'webrtc', sdp },
        });
        if (!this.valid(epoch)) {
          await this.ai.closeLive(this.id);
          throw new GameError(410, '接続中にプレイが失効しました。');
        }
        this.game.generation++;
        this.syncCore();
        this.intents?.reset();
        this.outbox?.reset(this.game.generation, this.epoch);
        this.notificationFailed = false;
        this.seen.clear();
        this.game.heartbeat('connecting');
        const opening = this.openingIssued ? null : openingCommand(this.game.state());
        this.openingIssued = true;
        return { sdp: answer.transport.sdp, generation: this.game.generation, opening };
      } finally {
        this.liveCreating = false;
      }
    })();
    this.liveRequests.set(requestId, { digest, epoch, promise });
    return promise;
  }
  photos(requestId: string, images: string[], signal?: AbortSignal) {
    this.check();
    const digest = createHash('sha256').update(JSON.stringify(images)).digest('hex');
    const prior = this.photoRequests.get(requestId);
    if (prior) {
      if (prior.digest !== digest || prior.epoch !== this.epoch)
        throw new GameError(409, '写真の再送内容が変更されています。');
      return prior.promise;
    }
    if (this.photoRequests.size >= 100) throw new GameError(429, '写真送信の試行上限です。');
    const ticket = this.game.beginPhotos();
    this.syncCore(true);
    const epoch = this.epoch;
    const promise = (async () => {
      try {
        const photos = await this.queue.run(
          () => decodePhotos(images, this.game.scenario.rules.maxPhotosPerAction),
          () => this.valid(epoch),
          signal,
        );
        this.check(epoch);
        await this.game.finishPhotos(photos, ticket);
        this.check(epoch);
        this.syncCore(true);
        this.intents?.onContextChanged();
        if (this.coreSnapshot && this.game.proposal && photos.length) {
          this.enqueue(
            factCommand('写真の認識: ' + this.game.proposal.items.map((i) => i.name).join('、')),
          );
          this.enqueue({
            ...factCommand('写真が届いたよ。これをどう使う？'),
            type: 'session.commentary.append',
          });
        }
      } catch (error) {
        if (epoch === this.epoch) this.game.cancelPhotos();
        if (error instanceof GameError) throw error;
        throw new GameError(
          422,
          '写真を読み取れませんでした。JPEG/PNG/WebP、1枚2MiB以内で撮り直してください。',
        );
      }
    })();
    this.photoRequests.set(requestId, { digest, epoch, promise });
    return promise;
  }
  async event(generation: number, raw: unknown): Promise<LiveCommand[]> {
    if (this.coreSnapshot) {
      this.game.check();
      if (
        this.disposed ||
        this.now() >= this.deadline ||
        (this.game.terminal && this.now() >= this.closingAt)
      )
        throw new GameError(410, '音声受付は終了しました。');
      if (generation !== this.game.generation) throw new GameError(409, '古い音声接続です。');
      const event = liveEventSchema.parse(raw);
      this.syncCore();
      if (event.type === 'session.delegation.created') {
        if (!this.game.terminal)
          this.intents!.acceptDelegation({
            id: event.delegation.id,
            generation,
            offsetMs: event.offset_ms,
          });
      } else {
        this.ledger!.append({
          eventId: event.event_id,
          generation,
          speaker: event.type === 'session.input_transcript.delta' ? 'user' : 'assistant',
          delta: event.delta,
          startMs: event.start_ms,
          endMs: event.end_ms,
        });
        this.syncCore();
        if (!this.game.terminal) this.intents!.onContextChanged();
      }
      return [];
    }
    this.check();
    if (generation !== this.game.generation) throw new GameError(409, '古い音声接続です。');
    const event = liveEventSchema.parse(raw);
    if (this.seen.has(event.event_id)) return [];
    if (this.seen.size >= 10000) throw new GameError(429, '音声イベント上限です。');
    this.seen.add(event.event_id);
    const epoch = this.epoch;
    if (event.type === 'session.input_transcript.delta') {
      this.game.appendTranscript(event.delta);
      clearTimeout(this.transcriptTimer);
      this.transcriptTimer = setTimeout(() => {
        if (this.valid(epoch)) void this.game.recognize().catch(() => {});
      }, 800);
      this.transcriptTimer.unref();
    }
    if (event.type === 'session.delegation.created') {
      clearTimeout(this.transcriptTimer);
      await this.game.recognize();
      this.check(epoch);
      return [
        factCommand(
          this.game.proposal
            ? JSON.stringify(this.game.proposal)
            : '道具と使い方を確認中。実行はまだ確定していません。',
          event.delegation.id,
        ),
      ];
    }
    return [];
  }
  start(): LiveCommand[] {
    this.check();
    const wasBriefing = this.game.status === 'briefing';
    if (wasBriefing && this.ledger) {
      const evidence = this.ledger.captureUnconsumedContext().eligibleEvidenceSeq;
      if (evidence.length) this.ledger.consume(evidence);
    }
    this.game.start();
    this.syncCore(true);
    return wasBriefing
      ? [
          factCommand(
            '導入チュートリアルは終了。本編を開始し、制限時間が進んでいます。現在の障害について相談を続けてください。',
          ),
        ]
      : [];
  }
  async action(actionId: string, revision: number): Promise<LiveCommand[]> {
    if (this.coreSnapshot) throw new GameError(410, '音声で使い方を指示してください。');
    const epoch = this.epoch;
    const result = await this.game.commit(actionId, revision);
    if (this.disposed || epoch !== this.epoch) throw new GameError(410, '操作権が失効しました。');
    return [
      factCommand(
        '確定した行動結果: ' + result.narrative + ' 現在の状況: ' + this.game.state().situation,
      ),
      {
        ...factCommand(
          '結果を短く伝えてください: ' +
            result.narrative +
            ' 現在の状況: ' +
            this.game.state().situation,
        ),
        type: 'session.commentary.append',
      },
    ];
  }
  expire() {
    this.game.end();
  }
  async close() {
    const confirmed = await this.ai.retire(this.id);
    if (confirmed) this.ai.forget(this.id);
    return confirmed;
  }
  dispose() {
    this.disposed = true;
    this.intents?.stop();
    this.ledger?.stop();
    clearTimeout(this.transcriptTimer);
    this.game.end();
    this.seen.clear();
    this.liveRequests.clear();
    this.photoRequests.clear();
  }
}
