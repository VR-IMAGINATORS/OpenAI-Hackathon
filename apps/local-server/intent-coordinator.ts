import {
  intentDecisionSchema,
  type IntentDecision,
  type ExecuteIntent,
  type DelegationRequest,
} from '../../packages/shared/conversation.js';
import { ConversationLedger, type IntentContext } from './conversation.js';

export interface DelegationInput {
  id: string;
  generation: number;
  offsetMs: number;
}
export interface CoordinatorOptions {
  ledger: ConversationLedger;
  consumeOnReservation?: boolean;
  classify: (
    context: IntentContext,
    delegation: DelegationRequest | null,
  ) => Promise<IntentDecision>;
  execute: (
    intent: ExecuteIntent,
    context: IntentContext,
    delegation: DelegationRequest,
  ) => Promise<void>;
  onDecision?: (decision: IntentDecision, delegation: DelegationRequest) => void;
  onExpired?: (delegation: DelegationRequest) => void;
  onMissingDelegation?: (decision: IntentDecision, context: IntentContext) => void;
  onRecoveryExpired?: (context: IntentContext) => void;
  onError?: (error: unknown) => void;
  now?: () => number;
}

/** One asynchronous worker; event handlers only append and signal, never await it. */
export class IntentCoordinator {
  private readonly requests = new Map<string, DelegationRequest>();
  private readonly requestContexts = new WeakMap<DelegationRequest, IntentContext>();
  private readonly now: () => number;
  private worker?: Promise<void>;
  private dirty = false;
  private stopped = false;
  private epoch = 0;
  private observedKey = '';
  private stableSince = 0;
  private checkedKey = '';
  private expiredEvidence?: { generation: number; through: number };
  private lastExpiryNotice = '';
  private lastRecoveryAt = -Infinity;
  private recovery?: { context: IntentContext; key: string; deadline: number };
  constructor(private readonly options: CoordinatorOptions) {
    this.now = options.now ?? Date.now;
  }

  acceptDelegation(input: DelegationInput): { accepted: boolean; duplicate?: boolean } {
    const context = this.options.ledger.captureUnconsumedContext();
    if (this.stopped || !this.options.ledger.active || input.generation !== context.generation)
      throw new Error('CONVERSATION_INACTIVE');
    if (
      !input.id ||
      input.id.length > 200 ||
      !Number.isSafeInteger(input.offsetMs) ||
      input.offsetMs < 0
    )
      throw new Error('INVALID_DELEGATION');
    const key = `${input.generation}:${input.id}`;
    if (this.requests.has(key)) return { accepted: false, duplicate: true };
    this.expire();
    if (
      this.requests.size >= 100 ||
      this.requests.size + this.options.ledger.eventCount >= 10_000 ||
      [...this.requests.values()].filter((d) => d.status === 'pending' || d.status === 'evaluating')
        .length >= 4
    )
      throw new Error('DELEGATION_LIMIT');
    const at = this.now();
    this.requests.set(key, {
      ...input,
      receivedAt: at,
      deadline: at + 20_000,
      attempts: 0,
      lastEvaluatedContextVersion: null,
      status: this.options.ledger.judging ? 'expired' : 'pending',
    });
    this.requestContexts.set(
      this.requests.get(key)!,
      this.options.ledger.captureUnconsumedContext(),
    );
    this.onContextChanged();
    return { accepted: true };
  }
  onContextChanged(): void {
    this.observeContext();
    this.dirty = true;
    if (this.worker || this.stopped || !this.options.ledger.active) return;
    this.worker = Promise.resolve()
      .then(() => this.run())
      .catch((error) => this.report(error))
      .finally(() => {
        this.worker = undefined;
        if (this.dirty && !this.stopped) this.onContextChanged();
      });
  }
  /** Called by the runtime heartbeat, including when no more Live events arrive. */
  tick(): void {
    if (this.stopped || !this.options.ledger.active) return;
    this.expire();
    this.observeContext();
    if (this.recovery && this.now() >= this.recovery.deadline) {
      const recovery = this.recovery;
      this.recovery = undefined;
      if (!this.hasActiveDelegation() && !this.options.ledger.judging) {
        this.invalidateExpiredEvidence(recovery.context);
        this.notify(() => this.options.onRecoveryExpired?.(recovery.context));
      }
    }
    this.onContextChanged();
  }
  reset(): void {
    this.epoch++;
    this.expireAll();
    this.dirty = false;
    this.recovery = undefined;
    this.observedKey = this.contextKey(this.options.ledger.captureUnconsumedContext());
    this.checkedKey = this.observedKey;
    this.stableSince = this.now();
  }
  stop(): void {
    this.stopped = true;
    this.reset();
  }
  async settled(): Promise<void> {
    while (this.worker) await this.worker;
  }
  snapshot(): DelegationRequest[] {
    this.expire();
    return structuredClone([...this.requests.values()]);
  }
  private report(error: unknown) {
    try {
      this.options.onError?.(error);
    } catch {
      /* Diagnostics must not restart a worker. */
    }
  }
  private notify(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.report(error);
    }
  }
  private contextKey(context: IntentContext): string {
    return `${context.generation}:${context.contextVersion}:${context.controllerEpoch}:${context.gameVersion}:${context.actionEpoch}:${context.eligibleEvidenceSeq.join(',')}`;
  }
  private observeContext(): void {
    const key = this.contextKey(this.options.ledger.captureUnconsumedContext());
    if (key !== this.observedKey) {
      this.observedKey = key;
      this.stableSince = this.now();
      this.recovery = undefined;
    }
    if (this.hasActiveDelegation()) this.recovery = undefined;
  }
  private hasActiveDelegation(): boolean {
    return [...this.requests.values()].some(
      (d) => d.status === 'pending' || d.status === 'evaluating',
    );
  }
  /** Timeout invalidates only the evaluated prefix, never a later user correction. */
  private invalidateExpiredEvidence(context: IntentContext): void {
    const current = this.options.ledger.captureUnconsumedContext();
    if (current.generation !== context.generation) return;
    const through = Math.max(0, ...context.eligibleEvidenceSeq);
    this.expiredEvidence = { generation: context.generation, through };
    const remaining = context.eligibleEvidenceSeq.filter((seq) =>
      current.eligibleEvidenceSeq.includes(seq),
    );
    if (remaining.length) this.options.ledger.consume(remaining);
  }
  private markExpired(d: DelegationRequest): void {
    d.status = 'expired';
    const current = this.options.ledger.captureUnconsumedContext();
    if (current.generation !== d.generation) return;
    const context = this.requestContexts.get(d) ?? current;
    this.invalidateExpiredEvidence(context);
    this.recovery = undefined;
    const noticeKey = `${context.generation}:${Math.max(0, ...context.eligibleEvidenceSeq)}`;
    if (noticeKey === this.lastExpiryNotice) return;
    this.lastExpiryNotice = noticeKey;
    this.notify(() => this.options.onExpired?.(structuredClone(d)));
  }
  private expire() {
    for (const d of this.requests.values())
      if (
        (d.status === 'pending' || d.status === 'evaluating') &&
        (this.now() >= d.deadline || (d.attempts >= 3 && d.status !== 'evaluating'))
      )
        this.markExpired(d);
  }
  private expireAll() {
    for (const d of this.requests.values())
      if (d.status === 'pending' || d.status === 'evaluating') d.status = 'expired';
  }
  private async checkMissingDelegation(context: IntentContext): Promise<void> {
    const key = this.contextKey(context);
    if (
      this.hasActiveDelegation() ||
      key === this.checkedKey ||
      (this.expiredEvidence?.generation === context.generation &&
        !context.eligibleEvidenceSeq.some((seq) => seq > this.expiredEvidence!.through)) ||
      this.now() - this.stableSince < 3_000 ||
      this.now() - this.lastRecoveryAt < 10_000
    )
      return;
    this.checkedKey = key;
    this.lastRecoveryAt = this.now();
    const epoch = this.epoch;
    let decision: IntentDecision;
    try {
      // null is an app-owned read-only check, never a fabricated Live delegation.
      decision = intentDecisionSchema.parse(await this.options.classify(context, null));
    } catch (error) {
      if (
        !this.stopped &&
        this.options.ledger.active &&
        epoch === this.epoch &&
        !this.options.ledger.judging &&
        !this.hasActiveDelegation() &&
        this.contextKey(this.options.ledger.captureUnconsumedContext()) === key
      )
        this.report(error);
      return;
    }
    const current = this.options.ledger.captureUnconsumedContext();
    if (
      this.stopped ||
      !this.options.ledger.active ||
      epoch !== this.epoch ||
      this.options.ledger.judging ||
      this.hasActiveDelegation() ||
      this.contextKey(current) !== key
    )
      return;
    if (
      decision.kind !== 'wait' &&
      !decision.evidenceSeq.every((seq) => current.eligibleEvidenceSeq.includes(seq))
    )
      return;
    // Consultation and unfinished speech are not stalled actions. Never consume evidence here.
    if (decision.kind === 'execute')
      this.recovery = { context, key, deadline: this.now() + 20_000 };
    this.notify(() => this.options.onMissingDelegation?.(decision, context));
  }
  private async run(): Promise<void> {
    while (!this.stopped && this.options.ledger.active) {
      this.dirty = false;
      this.expire();
      const ledger = this.options.ledger;
      if (ledger.judging) return;
      const context = ledger.captureUnconsumedContext();
      if (!context.eligibleEvidenceSeq.length) return;
      const d = [...this.requests.values()].find(
        (d) =>
          d.status === 'pending' &&
          d.generation === context.generation &&
          d.attempts < 3 &&
          d.lastEvaluatedContextVersion !== context.contextVersion,
      );
      if (!d) {
        await this.checkMissingDelegation(context);
        if (this.dirty) continue;
        return;
      }
      const epoch = this.epoch;
      d.status = 'evaluating';
      this.requestContexts.set(d, context);
      d.attempts++;
      d.lastEvaluatedContextVersion = context.contextVersion;
      let decision: IntentDecision;
      try {
        decision = intentDecisionSchema.parse(
          await this.options.classify(context, structuredClone(d)),
        );
      } catch (error) {
        if (
          !this.stopped &&
          ledger.active &&
          epoch === this.epoch &&
          d.status === 'evaluating' &&
          this.now() < d.deadline &&
          this.contextKey(ledger.captureUnconsumedContext()) === this.contextKey(context)
        )
          this.report(error);
        decision = { kind: 'wait', reason: 'classification unavailable' };
      }
      if (this.stopped || !ledger.active || epoch !== this.epoch || d.status !== 'evaluating')
        continue;
      if (this.now() >= d.deadline) {
        this.markExpired(d);
        continue;
      }
      d.status = 'pending';
      const current = ledger.captureUnconsumedContext();
      if (
        ledger.judging ||
        current.contextVersion !== context.contextVersion ||
        current.generation !== context.generation ||
        current.gameVersion !== context.gameVersion ||
        current.actionEpoch !== context.actionEpoch ||
        current.controllerEpoch !== context.controllerEpoch
      )
        continue;
      if (
        decision.kind !== 'wait' &&
        !decision.evidenceSeq.every((seq) => current.eligibleEvidenceSeq.includes(seq))
      )
        continue;
      if (decision.kind === 'wait') {
        this.options.onDecision?.(decision, structuredClone(d));
        continue;
      }
      if (decision.kind === 'consult' || !this.options.consumeOnReservation)
        ledger.consume(decision.evidenceSeq);
      if (decision.kind === 'consult') {
        d.status = 'consulted';
        this.options.onDecision?.(decision, structuredClone(d));
        continue;
      }
      d.status = 'reserved';
      if (!this.options.consumeOnReservation) ledger.updateState({ judging: true });
      try {
        this.options.onDecision?.(decision, structuredClone(d));
        await this.options.execute(decision, context, structuredClone(d));
      } catch (error) {
        if (
          !this.stopped &&
          ledger.active &&
          epoch === this.epoch &&
          ledger.captureUnconsumedContext().generation === context.generation
        )
          this.report(error);
      } finally {
        // Keep later correction delegations; they may target a replacement action.
        for (const pending of this.requests.values()) {
          if (
            (pending.status === 'pending' || pending.status === 'evaluating') &&
            pending.receivedAt <= d.receivedAt
          )
            pending.status = 'expired';
        }
        if (
          !this.options.consumeOnReservation &&
          ledger.active &&
          ledger.captureUnconsumedContext().generation === context.generation
        )
          ledger.updateState({ judging: false });
      }
    }
  }
}
