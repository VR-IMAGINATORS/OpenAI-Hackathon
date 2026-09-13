import type { ScenarioSnapshot } from '../server/scenario-catalog.js';
import { createHash, randomUUID } from 'node:crypto';
import { ConversationLedger } from './conversation.js';
import { IntentCoordinator } from './intent-coordinator.js';
import { LiveOutbox } from './live-outbox.js';
import { classifyCoreIntent } from './core-intent-ai.js';
import { GameSession, GameError } from './game.js';
import { createGameAI } from './game-ai.js';
import { decodePhotos } from './photo.js';
import {
  liveInstructions,
  openingCommand,
  factCommand,
  factCommands,
  liveEventSchema,
} from './live.js';
import type { Scenario } from '../../packages/shared/scenario.js';
import type { LiveCommand } from '../../packages/shared/game.js';
import type { AiService } from '../../packages/server/ai-service.js';
import type { PhotoQueue } from '../server/photo-queue.js';

export interface RuntimePresentation {
  transcript(fragment: import('../../packages/shared/conversation.js').TranscriptFragment): void;
  photos(photos: import('./photo.js').GamePhoto[]): Promise<void>;
  scene(input: {
    messageId: string;
    text: string;
    commandSeq: number | null;
    generation: number;
    facts: import('../../packages/shared/conversation.js').GameFacts;
    situation: string;
  }): void;
  notice?(text: string): void;
  ended(state: import('../../packages/shared/game.js').PublicGameState): void;
}
type Cached<T> = { digest: string; epoch: number; promise: Promise<T> };
export class GameRuntime {
  readonly game: GameSession;
  private ledger?: ConversationLedger;
  private intents?: IntentCoordinator;
  private outbox?: LiveOutbox;
  private notificationFailed = false;
  private traceEntries: {
    actionId: string;
    configDigest: string;
    interpretation: string;
    shortReason: string;
    durationMs: number;
  }[] = [];
  private diagnostics: { at: number; stage: string; code?: string }[] = [];
  private recordDiagnostic(stage: string, code?: string) {
    if (!this.traceEnabled || this.game.terminal) return;
    this.diagnostics.push({ at: this.now(), stage, ...(code ? { code } : {}) });
    if (this.diagnostics.length > 128) this.diagnostics.shift();
  }
  private actionInFlight = false;
  private stateVersion = 0;
  private previousState = '';
  private epoch = 1;
  private openingIssued = false;
  private seen = new Set<string>();
  private maintenanceTimer?: ReturnType<typeof setInterval>;
  private timeWarningSent = false;
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
    private readonly presentation?: RuntimePresentation,
    private readonly traceEnabled = false,
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
        clearInterval(this.maintenanceTimer);
        this.seen.clear();
        this.intents?.stop();
        this.traceEntries = [];
        this.diagnostics = [];
        if (['won', 'lost'].includes(this.game.status) && !this.actionInFlight) {
          this.presentScene(this.game.situation);
        }
        this.presentation?.ended(this.state());
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
          if (this.game.state().busy || this.notificationFailed) {
            this.recordDiagnostic(
              'classification_skipped',
              this.notificationFailed ? 'notification_failed' : 'busy',
            );
            return { kind: 'wait', reason: '処理中です。完了してからもう一度話してください。' };
          }
          this.recordDiagnostic('classification_started');
          const decision = await classifyCoreIntent({
            respond: (body) => ai.respond(id, body),
            model: models.responseModel,
            snapshot: coreSnapshot,
            conversation: context,
            game: {
              publicState: this.publicContext(),
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
          this.recordDiagnostic('classification_returned', decision.kind);
          return decision;
        },
        execute: async (intent, context, delegation) => {
          this.check();
          this.game.currentContextVersion = this.ledger!.captureUnconsumedContext().contextVersion;
          this.recordDiagnostic('action_reserving');
          const ticket = this.game.reserveAction(
            intent,
            context.contextVersion,
            context.gameVersion,
            context.actionEpoch,
            context.controllerEpoch,
          );
          this.enqueue({
            ...factCommand(
              this.words('わかった、それでやってみる！', 'Got it. I’ll try that!'),
              delegation.id,
            ),
            type: 'session.commentary.append',
          });
          this.recordDiagnostic('judgment_started');
          const judgmentStarted = now();
          this.actionInFlight = true;
          let result;
          try {
            result = await this.game.judgeAction(ticket);
            this.recordDiagnostic('judgment_committed');
          } finally {
            this.actionInFlight = false;
          }
          if (this.disposed || context.controllerEpoch !== this.epoch) return;
          this.syncCore();
          if (this.traceEnabled && !this.game.terminal) {
            this.traceEntries.push({
              actionId: ticket.id,
              configDigest: coreSnapshot.digest,
              interpretation: intent.usage.slice(0, 1000),
              shortReason: result.shortReason.slice(0, 1000),
              durationMs: Math.max(0, Math.round(now() - judgmentStarted)),
            });
            while (
              this.traceEntries.length > 128 ||
              Buffer.byteLength(JSON.stringify(this.traceEntries)) > 64 * 1024
            )
              this.traceEntries.shift();
          }
          const messageId = randomUUID();
          this.sendFacts('確定結果: ' + result.narrative, delegation.id);
          this.sendFacts(this.currentSituation(), delegation.id);
          const command = this.speak(result.narrative, delegation.id, messageId);
          if (!this.game.terminal) this.speak(this.currentSituation(), delegation.id);
          this.presentScene(
            result.narrative + '\n' + this.currentSituation(),
            messageId,
            command?.seq ?? null,
          );
        },
        onDecision: (decision, delegation) => {
          this.recordDiagnostic('decision_accepted', decision.kind);
          if (decision.kind === 'consult') {
            this.sendFacts(this.currentSituation(), delegation.id);
            this.speak(decision.answer ?? this.currentSituation(), delegation.id);
          } else if (decision.kind === 'wait') {
            this.sendFacts(
              this.words(
                'まだ行動は予約されていません。未完の指示や訂正を待ってください。',
                'No action is reserved. Wait for the user to finish or correct the request.',
              ),
              delegation.id,
            );
          }
        },
        onExpired: () => this.recoveryNotice('delegation_expired'),
        onMissingDelegation: (decision) => {
          this.recordDiagnostic('delegation_missing', decision.kind);
          if (!this.valid() || this.game.status !== 'playing') return;
          this.sendFacts(this.currentSituation());
          if (decision.kind === 'execute') {
            this.enqueue({
              ...factCommand(
                this.words(
                  '未処理の実行指示があります。行動はまだ予約も実行もされていません。最新の指示と訂正をclientへ委譲してください。確定結果が届くまで成功したと伝えないでください。',
                  'There is an unhandled action request. No action is reserved or executed. Delegate the latest request and corrections to the client. Do not claim success before the confirmed server result.',
                ),
              ),
              type: 'session.instructions.append',
            });
          } else if (decision.kind === 'consult')
            this.speak(decision.answer ?? this.currentSituation());
        },
        onRecoveryExpired: () => this.recoveryNotice('recovery_expired'),
        onError: (error) => {
          const code =
            error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message)
              ? error.message
              : 'PROCESSING_ERROR';
          this.recordDiagnostic('error', code);
          if (this.valid()) {
            this.game.error =
              '処理できませんでした。行動は消費していません。指示をもう一度話してください。';
            this.speak(this.game.error);
          }
          this.syncCore();
        },
      });
      this.maintenanceTimer = setInterval(() => this.tick(), 1000);
      this.maintenanceTimer.unref();
    }
  }
  private publicContext() {
    return {
      status: this.game.status,
      situation: this.game.situation,
      actionsRemaining: this.game.scenario.rules.maxActions - this.game.actionsUsed,
      lastResult: this.game.lastResult,
      recognizedItems: this.game.proposal?.items.map(({ name }) => name) ?? [],
      inventory: this.game.inventory.map(({ name, status }) => ({ name, status })),
    };
  }
  private currentSituation() {
    return this.words('現在の状況: ', 'Current situation: ') + this.game.situation;
  }
  private sendFacts(text: string, delegationId: string | null = null) {
    for (const command of factCommands(text, delegationId)) this.enqueue(command);
  }
  private speak(text: string, delegationId: string | null = null, messageId: string | null = null) {
    let first: ReturnType<GameRuntime['enqueue']>;
    for (const command of factCommands(text, delegationId)) {
      const queued = this.enqueue({ ...command, type: 'session.commentary.append' }, messageId);
      first ??= queued;
    }
    return first;
  }
  private recoveryNotice(stage: string) {
    if (!this.valid() || this.game.status !== 'playing' || this.game.state().busy) return;
    this.recordDiagnostic(stage);
    const text = this.words(
      '指示の処理を完了できませんでした。もう一度、どう使うか教えてください。',
      'I could not finish processing that request. Please tell me how to use it again.',
    );
    this.game.error = text;
    this.speak(text);
    this.presentation?.notice?.(text);
  }
  /** Server-owned maintenance; also callable with the injected clock in tests. */
  tick() {
    if (this.disposed || !this.coreSnapshot) return;
    this.game.check();
    if (!this.valid()) return;
    const state = this.game.state();
    if (
      state.status !== 'playing' ||
      state.voiceState !== 'connected' ||
      state.paused ||
      state.busy
    )
      return;
    this.intents?.tick();
    const warning = this.coreSnapshot.coreConfig.timeWarning;
    if (
      !warning?.enabled ||
      this.timeWarningSent ||
      state.remainingMs >= warning.thresholdSeconds * 1000
    )
      return;
    this.timeWarningSent = true;
    const locale = this.coreSnapshot.locale;
    const text = warning.message[locale].replaceAll(
      '{thresholdSeconds}',
      String(warning.thresholdSeconds),
    );
    for (const command of factCommands(warning.deliveryInstructions[locale]))
      this.enqueue({ ...command, type: 'session.instructions.append' });
    this.speak(text);
    this.presentation?.notice?.(text);
    this.recordDiagnostic('time_warning');
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
      return this.outbox?.append(command, messageId);
    } catch {
      this.notificationFailed = true;
      this.game.error = '音声通知の上限です。画面で結果を確認してください。';
    }
  }
  trace() {
    if (this.game.terminal || !this.traceEnabled) return { entries: [] };
    const context = this.ledger?.captureUnconsumedContext();
    return {
      entries: structuredClone(this.traceEntries),
      diagnostics: structuredClone(this.diagnostics),
      status: this.game.status,
      voiceState: this.game.voiceState,
      busy: this.game.state().busy,
      photoCount: this.game.photos.length,
      recognizedItemCount: this.game.proposal?.items.length ?? 0,
      eligibleEvidenceCount: context?.eligibleEvidenceSeq.length ?? 0,
      userFragmentCount: context?.fragments.filter((f) => f.speaker === 'user').length ?? 0,
      delegations: this.intents?.snapshot() ?? [],
    };
  }
  private words(ja: string, en: string) {
    return this.coreSnapshot?.locale === 'en' ? en : ja;
  }
  private presentScene(text: string, messageId = randomUUID(), commandSeq: number | null = null) {
    this.presentation?.scene({
      messageId,
      text,
      commandSeq,
      generation: this.game.generation,
      facts: structuredClone(this.game.facts),
      situation: this.game.situation,
    });
  }
  state() {
    const state = {
      ...this.game.state(),
      ...(this.coreSnapshot
        ? {
            automaticActions: true,
            ...(this.traceEnabled ? { diagnosticsAvailable: true } : {}),
            locale: this.coreSnapshot.locale,
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
    const serialized = JSON.stringify(state);
    if (serialized !== this.previousState) {
      this.previousState = serialized;
      this.stateVersion++;
    }
    return { ...state, stateVersion: this.stateVersion };
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
        const opening = this.openingIssued
          ? null
          : openingCommand(this.game.state(), this.coreSnapshot?.locale, this.coreSnapshot);
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
        await this.presentation?.photos(photos);
        this.syncCore(true);
        this.recordDiagnostic('photo_recognized');
        this.intents?.onContextChanged();
        if (this.coreSnapshot && this.game.proposal && photos.length) {
          this.enqueue(
            factCommand('写真の認識: ' + this.game.proposal.items.map((i) => i.name).join('、')),
          );
          this.enqueue({
            ...factCommand(
              this.words(
                '写真が届いたよ。これをどう使う？',
                'I got the photo. How should I use this?',
              ),
            ),
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
        this.recordDiagnostic('delegation_received');
        if (!this.game.terminal)
          this.intents!.acceptDelegation({
            id: event.delegation.id,
            generation,
            offsetMs: event.offset_ms,
          });
      } else {
        const fragment = this.ledger!.append({
          eventId: event.event_id,
          generation,
          speaker: event.type === 'session.input_transcript.delta' ? 'user' : 'assistant',
          delta: event.delta,
          startMs: event.start_ms,
          endMs: event.end_ms,
        });
        if (fragment?.speaker === 'user')
          this.recordDiagnostic(
            'user_transcript_received',
            fragment.executionEligible ? 'eligible' : 'ineligible',
          );
        if (fragment) this.presentation?.transcript(fragment);
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
  heartbeat(voice: Parameters<GameSession['heartbeat']>[0]) {
    this.game.heartbeat(voice);
    // Start only once, after the answered call actually connects.
    if (this.coreSnapshot && voice === 'connected' && this.game.status === 'briefing') {
      this.start();
    }
  }
  start(): LiveCommand[] {
    this.check();
    const wasBriefing = this.game.status === 'briefing';
    if (wasBriefing && this.ledger) {
      const evidence = this.ledger.captureUnconsumedContext().eligibleEvidenceSeq;
      if (evidence.length) this.ledger.consume(evidence);
    }
    this.game.start();
    if (wasBriefing) this.presentScene(this.game.situation);
    this.syncCore(true);
    return wasBriefing && !this.coreSnapshot
      ? [
          factCommand(
            this.words(
              '導入チュートリアルは終了。本編を開始し、制限時間が進んでいます。現在の障害について相談を続けてください。',
              'The tutorial is over. The game and countdown have started. Continue discussing the current obstacle.',
            ),
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
    clearInterval(this.maintenanceTimer);
    this.traceEntries = [];
    this.intents?.stop();
    this.ledger?.stop();
    clearTimeout(this.transcriptTimer);
    this.game.end();
    this.seen.clear();
    this.liveRequests.clear();
    this.photoRequests.clear();
  }
}
