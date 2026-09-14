import { performance } from 'node:perf_hooks';

export type ProviderFailureCode =
  | 'API_ERROR'
  | 'API_TIMEOUT'
  | 'MODEL_UNAVAILABLE'
  | 'OUTPUT_INVALID'
  | 'BUDGET_EXCEEDED'
  | 'INTERRUPTED';
export class MissionProviderError extends Error {
  constructor(
    public readonly code: ProviderFailureCode,
    public readonly detail: string = code,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'MissionProviderError';
  }
}
export interface BudgetLimits {
  maxApiCalls: number;
  maxOutputTokensTotal: number;
  deadlineSeconds: number;
  requestTimeoutSeconds: number;
}
export interface Reservation {
  id: number;
  maxOutputTokens: number;
}

/** Reservations occur synchronously, before any transport work can start. */
export class Budget {
  private readonly started: number;
  private readonly now: () => number;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly pending = new Map<number, number>();
  private callCount = 0;
  private chargedTokens = 0;
  private unknownCalls = 0;
  readonly signal = this.controller.signal;
  constructor(
    readonly limits: BudgetLimits,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? (() => performance.now());
    this.started = this.now();
    this.timer = setTimeout(
      () => this.abort(new MissionProviderError('API_TIMEOUT', 'global_deadline')),
      limits.deadlineSeconds * 1000,
    );
    this.timer.unref();
  }
  remainingMs(): number {
    return Math.max(0, this.limits.deadlineSeconds * 1000 - (this.now() - this.started));
  }
  assertActive(): void {
    if (this.signal.aborted)
      throw this.signal.reason instanceof MissionProviderError
        ? this.signal.reason
        : new MissionProviderError('INTERRUPTED');
    if (this.remainingMs() <= 0) throw new MissionProviderError('API_TIMEOUT', 'global_deadline');
  }
  reserve(maxOutputTokens: number): Reservation {
    this.assertActive();
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0)
      throw new MissionProviderError('BUDGET_EXCEEDED', 'invalid_reservation');
    if (
      this.callCount >= this.limits.maxApiCalls ||
      this.chargedTokens + maxOutputTokens > this.limits.maxOutputTokensTotal
    )
      throw new MissionProviderError('BUDGET_EXCEEDED');
    const id = ++this.callCount;
    this.chargedTokens += maxOutputTokens;
    this.pending.set(id, maxOutputTokens);
    return { id, maxOutputTokens };
  }
  settle(reservation: Reservation, outputTokens: number | null): void {
    const reserved = this.pending.get(reservation.id);
    if (reserved === undefined) return;
    this.pending.delete(reservation.id);
    if (outputTokens === null || !Number.isSafeInteger(outputTokens) || outputTokens < 0) {
      this.unknownCalls++;
      return;
    }
    this.chargedTokens += outputTokens - reserved;
    if (outputTokens > reserved || this.chargedTokens > this.limits.maxOutputTokensTotal)
      this.abort(
        new MissionProviderError('BUDGET_EXCEEDED', 'upstream_usage_exceeded_reservation'),
      );
  }
  snapshot() {
    return {
      callCount: this.callCount,
      chargedOutputTokens: this.chargedTokens,
      unknownUsageCalls: this.unknownCalls,
      pendingCalls: this.pending.size,
      elapsedMs: this.now() - this.started,
      remainingMs: this.remainingMs(),
    };
  }
  abort(reason: unknown = new MissionProviderError('INTERRUPTED')): void {
    this.controller.abort(
      reason instanceof MissionProviderError ? reason : new MissionProviderError('INTERRUPTED'),
    );
  }
  close(): void {
    clearTimeout(this.timer);
  }
}
