import { randomUUID } from 'node:crypto';
import { KnowledgeStore, buildCompanionContext } from './companion-knowledge.js';
import { composeCompanionReply } from './companion-response.js';
import { classifyCoreIntent } from './core-intent-ai.js';
import { classifyPhoto, type PhotoDecision } from './harness-decisions.js';
import { GameSession, GameError } from './game.js';
import { ConversationLedger, type IntentContext } from './conversation.js';
import type { AIResponsesClient } from './game-ai.js';
import type { ScenarioSnapshot } from '../server/scenario-catalog.js';
import type { ExecuteIntent, IntentDecision } from '../../packages/shared/conversation.js';
import { creditCosts } from '../../packages/shared/credits.js';
import { requestsStoryHint } from './story.js';
import type { InvestigationPrompts } from './investigation-prompts.js';

export interface HarnessHooks {
  epoch(): number;
  disposed(): boolean;
  notificationFailed(): boolean;
  check(epoch?: number): void;
  valid(epoch?: number): boolean;
  diagnostic(stage: string, code?: string): void;
  speak(text: string, delegationId: string | null, messageId: string | null): void;
  facts(text: string, delegationId: string | null): void;
  scene(text: string, messageId: string): void;
  actionStarted(messageId: string, beforeVersion: number): void;
  actionFinished(): void;
  creditWarning(): void;
  trace(entry: {
    actionId: string;
    configDigest: string;
    interpretation: string;
    shortReason: string;
    durationMs: number;
  }): void;
}
export interface HarnessTurnResult {
  publicReply: string;
  committedPublicEvents: { kind: 'scene'; text: string; gameVersion: number }[];
  publicState: ReturnType<GameHarness['publicView']>;
}
export interface RecognizedPhotoInput {
  requestId: string;
  ticket: ReturnType<GameSession['beginPhotos']>;
}

/** Shared game authority. Adapters own input delivery and presentation only. */
export class GameHarness {
  readonly processedPhotos = new Set<string>();
  readonly chargedEvidence = new Map<number, number>();
  readonly correctedEvidence = new Set<string>();
  activeUsage = '';
  runtimeActionId: string | null = null;
  photoAcceptance?: { revision: number; decision: PhotoDecision };
  pendingRisk?: {
    usage: string;
    itemRefs: ExecuteIntent['itemRefs'];
    mode?: ExecuteIntent['mode'];
    environmentTargetIds?: ExecuteIntent['environmentTargetIds'];
    message: string;
    gameVersion: number;
  };
  knowledge?: KnowledgeStore;
  hintEvidence = new Map<string, Set<string>>();

  readonly game: GameSession;
  readonly coreSnapshot: ScenarioSnapshot;
  readonly ledger: ConversationLedger;
  private readonly client: AIResponsesClient;
  private readonly model: string;
  private readonly now: () => number;
  private readonly hooks: HarnessHooks;
  private readonly photoInput: 'images' | 'recognized-text';
  private collecting = false;
  private activeSignal?: AbortSignal;
  private replies: string[] = [];
  private events: HarnessTurnResult['committedPublicEvents'] = [];
  constructor(options: {
    game: GameSession;
    snapshot: ScenarioSnapshot;
    ledger?: ConversationLedger;
    client: AIResponsesClient;
    model: string;
    now?: () => number;
    hooks?: Partial<HarnessHooks>;
    photoInput?: 'images' | 'recognized-text';
    investigationPrompts?: InvestigationPrompts;
  }) {
    this.game = options.game;
    this.photoInput = options.photoInput ?? 'images';
    this.coreSnapshot = options.snapshot;
    this.client = options.client;
    this.model = options.model;
    this.now = options.now ?? (() => performance.now());
    this.ledger =
      options.ledger ?? new ConversationLedger({ generation: this.game.generation, now: this.now });
    this.knowledge = new KnowledgeStore(this.coreSnapshot, options.investigationPrompts);
    this.knowledge.advance(this.game.facts);
    this.hooks = {
      epoch: () => this.game.controllerEpoch,
      disposed: () => false,
      notificationFailed: () => false,
      check: (epoch) => {
        this.game.check();
        if (this.game.terminal || (epoch !== undefined && epoch !== this.game.controllerEpoch))
          throw new GameError(410, 'ACTION_INVALID');
      },
      valid: (epoch) =>
        !this.game.terminal && (epoch === undefined || epoch === this.game.controllerEpoch),
      diagnostic: () => {},
      speak: () => {},
      facts: () => {},
      scene: () => {},
      actionStarted: () => {},
      actionFinished: () => {},
      creditWarning: () => {},
      trace: () => {},
      ...options.hooks,
    };
    this.sync();
  }
  sync(changed = false) {
    this.knowledge!.advance(this.game.facts);
    this.game.controllerEpoch = this.hooks.epoch();
    this.ledger.updateState({
      generation: this.game.generation,
      gameVersion: this.game.gameVersion,
      actionEpoch: this.game.actionEpoch,
      controllerEpoch: this.hooks.epoch(),
      judging: this.game.status === 'judging',
    });
    if (changed) this.ledger.contextChanged();
    this.game.currentContextVersion = this.ledger.captureUnconsumedContext().contextVersion;
  }
  private words(ja: string, en: string) {
    return this.coreSnapshot.locale === 'en' ? en : ja;
  }
  private speak(text: string, delegationId: string | null = null, messageId: string | null = null) {
    if (this.collecting) this.replies.push(text);
    this.hooks.speak(text, delegationId, messageId);
  }
  private presentScene(text: string, messageId: string) {
    if (this.collecting)
      this.events.push({ kind: 'scene', text, gameVersion: this.game.gameVersion });
    this.hooks.scene(text, messageId);
  }
  publicView() {
    const state = this.game.state();
    return {
      status: state.status,
      endReason: state.endReason,
      situation: state.situation,
      obstacle: state.obstacle,
      creditsRemaining: state.creditsRemaining,
      actionsUsed: state.actionsUsed,
      inventory: structuredClone(state.inventory),
      ambience: this.companionContext().ambience,
      knowledge: this.companionContext().knownFacts.map(({ text, currentlyApplicable }) => ({
        text,
        currentlyApplicable,
      })),
      lastResult: state.lastResult
        ? { success: state.lastResult.success, narrative: state.lastResult.narrative }
        : null,
    };
  }
  private result(): HarnessTurnResult {
    return {
      publicReply: this.replies.join('\n'),
      committedPublicEvents: structuredClone(this.events),
      publicState: this.publicView(),
    };
  }
  private async collectTurn(
    work: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<HarnessTurnResult> {
    signal?.throwIfAborted();
    if (this.collecting) throw new GameError(409, 'HARNESS_BUSY');
    this.collecting = true;
    this.activeSignal = signal;
    this.replies = [];
    this.events = [];
    const cancel = () => {
      if (this.game.pendingActionId) this.cancelPending(this.game.pendingActionId);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      await work();
      signal?.throwIfAborted();
      return this.result();
    } finally {
      signal?.removeEventListener('abort', cancel);
      this.collecting = false;
      this.activeSignal = undefined;
      this.replies = [];
      this.events = [];
    }
  }
  private assertContext(context: IntentContext) {
    this.hooks.check(context.controllerEpoch);
    const current = this.ledger.captureUnconsumedContext();
    if (
      context.generation !== this.game.generation ||
      context.gameVersion !== this.game.gameVersion ||
      context.actionEpoch !== this.game.actionEpoch ||
      context.controllerEpoch !== this.hooks.epoch() ||
      context.contextVersion !== current.contextVersion
    )
      throw new GameError(409, 'ACTION_INVALID');
  }
  async handleRequest(context: IntentContext, signal?: AbortSignal): Promise<HarnessTurnResult> {
    return this.collectTurn(async () => {
      this.assertContext(context);
      if (!context.eligibleEvidenceSeq.length) return;
      const decision = await this.classifyRequest(context);
      signal?.throwIfAborted();
      if (decision.kind === 'execute') await this.executeCore(decision, context, null);
      else if (decision.kind === 'consult') {
        this.answerConsult(decision, null);
        this.ledger.consume(decision.evidenceSeq);
      }
      // Classification reasons are diagnostic data, never player-facing prose.
      else if (decision.kind === 'wait')
        this.speak(this.words('もう少し詳しく教えて。', 'Please tell me a little more.'));
    }, signal);
  }
  async handleRecognizedPhoto(
    input: RecognizedPhotoInput,
    signal?: AbortSignal,
  ): Promise<HarnessTurnResult> {
    return this.collectTurn(async () => {
      if (this.processedPhotos.has(input.requestId)) return;
      this.hooks.check();
      if (
        input.ticket.generation !== this.game.generation ||
        this.game.proposal?.inputRevision !== this.game.inputRevision
      )
        throw new GameError(409, 'ACTION_INVALID');
      const beforeVersion = this.game.gameVersion;
      try {
        await this.processPhoto(input.requestId);
        signal?.throwIfAborted();
      } catch (error) {
        if (
          this.game.gameVersion === beforeVersion &&
          !(error instanceof GameError && error.message === 'ACTION_INVALID')
        )
          this.game.credits.cancel(input.ticket.creditId);
        throw error;
      } finally {
        this.game.settleCredits(input.ticket.creditId);
        this.hooks.creditWarning();
      }
    }, signal);
  }
  beginPhotos(count: number) {
    const ticket = this.game.beginPhotos(count);
    this.pendingRisk = undefined;
    this.photoAcceptance = undefined;
    this.sync(true);
    return ticket;
  }
  cancelPending(operationId: string): boolean {
    const cancelled = this.game.cancelPendingAction(operationId);
    this.pendingRisk = undefined;
    this.sync();
    return cancelled;
  }
  async classifyRequest(context: IntentContext): Promise<IntentDecision> {
    this.assertContext(context);
    const decision = await classifyCoreIntent({
      respond: async (body) => {
        this.activeSignal?.throwIfAborted();
        const response = await this.client.respond(body, this.activeSignal);
        this.activeSignal?.throwIfAborted();
        this.assertContext(context);
        return response;
      },
      model: this.model,
      snapshot: this.coreSnapshot,
      validate: () => {
        this.activeSignal?.throwIfAborted();
        this.assertContext(context);
      },
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
        obstacle: this.coreSnapshot.scenarioV2.obstacles[this.game.obstacleIndex],
        facts: this.game.facts,
        inventory: this.game.inventory,
        proposal: this.game.proposal,
        photos: this.game.photos.map((p) => ({ id: p.id })),
      },
      photos: this.game.photos,
      photoInput: this.photoInput,
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
        const item = this.game.proposal?.items.find((item) => item.photoId === correction.photoId);
        if (!item || item.name === correction.name) return;
        item.name = correction.name;
        this.game.inputRevision++;
        this.game.proposal!.inputRevision = this.game.inputRevision;
        this.pendingRisk = undefined;
        this.photoAcceptance = undefined;
        this.sync(true);
      },
    });
    this.hooks.diagnostic('classification_returned', decision.kind);
    return decision;
  }
  async executeCore(
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
      completed = !this.hooks.disposed() && context.controllerEpoch === this.hooks.epoch();
    } finally {
      // A confirmed action remains paid even if its later narration fails.
      if (completed || this.game.gameVersion > before) {
        this.finishConversation(context.generation, intent.evidenceSeq, creditId);
      } else if (creditId) this.game.credits.cancel(creditId);
    }
  }

  async performCoreAction(
    intent: ExecuteIntent,
    context: IntentContext,
    delegationId: string | null,
  ): Promise<void> {
    const coreSnapshot = this.coreSnapshot!;

    this.hooks.check();
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
      this.hooks.check(context.controllerEpoch);
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
        this.speak(decision.message, delegationId);
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
    this.hooks.diagnostic('action_reserving');
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
    if (intent.origin?.kind === 'photo')
      this.speak(this.words('これなら使えそう。やってみる。', 'I can use this. Let me try.'));
    this.pendingRisk = undefined;
    this.hooks.diagnostic('judgment_started');
    const judgmentStarted = this.now();
    const messageId = randomUUID();
    this.hooks.actionStarted(messageId, this.game.gameVersion);
    let result;
    try {
      result = await this.game.judgeAction(ticket);
      this.hooks.diagnostic('judgment_committed');
    } finally {
      if (this.runtimeActionId === ticket.id) {
        this.runtimeActionId = null;
        this.hooks.actionFinished();
      }
      this.sync();
    }
    if (this.hooks.disposed() || context.controllerEpoch !== this.hooks.epoch()) return;
    this.sync();
    this.hooks.trace({
      actionId: ticket.id,
      configDigest: coreSnapshot.digest,
      interpretation: intent.usage.slice(0, 1000),
      shortReason: result.shortReason.slice(0, 1000),
      durationMs: Math.max(0, Math.round(this.now() - judgmentStarted)),
    });
    // Keep private narration direction out of the speakable payload.
    const committedVersion = this.game.gameVersion;
    // Freeze the scene now; a later photo or action must not change this result's picture.
    this.presentScene(result.narrative + '\n' + this.currentSituation(), messageId);
    const spokenResult = this.game.terminal
      ? result.narrative
      : await composeCompanionReply(
          this.modelClient(),
          this.companionContext(),
          result,
          this.knowledge!.prompts,
        ).catch(() => result.narrative);
    if (
      this.hooks.disposed() ||
      context.controllerEpoch !== this.hooks.epoch() ||
      this.game.gameVersion !== committedVersion
    )
      return;
    this.speak(spokenResult, delegationId, messageId);
  }

  modelClient() {
    return {
      respond: async (body: unknown) => {
        this.activeSignal?.throwIfAborted();
        const response = await this.client.respond(body, this.activeSignal);
        this.activeSignal?.throwIfAborted();
        return response;
      },
      model: this.model,
      locale: this.coreSnapshot!.locale,
    };
  }

  private async processPhoto(requestId: string): Promise<void> {
    if (!this.coreSnapshot || !this.ledger || this.processedPhotos.has(requestId)) return;
    if (this.processedPhotos.size >= 100) throw new GameError(429, 'PHOTO_REQUEST_LIMIT');
    this.processedPhotos.add(requestId);
    const epoch = this.hooks.epoch();
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
        !this.hooks.valid(epoch) ||
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
        this.speak(decision.message);
      }
      return;
    }
    this.speak(this.words('届いたよ。どう使おうか？', 'I got it. How should I use it?'));
  }

  companionContext() {
    this.knowledge!.advance(this.game.facts);
    return buildCompanionContext(this.coreSnapshot!, this.knowledge!, this.game.state());
  }

  publicContext() {
    return {
      ...this.companionContext(),
      status: this.game.status,
      creditsRemaining: this.game.credits.remaining,
      recognizedItems: this.game.proposal?.items.map(({ name }) => name) ?? [],
      lastResult: this.game.lastResult,
    };
  }

  currentSituation() {
    return this.words('現在の状況: ', 'Current situation: ') + this.game.situation;
  }

  reserveConversation(generation: number, evidence: number[], free = false): string | null {
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

  finishConversation(generation: number, evidence: number[], id: string | null) {
    if (evidence.length)
      this.chargedEvidence.set(
        generation,
        Math.max(this.chargedEvidence.get(generation) ?? 0, ...evidence),
      );
    if (id) this.game.settleCredits(id);
    this.hooks.creditWarning();
  }

  answerConsult(
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
      this.hooks.facts(this.currentSituation(), delegationId);
      this.speak(decision.answer ?? this.currentSituation(), delegationId);
      if (this.hooks.notificationFailed()) {
        if (id) this.game.credits.cancel(id);
        return;
      }
      this.finishConversation(generation, decision.evidenceSeq, id);
    } catch (error) {
      if (id) this.game.credits.cancel(id);
      throw error;
    }
  }

  hintsAlreadyGiven(context: import('./conversation.js').IntentContext) {
    const evidence = this.hintEvidence.get(this.game.facts.obstacleId);
    const key = `${context.generation}:${context.eligibleEvidenceSeq.join(',')}`;
    return (evidence?.size ?? 0) - (evidence?.has(key) ? 1 : 0);
  }

  recordHintDecision(decision: IntentDecision) {
    if (decision.kind !== 'consult' || !this.ledger || !this.coreSnapshot?.scenarioV2.story) return;
    const context = this.ledger.captureUnconsumedContext();
    context.eligibleEvidenceSeq = decision.evidenceSeq;
    if (!requestsStoryHint(context)) return;
    const obstacleId = this.game.facts.obstacleId;
    const evidence = this.hintEvidence.get(obstacleId) ?? new Set<string>();
    evidence.add(`${context.generation}:${decision.evidenceSeq.join(',')}`);
    this.hintEvidence.set(obstacleId, evidence);
  }
}
