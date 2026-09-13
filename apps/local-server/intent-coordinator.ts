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
  classify: (context: IntentContext, delegation: DelegationRequest) => Promise<IntentDecision>;
  execute: (
    intent: ExecuteIntent,
    context: IntentContext,
    delegation: DelegationRequest,
  ) => Promise<void>;
  onDecision?: (decision: IntentDecision, delegation: DelegationRequest) => void;
  onError?: (error: unknown) => void;
  now?: () => number;
}

/** One asynchronous worker; event handlers only append and signal, never await it. */
export class IntentCoordinator {
  private readonly requests = new Map<string, DelegationRequest>();
  private readonly now: () => number;
  private worker?: Promise<void>;
  private dirty = false;
  private stopped = false;
  private epoch = 0;
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
    this.onContextChanged();
    return { accepted: true };
  }
  onContextChanged(): void {
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
  reset(): void {
    this.epoch++;
    this.expireAll();
    this.dirty = false;
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
  private expire() {
    for (const d of this.requests.values())
      if (
        (d.status === 'pending' || d.status === 'evaluating') &&
        (this.now() >= d.deadline || (d.attempts >= 3 && d.status !== 'evaluating'))
      )
        d.status = 'expired';
  }
  private expireAll() {
    for (const d of this.requests.values())
      if (d.status === 'pending' || d.status === 'evaluating') d.status = 'expired';
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
      if (!d) return;
      const epoch = this.epoch;
      d.status = 'evaluating';
      d.attempts++;
      d.lastEvaluatedContextVersion = context.contextVersion;
      let decision: IntentDecision;
      try {
        decision = intentDecisionSchema.parse(
          await this.options.classify(context, structuredClone(d)),
        );
      } catch (error) {
        this.report(error);
        decision = { kind: 'wait', reason: 'classification unavailable' };
      }
      if (this.stopped || !ledger.active || epoch !== this.epoch || d.status !== 'evaluating')
        continue;
      if (this.now() >= d.deadline) {
        d.status = 'expired';
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
      ledger.consume(decision.evidenceSeq);
      if (decision.kind === 'consult') {
        d.status = 'consulted';
        this.options.onDecision?.(decision, structuredClone(d));
        continue;
      }
      d.status = 'reserved';
      ledger.updateState({ judging: true });
      try {
        this.options.onDecision?.(decision, structuredClone(d));
        await this.options.execute(decision, context, structuredClone(d));
      } catch (error) {
        this.report(error);
      } finally {
        // Failure still consumes evidence. No old-state speech or delegation is queued.
        this.expireAll();
        if (ledger.active && ledger.captureUnconsumedContext().generation === context.generation)
          ledger.updateState({ judging: false });
      }
    }
  }
}
