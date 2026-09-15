import { KnowledgeStore, buildCompanionContext } from './companion-knowledge.js';
import { companionResultFacts } from './companion-response.js';
import { VoiceNotificationScheduler } from './voice-notifications.js';
import { OpeningBriefingDelivery } from './opening-briefing.js';
import { FinalVoicePlayback } from './final-voice-playback.js';
import { voiceActivitySchema, type VoiceActivity } from '../../packages/shared/harness.js';
import type { ScenarioSnapshot } from '../server/scenario-catalog.js';
import { createHash, randomUUID } from 'node:crypto';
import { ConversationLedger } from './conversation.js';
import { IntentCoordinator } from './intent-coordinator.js';
import { LiveOutbox } from './live-outbox.js';

import { classifyPhoto, classifyActionControl, type PhotoDecision } from './harness-decisions.js';
import type { ExecuteIntent, TranscriptFragment } from '../../packages/shared/conversation.js';
import type { IntentContext } from './conversation.js';
import { classifyCoreIntent } from './core-intent-ai.js';
import { GameSession, GameError } from './game.js';
import { createGameAI } from './game-ai.js';
import { decodePhotos } from './photo.js';
import {
  liveInstructions,
  openingCommand,
  factCommand,
  factCommands,
  speechCommands,
  liveEventSchema,
} from './live.js';
import type { Scenario } from '../../packages/shared/scenario.js';
import type { LiveCommand } from '../../packages/shared/game.js';
import type { AiService } from '../../packages/server/ai-service.js';
import type { PhotoQueue } from '../server/photo-queue.js';
import { StoryEvidenceLedger } from './story-evidence.js';
import { endingOutcome, freezeEndingPacket, type EndingPacket } from './ending.js';
import type { IntentDecision } from '../../packages/shared/conversation.js';
import { creditCosts } from '../../packages/shared/credits.js';
import {
  storyClearCount,
  storyContext,
  storyNarration,
  storyOpening,
  storyOpeningBriefing,
  requestsStoryHint,
} from './story.js';

export interface RuntimePresentation {
  transcript(
    fragment: import('../../packages/shared/conversation.js').TranscriptFragment,
    messageId?: string,
  ): void;
  photos(photos: import('./photo.js').GamePhoto[]): Promise<void>;
  scene(input: {
    messageId: string;
    text: string;
    awaitTranscript?: boolean;
    commandSeq: number | null;
    generation: number;
    gameVersion: number;
    facts: import('../../packages/shared/conversation.js').GameFacts;
    situation: string;
    action: import('./ending.js').CommittedEndingAction | null;
  }): void;
  notice?(text: string, kind?: 'opening-briefing'): void;
  ending?(packet: EndingPacket, seal: () => EndingPacket): void;
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
  private readonly processedPhotos = new Set<string>();
  private readonly chargedEvidence = new Map<number, number>();
  private readonly correctedEvidence = new Set<string>();
  private legacyConversation: string | null = null;
  private lowCreditsNotified = false;
  private photoWorker?: Promise<void>;
  private photoDeciding = false;
  private activeUsage = '';
  private runtimeActionId: string | null = null;
  private photoAcceptance?: { revision: number; decision: PhotoDecision };
  private control?: {
    actionId: string;
    usage: string;
    epoch: number;
    fragments: TranscriptFragment[];
    controller: AbortController;
    delegation?: { id: string; generation: number; offsetMs: number };
  };
  private pendingRisk?: {
    usage: string;
    itemRefs: ExecuteIntent['itemRefs'];
    mode?: ExecuteIntent['mode'];
    environmentTargetIds?: ExecuteIntent['environmentTargetIds'];
    message: string;
    gameVersion: number;
  };
  private actionInFlight = false;
  private pendingScene: { messageId: string; beforeVersion: number } | null = null;
  private readonly sceneMessages = new Map<number, string>();
  private readonly story = new StoryEvidenceLedger();
  private terminalPacket?: EndingPacket;
  private sealedPacket?: EndingPacket;
  private stateVersion = 0;
  private previousState = '';
  private epoch = 1;
  private openingIssued = false;
  private openingMessageId?: string;
  private openingBriefing?: OpeningBriefingDelivery;
  private pendingOpeningBriefing?: string;
  private seen = new Set<string>();
  private maintenanceTimer?: ReturnType<typeof setInterval>;
  private knowledge?: KnowledgeStore;
  private notifications?: VoiceNotificationScheduler<{
    text: string;
    delegationId: string | null;
    messageId: string | null;
  }>;
  private hintEvidence = new Map<string, Set<string>>();
  private transcriptTimer?: ReturnType<typeof setTimeout>;
  private liveRequests = new Map<
    string,
    Cached<{ sdp: string; generation: number; opening: LiveCommand | null }>
  >();
  private photoRequests = new Map<string, Cached<void>>();
  private liveCreating = false;
  private disposed = false;
  private finalVoice: FinalVoicePlayback;
  private immediateCloseAt = Infinity;
  get closingAt() {
    return Math.min(this.deadline, this.immediateCloseAt, this.finalVoice.closingAt);
  }
  get voiceGeneration() {
    return this.game.generation - (this.game.terminal && !this.coreSnapshot ? 1 : 0);
  }

  constructor(
    readonly id: string,
    readonly deadline: number,
    scenario: Scenario,
    private ai: AiService,
    private models: { liveModel: string; gameModel: string },
    private queue: PhotoQueue,
    private now = () => performance.now(),
    readonly coreSnapshot?: ScenarioSnapshot,
    private readonly presentation?: RuntimePresentation,
    private readonly traceEnabled = false,
  ) {
    this.finalVoice = new FinalVoicePlayback(now);
    ai.register(id, deadline);
    this.game = new GameSession(
      scenario,
      createGameAI(
        { respond: (body, signal) => ai.respond(id, body, signal) },
        () => models.gameModel,
        coreSnapshot,
      ),
      now,
      () => {
        if (this.game.endReason === 'credits_exhausted')
          this.presentation?.notice?.(
            this.words('クレジットを使い切りました。', 'You have used all your credits.'),
          );
        clearTimeout(this.transcriptTimer);
        clearInterval(this.maintenanceTimer);
        this.seen.clear();
        this.intents?.stop();
        this.notifications?.endWarnings();
        this.traceEntries = [];
        this.diagnostics = [];
        if (this.game.voiceState === 'connected')
          this.finalVoice.start(
            this.voiceGeneration,
            this.outbox?.latestSeq ?? 0,
            this.outbox?.hasUnacknowledgedSpeech,
          );
        else this.immediateCloseAt = now();
        const finalActionCommitted =
          this.actionInFlight &&
          this.pendingScene &&
          this.game.gameVersion > this.pendingScene.beforeVersion;
        if (['won', 'lost'].includes(this.game.status)) {
          if (finalActionCommitted) {
            const messageId = this.pendingScene!.messageId;
            this.sceneMessages.set(this.game.gameVersion, messageId);
            this.recordSceneEvidence(
              this.game.lastResult!.narrative + '\n' + this.currentSituation(),
              messageId,
            );
          } else this.presentScene(this.game.situation);
        }
        this.story.end(now(), Math.min(deadline, now() + 12_000));
        this.terminalPacket = this.captureEnding(now());
        // The owner reserves ending AI authority synchronously, before Live retirement.
        this.presentation?.ending?.(this.terminalPacket, () => this.sealEnding());
        this.presentation?.ended(this.state());
      },
      coreSnapshot,
    );
    this.story.startGeneration(this.game.generation, now());
    this.story.append({
      sourceId: 'briefing',
      kind: 'briefing',
      generation: this.game.generation,
      gameVersion: this.game.gameVersion,
      text: scenario.playerBriefing,
    });
    if (coreSnapshot) {
      if (coreSnapshot.scenarioV2.story)
        this.openingBriefing = new OpeningBriefingDelivery(coreSnapshot.locale, now);
      this.knowledge = new KnowledgeStore(coreSnapshot);
      this.knowledge.advance(this.game.facts);
      this.notifications = new VoiceNotificationScheduler(
        coreSnapshot.coreConfig.warnings,
        now,
        Date.now,
        (warning, result) => ({ ...result, text: warning.text + '\n' + result.text }),
      );
      this.notifications.reset(this.game.generation);
      this.game.controllerEpoch = this.epoch;
      this.ledger = new ConversationLedger({ generation: this.game.generation, now });
      this.outbox = new LiveOutbox(this.game.generation, this.epoch, Date.now, {
        maxCommands: 1024,
        maxBytes: 512 * 1024,
      });
      this.syncCore();
      this.intents = new IntentCoordinator({
        ledger: this.ledger,
        consumeOnReservation: true,
        now,
        classify: async (context) => {
          if (this.game.state().busy || this.notificationFailed || this.photoDeciding) {
            this.recordDiagnostic(
              'classification_skipped',
              this.notificationFailed ? 'notification_failed' : 'busy',
            );
            return { kind: 'wait', reason: '処理中です。完了してからもう一度話してください。' };
          }
          this.recordDiagnostic('classification_started');
          const decision = await classifyCoreIntent({
            respond: (body) => ai.respond(id, body),
            model: models.gameModel,
            snapshot: coreSnapshot,
            conversation: context,
            game: {
              publicState: this.publicContext(),
              photoAcceptance:
                this.photoAcceptance?.revision === this.game.inputRevision
                  ? this.photoAcceptance.decision
                  : null,
              pendingRisk:
                this.pendingRisk?.gameVersion === this.game.gameVersion ? this.pendingRisk : null,
              status: this.game.status,
              situation: this.game.situation,
              obstacle: coreSnapshot.scenarioV2.obstacles[this.game.obstacleIndex],
              facts: this.game.facts,
              inventory: this.game.inventory,
              proposal: this.game.proposal,
              photos: this.game.photos.map((p) => ({ id: p.id })),
            },
            photos: this.game.photos,
            obstacleIndex: this.game.obstacleIndex,
            hintsAlreadyGiven: this.hintsAlreadyGiven(context),
            knowledge: this.knowledge,
            gameState: this.game.state(),
            onRiskProposal: (proposal) => {
              if (this.ledger!.captureUnconsumedContext().contextVersion !== context.contextVersion)
                return;
              this.pendingRisk = { ...proposal, gameVersion: this.game.gameVersion };
            },
            onRecognitionCorrection: (correction) => {
              if (
                this.ledger!.captureUnconsumedContext().contextVersion !== context.contextVersion ||
                this.game.state().busy
              )
                return;
              this.correctedEvidence.add(
                `${context.generation}:${Math.max(...context.eligibleEvidenceSeq)}`,
              );
              const item = this.game.proposal?.items.find(
                (item) => item.photoId === correction.photoId,
              );
              if (!item || item.name === correction.name) return;
              item.name = correction.name;
              this.game.inputRevision++;
              this.game.proposal!.inputRevision = this.game.inputRevision;
              this.pendingRisk = undefined;
              this.photoAcceptance = undefined;
              this.syncCore(true);
            },
          });
          this.recordDiagnostic('classification_returned', decision.kind);
          return decision;
        },
        execute: (intent, context, delegation) => this.executeCore(intent, context, delegation.id),
        onDecision: (decision, delegation) => {
          this.recordDiagnostic('decision_accepted', decision.kind);
          if (decision.kind === 'consult') {
            this.answerConsult(decision, delegation.id);
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
          if (decision.kind === 'execute') {
            this.sendFacts(this.currentSituation());
            this.enqueue({
              ...factCommand(
                this.words(
                  '未処理の実行指示があります。行動はまだ予約も実行もされていません。最新の指示と訂正をclientへ委譲してください。確定結果が届くまで成功したと伝えないでください。',
                  'There is an unhandled action request. No action is reserved or executed. Delegate the latest request and corrections to the client. Do not claim success before the confirmed server result.',
                ),
              ),
              type: 'session.instructions.append',
            });
          } else if (decision.kind === 'consult') {
            this.answerConsult(decision, null);
            const eligible = this.ledger!.captureUnconsumedContext().eligibleEvidenceSeq;
            if (decision.evidenceSeq.every((seq) => eligible.includes(seq)))
              this.ledger!.consume(decision.evidenceSeq);
          }
        },
        onRecoveryExpired: () => this.recoveryNotice('recovery_expired'),
        onError: (error) => {
          const code =
            error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message)
              ? error.message
              : 'PROCESSING_ERROR';
          this.recordDiagnostic('error', code);
          if (this.valid() && code !== 'ACTION_INVALID') {
            this.game.error = this.words(
              'ごめん、うまく確認できなかった。もう一度教えて。',
              'Sorry, I could not confirm that. Please tell me again.',
            );
            this.speak(this.game.error);
          }
          this.syncCore();
        },
      });
      this.maintenanceTimer = setInterval(() => this.tick(), 1000);
      this.maintenanceTimer.unref();
    }
  }
  private async executeCore(
    intent: ExecuteIntent,
    context: IntentContext,
    delegationId: string | null,
  ): Promise<void> {
    const creditId =
      intent.origin?.kind === 'photo'
        ? null
        : this.reserveConversation(context.generation, intent.evidenceSeq);
    const before = this.game.gameVersion;
    let completed = false;
    try {
      await this.performCoreAction(intent, context, delegationId);
      completed = !this.disposed && context.controllerEpoch === this.epoch;
    } finally {
      // A confirmed action remains paid even if its later narration fails.
      if (completed || this.game.gameVersion > before) {
        this.finishConversation(context.generation, intent.evidenceSeq, creditId);
      } else if (creditId) this.game.credits.cancel(creditId);
    }
  }
  private async performCoreAction(
    intent: ExecuteIntent,
    context: IntentContext,
    delegationId: string | null,
  ): Promise<void> {
    const coreSnapshot = this.coreSnapshot!;

    this.check();
    if (
      this.photoAcceptance?.revision === this.game.inputRevision &&
      this.photoAcceptance.decision.decision === 'reject' &&
      intent.itemRefs.some((ref) => 'photoId' in ref)
    ) {
      const revision = this.game.inputRevision;
      const decision = await classifyPhoto(
        this.modelClient(),
        {
          acceptancePolicy: coreSnapshot.coreConfig.acceptancePolicy[coreSnapshot.locale],
          priorDecision: this.photoAcceptance.decision,
          publicState: this.publicContext(),
          inventory: this.game.inventory,
          recognizedItems: this.game.proposal?.items,
          photos: this.game.photos.map((photo) => photo.id),
          requestedUsage: intent.usage,
          userSpeech: context.fragments
            .filter(
              (fragment) =>
                fragment.speaker === 'user' && intent.evidenceSeq.includes(fragment.serverSeq),
            )
            .map((fragment) => fragment.delta)
            .join(''),
        },
        !!coreSnapshot.coreConfig.creativity?.enabled,
      );
      this.check(context.controllerEpoch);
      if (
        this.game.inputRevision !== revision ||
        this.ledger!.captureUnconsumedContext().contextVersion !== context.contextVersion
      )
        throw new GameError(409, 'ACTION_INVALID');
      this.photoAcceptance = { revision, decision };
      if (decision.decision !== 'execute') {
        if (intent.evidenceSeq.length) this.ledger!.consume(intent.evidenceSeq);
        if (decision.decision === 'confirm_risk')
          this.pendingRisk = {
            usage: decision.usage,
            itemRefs: decision.itemRefs,
            message: decision.message,
            gameVersion: this.game.gameVersion,
          };
        this.speak(
          JSON.stringify({
            type: 'photo_result',
            facts: decision.message,
            requiresConfirmation: decision.decision === 'confirm_risk',
          }),
          delegationId,
        );
        return;
      }
    }
    this.game.currentContextVersion = this.ledger!.captureUnconsumedContext().contextVersion;
    if (
      this.pendingRisk?.gameVersion === this.game.gameVersion &&
      (intent.usage !== this.pendingRisk.usage ||
        JSON.stringify(intent.itemRefs) !== JSON.stringify(this.pendingRisk.itemRefs) ||
        (intent.mode ?? 'tool') !== (this.pendingRisk.mode ?? 'tool') ||
        JSON.stringify(intent.environmentTargetIds ?? []) !==
          JSON.stringify(this.pendingRisk.environmentTargetIds ?? []))
    ) {
      // A changed proposal never inherits permission given for a previous risk.
      this.pendingRisk = undefined;
    }
    this.recordDiagnostic('action_reserving');
    const ticket = this.game.reserveAction(
      intent,
      context.contextVersion,
      context.gameVersion,
      context.actionEpoch,
      context.controllerEpoch,
    );
    if (intent.evidenceSeq.length) this.ledger!.consume(intent.evidenceSeq);
    this.ledger!.updateState({ judging: true });
    this.activeUsage = intent.usage;
    this.runtimeActionId = ticket.id;
    // Photo admission is quiet; the result supplies the single spoken reaction.
    this.pendingRisk = undefined;
    this.recordDiagnostic('judgment_started');
    const judgmentStarted = this.now();
    const messageId = randomUUID();
    this.pendingScene = { messageId, beforeVersion: this.game.gameVersion };
    this.actionInFlight = true;
    let result;
    try {
      result = await this.game.judgeAction(ticket);
      this.recordDiagnostic('judgment_committed');
    } finally {
      if (this.runtimeActionId === ticket.id) {
        this.runtimeActionId = null;
        this.actionInFlight = false;
        this.pendingScene = null;
      }
      this.syncCore();
    }
    if (this.disposed || context.controllerEpoch !== this.epoch) return;
    this.syncCore();
    if (this.traceEnabled && !this.game.terminal) {
      this.traceEntries.push({
        actionId: ticket.id,
        configDigest: coreSnapshot.digest,
        interpretation: intent.usage.slice(0, 1000),
        shortReason: result.shortReason.slice(0, 1000),
        durationMs: Math.max(0, Math.round(this.now() - judgmentStarted)),
      });
      while (
        this.traceEntries.length > 128 ||
        Buffer.byteLength(JSON.stringify(this.traceEntries)) > 64 * 1024
      )
        this.traceEntries.shift();
    }
    // Keep private narration direction out of the speakable payload.
    // Freeze the scene now; a later photo or action must not change this result's picture.
    this.presentScene(result.narrative + '\n' + this.currentSituation(), messageId);
    this.speak(companionResultFacts(this.companionContext(), result), delegationId, messageId);
  }
  private modelClient() {
    return {
      respond: (body: unknown) => this.ai.respond(this.id, body),
      model: this.models.gameModel,
      locale: this.coreSnapshot!.locale,
    };
  }

  private async processPhoto(requestId: string): Promise<void> {
    if (!this.coreSnapshot || !this.ledger || this.processedPhotos.has(requestId)) return;
    // The receipt cache already bounds this set to 100 entries per play.
    this.processedPhotos.add(requestId);
    const epoch = this.epoch;
    const photoVersion = this.game.inputRevision;
    const photoIds = this.game.photos.map((photo) => photo.id);
    const version = this.game.gameVersion;
    for (let attempt = 0; attempt < 2; attempt++) {
      const context = this.ledger.captureUnconsumedContext();
      const decision = await classifyPhoto(
        this.modelClient(),
        {
          acceptancePolicy: this.coreSnapshot.coreConfig.acceptancePolicy[this.coreSnapshot.locale],
          publicState: this.publicContext(),
          inventory: this.game.inventory,
          recognizedItems: this.game.proposal?.items,
          photos: photoIds,
          conversation: context.fragments
            .slice(-24)
            .map(({ speaker, delta }) => ({ speaker, text: delta })),
        },
        !!this.coreSnapshot.coreConfig.creativity?.enabled,
      );
      if (
        !this.valid(epoch) ||
        this.game.gameVersion !== version ||
        this.game.inputRevision !== photoVersion ||
        this.game.status !== 'playing'
      )
        return;
      if (context.contextVersion !== this.ledger.captureUnconsumedContext().contextVersion)
        continue;
      this.photoAcceptance = { revision: photoVersion, decision };
      if (decision.decision === 'execute') {
        await this.executeCore(
          {
            kind: 'execute',
            evidenceSeq: [],
            origin: { kind: 'photo', requestId, photoIds, photoVersion },
            itemRefs: decision.itemRefs,
            usage: decision.usage,
            reason: decision.reason,
          },
          context,
          null,
        );
      } else if (decision.decision !== 'wait') {
        if (decision.decision === 'confirm_risk')
          this.pendingRisk = {
            usage: decision.usage,
            itemRefs: decision.itemRefs,
            message: decision.message,
            gameVersion: version,
          };
        this.speak(
          JSON.stringify({
            type: 'photo_result',
            facts: decision.message,
            requiresConfirmation: decision.decision === 'confirm_risk',
          }),
        );
      }
      return;
    }
    this.speak(
      this.words(
        '写真受信済み。用途が未確定。使い方の確認が必要。',
        'Photo received. Intended use is unclear; ask how to use it.',
      ),
    );
  }

  private receiveControl(fragment: TranscriptFragment): void {
    const actionId = this.game.pendingActionId;
    if (!actionId || !this.game.holdPendingAction(actionId, fragment.eventId)) return;
    if (this.control?.actionId === actionId) {
      this.control.fragments.push(fragment);
      return;
    }
    this.control?.controller.abort();
    const control = {
      actionId,
      usage: this.activeUsage,
      epoch: this.epoch,
      fragments: [fragment],
      controller: new AbortController(),
    };
    this.control = control;
    const deadline = setTimeout(() => {
      control.controller.abort();
      this.game.cancelPendingAction(actionId);
      this.syncCore();
    }, 5_000);
    deadline.unref();
    void this.processControls(control)
      .catch(() => {
        const cancelled = this.game.cancelPendingAction(actionId);
        this.syncCore();
        if (
          this.valid(control.epoch) &&
          this.control === control &&
          (cancelled || this.game.gameVersion === fragment.receivedGameVersion)
        ) {
          this.speak(
            this.words(
              'いったん止めたよ。どうしたらいい？',
              'I stopped for now. What should I do?',
            ),
            null,
            null,
            'correction',
          );
        }
      })
      .finally(() => {
        clearTimeout(deadline);
        if (this.control === control) this.control = undefined;
      });
  }

  private async processControls(control: NonNullable<GameRuntime['control']>): Promise<void> {
    let handled = 0;
    const { actionId } = control;
    while (this.game.pendingActionId === actionId && handled < control.fragments.length) {
      const batch = control.fragments.slice();
      const decision = await classifyActionControl(
        {
          ...this.modelClient(),
          respond: (body) => this.ai.respondControl(this.id, body, control.controller.signal),
        },
        { pendingUsage: control.usage, userSpeech: batch.map((f) => f.delta).join('') },
      );
      if (!this.valid(control.epoch) || this.control !== control) return;
      if (this.game.pendingActionId !== actionId) {
        if (this.game.gameVersion === batch[0]?.receivedGameVersion)
          this.speak(
            this.words(
              'いったん止めたよ。どうしたらいい？',
              'I stopped for now. What should I do?',
            ),
            null,
            null,
            'correction',
          );
        return;
      }
      if (decision.decision === 'keep') {
        for (const fragment of batch.slice(handled))
          this.game.resolvePendingActionControl(actionId, fragment.eventId, 'keep');
        handled = batch.length;
        continue;
      }
      this.game.cancelPendingAction(actionId);
      this.syncCore();
      this.pendingRisk = undefined;
      if (decision.decision === 'replace') {
        this.correctedEvidence.add(
          `${this.game.generation}:${Math.max(...batch.map((f) => f.serverSeq))}`,
        );
        this.ledger!.promoteControlEvidence(batch.map((f) => f.serverSeq));
        if (control.delegation) this.intents!.acceptDelegation(control.delegation);
        else
          this.enqueue({
            ...factCommand(
              this.words(
                '訂正を受け付け、前の行動を止めました。最新のユーザーの訂正をclientへ委譲してください。成功したとは言わないでください。',
                'The previous action is stopped. Delegate the latest user correction to the client. Do not claim success.',
              ),
            ),
            type: 'session.instructions.append',
          });
      } else
        this.speak(
          decision.decision === 'unknown'
            ? this.words(
                'いったん止めたよ。どう変えたい？',
                'I stopped for now. What would you like to change?',
              )
            : this.coreSnapshot!.coreConfig.recovery.cancelled[this.coreSnapshot!.locale],
          null,
          null,
          'correction',
        );
      return;
    }
  }
  private companionContext() {
    this.knowledge!.advance(this.game.facts);
    return buildCompanionContext(this.coreSnapshot!, this.knowledge!, this.game.state());
  }
  private publicContext() {
    return {
      ...this.companionContext(),
      status: this.game.status,
      creditsRemaining: this.game.credits.remaining,
      recognizedItems: this.game.proposal?.items.map(({ name }) => name) ?? [],
      lastResult: this.game.lastResult,
    };
  }
  private currentSituation() {
    return this.words('現在の状況: ', 'Current situation: ') + this.game.situation;
  }
  private reserveConversation(generation: number, evidence: number[], free = false): string | null {
    const through = Math.max(0, ...evidence);
    if (
      !through ||
      through <= (this.chargedEvidence.get(generation) ?? 0) ||
      free ||
      this.correctedEvidence.has(`${generation}:${through}`) ||
      this.game.status === 'briefing'
    )
      return null;
    const id = `conversation:${generation}:${through}`;
    this.game.reserveCredits(id, 'conversation', creditCosts.conversation);
    return id;
  }
  private finishConversation(generation: number, evidence: number[], id: string | null) {
    if (evidence.length)
      this.chargedEvidence.set(
        generation,
        Math.max(this.chargedEvidence.get(generation) ?? 0, ...evidence),
      );
    if (id) this.game.settleCredits(id);
    this.presentCreditWarning();
  }
  private answerConsult(
    decision: Extract<IntentDecision, { kind: 'consult' }>,
    delegationId: string | null,
  ) {
    const generation = this.game.generation;
    if (Math.max(0, ...decision.evidenceSeq) <= (this.chargedEvidence.get(generation) ?? 0)) return;
    const id = this.reserveConversation(
      generation,
      decision.evidenceSeq,
      decision.responseKind === 'correction' || !!decision.recognitionCorrection,
    );
    try {
      this.recordHintDecision(decision);
      this.speak(
        JSON.stringify(
          decision.responseKind === 'social'
            ? { type: 'social' }
            : {
                type: 'consultation',
                facts: decision.answer || this.game.situation,
                requiresConfirmation: !!decision.riskProposal,
                ...(decision.riskProposal ? { risk: decision.riskProposal.message } : {}),
              },
        ),
        delegationId,
      );
      if (this.notificationFailed) {
        if (id) this.game.credits.cancel(id);
        return;
      }
      this.finishConversation(generation, decision.evidenceSeq, id);
    } catch (error) {
      if (id) this.game.credits.cancel(id);
      throw error;
    }
  }
  private presentCreditWarning() {
    if (this.game.terminal) return;
    // Credit warnings are display-only; sending balances to Live can prompt spoken warnings.
    if (
      !this.lowCreditsNotified &&
      this.game.credits.remaining <= this.game.credits.initial * 0.2
    ) {
      this.lowCreditsNotified = true;
      this.presentation?.notice?.(
        this.words(
          'ご利用可能クレジットが残りわずかです',
          'Your available credits are running low.',
        ),
      );
    }
  }
  private hintsAlreadyGiven(context: import('./conversation.js').IntentContext) {
    const evidence = this.hintEvidence.get(this.game.facts.obstacleId);
    const key = `${context.generation}:${context.eligibleEvidenceSeq.join(',')}`;
    return (evidence?.size ?? 0) - (evidence?.has(key) ? 1 : 0);
  }
  private recordHintDecision(decision: IntentDecision) {
    if (decision.kind !== 'consult' || !this.ledger || !this.coreSnapshot?.scenarioV2.story) return;
    const context = this.ledger.captureUnconsumedContext();
    context.eligibleEvidenceSeq = decision.evidenceSeq;
    if (!requestsStoryHint(context)) return;
    const obstacleId = this.game.facts.obstacleId;
    const evidence = this.hintEvidence.get(obstacleId) ?? new Set<string>();
    evidence.add(`${context.generation}:${decision.evidenceSeq.join(',')}`);
    this.hintEvidence.set(obstacleId, evidence);
  }
  private sendFacts(text: string, delegationId: string | null = null) {
    for (const command of factCommands(text, delegationId)) this.enqueue(command);
  }
  private speak(
    text: string,
    delegationId: string | null = null,
    messageId: string | null = null,
    kind: 'result' | 'correction' = 'result',
  ) {
    if (this.notifications) {
      this.notifications.enqueue({
        id: randomUUID(),
        kind: this.game.terminal ? 'ending' : kind,
        generation: this.game.generation,
        payload: { text, delegationId, messageId },
      });
      return this.drainNotifications();
    }
    let first: ReturnType<GameRuntime['enqueue']>;
    for (const command of speechCommands(text, delegationId)) {
      const queued = this.enqueue(command, messageId);
      if (!queued) break;
      first ??= queued;
    }
    return first;
  }
  private recoveryNotice(stage: string) {
    if (!this.valid() || this.game.status !== 'playing' || this.game.state().busy) return;
    this.recordDiagnostic(stage);
    const text =
      this.coreSnapshot?.coreConfig.recovery.failed[this.coreSnapshot.locale] ??
      'ごめん、もう一度教えて。';
    this.game.error = text;
    this.speak(text);
    this.presentNotice(text);
  }
  /** Server-owned maintenance; also callable with the injected clock in tests. */
  tick() {
    if (this.disposed || !this.coreSnapshot) return;
    this.game.check();
    if (!this.valid()) return;
    this.deliverOpeningBriefing();
    const state = this.game.state();
    if (
      state.status !== 'playing' ||
      state.voiceState !== 'connected' ||
      state.paused ||
      state.busy
    )
      return;
    this.intents?.tick();
    this.notifications?.updateWarnings(state.remainingMs, this.coreSnapshot.locale, (text) => ({
      text,
      delegationId: null,
      messageId: null,
    }));
    this.drainNotifications();
  }
  reportVoiceActivity(raw: VoiceActivity): void {
    this.checkVoice();
    const activity = voiceActivitySchema.parse(raw);
    if (activity.generation !== this.voiceGeneration)
      throw new GameError(409, 'LIVE_CONNECTION_STALE');
    this.notifications?.report(activity);
    this.finalVoice.report(activity);
    this.openingBriefing?.report(activity);
    this.deliverOpeningBriefing();
  }
  private deliverOpeningBriefing() {
    if (
      this.pendingOpeningBriefing &&
      this.valid() &&
      this.game.status === 'playing' &&
      this.game.voiceState === 'connected' &&
      this.openingBriefing?.takeReady()
    ) {
      const text = this.pendingOpeningBriefing;
      this.pendingOpeningBriefing = undefined;
      // Publish the silent briefing with its already-running initial scene image.
      // Never enqueue a Live commentary command.
      this.presentNotice(text, 'opening-briefing');
    }
  }
  private drainNotifications() {
    let first: ReturnType<GameRuntime['enqueue']>;
    let notice;
    while ((notice = this.notifications?.takeNext())) {
      const warning =
        notice.validUntil === undefined
          ? undefined
          : { validUntil: notice.validUntil, noticeKind: 'time-warning' as const };
      // Quiet telemetry is advisory, not a semantic turn boundary. Ordinary
      // warnings remain silent context so Live can finish the conversation first.
      // Final warnings retain the scheduler's bounded wait and spoken transition.
      const commands =
        notice.kind === 'normal-warning'
          ? factCommands(JSON.stringify({ type: 'time_warning', message: notice.payload.text }))
          : speechCommands(notice.payload.text, notice.payload.delegationId, notice.id);
      for (const command of commands) {
        const queued = this.enqueue(command, notice.payload.messageId, warning);
        // Incomplete facts must never be followed by their speech trigger.
        if (!queued) break;
        first ??= queued;
      }
      if (warning || notice.includesTimeWarning) {
        // Live may paraphrase this text. Its transcript is the single chat
        // source; a fixed notice here would duplicate the same warning.
        this.recordDiagnostic('time_warning');
      }
    }
    return first;
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
  private enqueue(
    command: LiveCommand,
    messageId: string | null = null,
    warning?: { validUntil: number; noticeKind: 'time-warning' },
  ) {
    try {
      const queued = this.outbox?.append(command, messageId, warning);
      if (queued && command.type === 'session.commentary.append')
        this.finalVoice.expectSpeech(queued.seq);
      if (queued) this.recordDiagnostic('live_command_queued', command.type);
      return queued;
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
  private recordSceneEvidence(text: string, messageId: string) {
    this.story.append({
      sourceId: `scene:${messageId}`,
      kind: this.game.lastResult ? 'action_result' : 'situation',
      generation: this.game.generation,
      gameVersion: this.game.gameVersion,
      text,
    });
  }
  private presentNotice(text: string, kind?: 'opening-briefing') {
    if (this.presentation?.notice) {
      this.story.append({
        sourceId: `notice:${randomUUID()}`,
        kind: 'situation',
        generation: this.game.generation,
        gameVersion: this.game.gameVersion,
        text,
      });
      this.presentation.notice(text, kind);
    }
  }
  private presentScene(
    text: string,
    messageId = randomUUID(),
    commandSeq: number | null = null,
    awaitTranscript = false,
  ) {
    this.openingMessageId = undefined;
    this.sceneMessages.set(this.game.gameVersion, messageId);
    this.recordSceneEvidence(text, messageId);
    const action = this.game.committedActions.at(-1);
    this.presentation?.scene({
      messageId,
      text,
      awaitTranscript,
      commandSeq,
      generation: this.game.generation,
      gameVersion: this.game.gameVersion,
      facts: structuredClone(this.game.facts),
      situation: this.game.situation,
      action: action?.afterVersion === this.game.gameVersion ? structuredClone(action) : null,
    });
  }
  private captureEnding(endedAt: number): EndingPacket {
    const reference = (gameVersion: number) => {
      const messageId = this.sceneMessages.get(gameVersion);
      return messageId ? { messageId, gameVersion } : null;
    };
    return freezeEndingPacket({
      playId: this.id,
      snapshot: this.coreSnapshot ?? null,
      scenario: this.game.scenario,
      locale: this.coreSnapshot?.locale ?? 'ja',
      outcome: endingOutcome(this.game.status, this.game.clearedIds),
      endReason: this.game.endReason!,
      clearedIds: this.game.clearedIds,
      remainingObstacles: this.game.scenario.obstacles
        .filter((obstacle) => !this.game.clearedIds.includes(obstacle.id))
        .map(({ id, title, situation }) => ({ id, title, situation })),
      facts: this.game.facts,
      inventory: this.game.inventory,
      actions: this.game.committedActions,
      evidence: this.story.snapshot(),
      endedAt,
      gameVersion: this.game.gameVersion,
      finalMessageId: reference(this.game.gameVersion)?.messageId ?? null,
      actionScenes: this.game.committedActions.map((action) => ({
        actionId: action.actionId,
        before: reference(action.beforeVersion),
        after: reference(action.afterVersion),
      })),
    });
  }
  private sealEnding(): EndingPacket {
    if (!this.terminalPacket) throw new Error('ENDING_NOT_TERMINAL');
    this.sealedPacket ??= freezeEndingPacket({
      ...this.terminalPacket,
      evidence: this.story.seal(),
    });
    return this.sealedPacket;
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
    this.checkVoice();
    if (!this.outbox) throw new GameError(410, '音声通知は終了しました。');
    const batch = this.outbox.poll(generation, this.epoch, ackThrough);
    this.finalVoice.acknowledge(batch.acknowledgedThrough);
    return batch;
  }
  private checkVoice() {
    this.game.check();
    if (this.disposed || this.now() >= this.deadline || this.now() >= this.closingAt)
      throw new GameError(410, '音声受付は終了しました。');
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
    this.openingMessageId = undefined;
    this.openingBriefing?.suspend();
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
            instructions: liveInstructions(
              this.game.state(),
              this.coreSnapshot,
              this.game.facts,
              this.coreSnapshot ? this.companionContext() : undefined,
            ),
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
        this.game.credits.cancelPending();
        this.legacyConversation = null;
        this.openingMessageId = undefined;
        this.openingBriefing?.connect(this.game.generation);
        this.story.startGeneration(this.game.generation, this.now());
        this.syncCore();
        this.intents?.reset();
        this.outbox?.reset(this.game.generation, this.epoch);
        this.notifications?.reset(this.game.generation);
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
    const digest = createHash('sha256').update(JSON.stringify(images)).digest('hex');
    const prior = this.photoRequests.get(requestId);
    if (prior) {
      if (prior.digest !== digest || prior.epoch !== this.epoch)
        throw new GameError(409, '写真の再送内容が変更されています。');
      if (this.disposed || this.now() >= this.deadline)
        throw new GameError(410, 'プレイは終了しています。');
      return prior.promise;
    }
    this.check();
    if (this.photoRequests.size >= 100) throw new GameError(429, '写真送信の試行上限です。');
    const ticket = this.game.beginPhotos(images.length);
    this.pendingRisk = undefined;
    this.photoAcceptance = undefined;
    this.openingMessageId = undefined;
    this.syncCore(true);
    const epoch = this.epoch;
    const promise = (async () => {
      try {
        const photos = await this.queue.run(
          () => decodePhotos(images, this.game.scenario.rules.maxPhotosPerSend),
          () => this.valid(epoch),
          signal,
        );
        this.check(epoch);
        await this.game.finishPhotos(photos, ticket, true);
        this.check(epoch);
        await this.presentation?.photos(photos);
        this.syncCore(true);
        this.recordDiagnostic('photo_recognized');
        this.intents?.onContextChanged();
        if (this.coreSnapshot && this.game.proposal && photos.length) {
          this.photoDeciding = true;
          const beforeVersion = this.game.gameVersion;
          const photoWorker = this.processPhoto(requestId)
            .catch((error) => {
              if (
                this.game.gameVersion === beforeVersion &&
                !(error instanceof GameError && error.message === 'ACTION_INVALID')
              )
                this.game.credits.cancel(ticket.creditId);
              if (!(error instanceof GameError && error.message === 'ACTION_INVALID'))
                this.recoveryNotice('photo_decision_failed');
            })
            .finally(() => {
              if (this.photoWorker !== photoWorker) return;
              this.photoDeciding = false;
              this.game.settleCredits(ticket.creditId);
              this.presentCreditWarning();
              this.ledger?.contextChanged();
              this.intents?.onContextChanged();
            });
          this.photoWorker = photoWorker;
        } else {
          this.game.settleCredits(ticket.creditId);
          this.presentCreditWarning();
        }
      } catch (error) {
        this.game.credits.cancel(ticket.creditId);
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
    this.checkVoice();
    if (generation !== this.voiceGeneration) throw new GameError(409, '古い音声接続です。');
    const event = liveEventSchema.parse(raw);
    // Late input/delegation can already be in flight when the browser stops its
    // microphone. Acknowledge and discard it; only the AI's final text survives.
    if (this.game.terminal && event.type !== 'session.output_transcript.delta') return [];
    if (this.coreSnapshot) {
      this.syncCore();
      if (event.type === 'session.delegation.created') {
        this.openingMessageId = undefined;
        this.recordDiagnostic('delegation_received');
        if (this.game.pendingActionId) {
          if (this.control)
            this.control.delegation = {
              id: event.delegation.id,
              generation,
              offsetMs: event.offset_ms,
            };
        } else if (!this.game.terminal)
          this.intents!.acceptDelegation({
            id: event.delegation.id,
            generation,
            offsetMs: event.offset_ms,
          });
      } else {
        let fragment;
        try {
          fragment = this.ledger!.append({
            eventId: event.event_id,
            generation,
            speaker: event.type === 'session.input_transcript.delta' ? 'user' : 'assistant',
            delta: event.delta,
            startMs: event.start_ms,
            endMs: event.end_ms,
          });
        } catch (error) {
          if (error instanceof Error && error.message === 'CONVERSATION_LIMIT')
            this.story.markTruncated();
          throw error;
        }
        if (fragment?.speaker === 'user')
          this.recordDiagnostic(
            'user_transcript_received',
            fragment.executionEligible ? 'eligible' : 'ineligible',
          );
        if (fragment) {
          if (fragment.speaker === 'assistant' && fragment.delta.trim())
            this.finalVoice.transcript();
          this.story.transcript(fragment, this.now());
          if (fragment.speaker === 'user' && fragment.delta.trim())
            this.openingMessageId = undefined;
          if (fragment.speaker === 'user' && fragment.delta.trim()) this.receiveControl(fragment);
          this.presentation?.transcript(
            fragment,
            fragment.speaker === 'assistant' ? this.openingMessageId : undefined,
          );
          this.openingBriefing?.transcript(fragment);
          this.deliverOpeningBriefing();
        }
        this.syncCore();
        if (!this.game.terminal) this.intents!.onContextChanged();
      }
      return [];
    }
    if (this.seen.has(event.event_id)) return [];
    if (this.seen.size >= 10000) throw new GameError(429, '音声イベント上限です。');
    this.seen.add(event.event_id);
    const epoch = this.epoch;
    if (event.type === 'session.output_transcript.delta') {
      if (event.delta.trim()) this.finalVoice.transcript();
      this.story.transcript(
        {
          eventId: event.event_id,
          generation,
          speaker: 'assistant',
          delta: event.delta,
          startMs: event.start_ms,
          endMs: event.end_ms,
          receivedGameVersion: this.game.gameVersion,
          serverSeq: this.seen.size,
          executionEligible: false,
        },
        this.now(),
      );
      if (event.delta.trim() && this.legacyConversation && this.game.status === 'playing') {
        const id = this.legacyConversation;
        this.game.reserveCredits(id, 'conversation', creditCosts.conversation);
        this.legacyConversation = null;
        this.game.settleCredits(id);
      }
    }
    if (event.type === 'session.input_transcript.delta') {
      this.game.appendTranscript(event.delta);
      if (event.delta.trim() && this.game.status === 'playing')
        this.legacyConversation ??= `conversation:${generation}:${event.event_id}`;
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
      if (this.game.proposal && this.legacyConversation) {
        const id = this.legacyConversation;
        this.game.reserveCredits(id, 'conversation', creditCosts.conversation);
        this.legacyConversation = null;
        this.game.settleCredits(id);
      }
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
    if (voice !== 'connected') this.openingBriefing?.suspend();
    // Start only once, after the answered call actually connects.
    if (this.coreSnapshot && voice === 'connected' && this.game.status === 'briefing') {
      this.start();
    }
    this.deliverOpeningBriefing();
  }
  start(): LiveCommand[] {
    this.check();
    const wasBriefing = this.game.status === 'briefing';
    if (wasBriefing && this.ledger) {
      const evidence = this.ledger.captureUnconsumedContext().eligibleEvidenceSeq;
      if (evidence.length) this.ledger.consume(evidence);
    }
    this.game.start();
    if (wasBriefing) {
      if (this.coreSnapshot?.scenarioV2.story)
        this.pendingOpeningBriefing = storyOpeningBriefing(this.coreSnapshot);
      const messageId = randomUUID();
      this.presentScene(
        this.coreSnapshot?.scenarioV2.story ? storyOpening(this.coreSnapshot) : this.game.situation,
        messageId,
        null,
        !!this.coreSnapshot,
      );
      // Call-check deltas share the initial image bubble. The user's reply ends
      // that binding; the short introduction and silent briefing get their own rows.
      this.openingMessageId = messageId;
    }
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
    const scene = { messageId: randomUUID(), beforeVersion: this.game.gameVersion };
    if (!this.actionInFlight) {
      this.pendingScene = scene;
      this.actionInFlight = true;
    }
    let result;
    try {
      result = await this.game.commit(actionId, revision);
    } finally {
      if (this.pendingScene === scene) {
        this.pendingScene = null;
        this.actionInFlight = false;
      }
    }
    if (this.disposed || epoch !== this.epoch) throw new GameError(410, '操作権が失効しました。');
    if (this.game.gameVersion > scene.beforeVersion)
      this.presentScene(result.narrative + '\n' + this.currentSituation(), scene.messageId);
    if (this.game.terminal) this.finalVoice.expectSpeech(0);
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
    this.processedPhotos.clear();
    this.control?.controller.abort();
    this.notifications?.clear();
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
