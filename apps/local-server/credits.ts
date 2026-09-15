import type { CreditCharge, CreditKind } from '../../packages/shared/credits.js';

/** Server-owned reservations. Provider retries never create another charge. */
export class GameCredits {
  private entries = new Map<string, { amount: number; kind: CreditKind; pending: boolean }>();
  private spent = 0;
  private sequence = 0;
  lastCharge: CreditCharge | null = null;
  constructor(readonly initial: number) {}

  get remaining() {
    return (
      this.initial -
      this.spent -
      [...this.entries.values()]
        .filter((entry) => entry.pending)
        .reduce((sum, entry) => sum + entry.amount, 0)
    );
  }
  get pending() {
    return [...this.entries.values()].some((entry) => entry.pending);
  }
  reserve(id: string, kind: CreditKind, amount: number): boolean {
    const previous = this.entries.get(id);
    if (previous) return previous.amount === amount && previous.kind === kind;
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > this.remaining) return false;
    this.entries.set(id, { amount, kind, pending: true });
    return true;
  }
  settle(id: string) {
    const entry = this.entries.get(id);
    if (!entry?.pending) return;
    entry.pending = false;
    this.spent += entry.amount;
    this.lastCharge = { sequence: ++this.sequence, kind: entry.kind, amount: entry.amount };
  }
  cancel(id: string) {
    if (this.entries.get(id)?.pending) this.entries.delete(id);
  }
  cancelPending() {
    for (const [id, entry] of this.entries) if (entry.pending) this.entries.delete(id);
  }
}
