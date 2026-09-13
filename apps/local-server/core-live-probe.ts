/** Isolated P0 experiment. No production route imports this module. */
export interface ProbeTranscriptInput {
  eventId: string;
  generation: number;
  speaker: 'user' | 'assistant';
  delta: string;
  startMs: number;
  endMs: number;
}
export interface ProbeFragment extends ProbeTranscriptInput {
  serverSeq: number;
  executionEligible: boolean;
  receivedGameVersion: number;
}
export type ProbeDecision =
  | { kind: 'wait'; reason: string }
  | { kind: 'consult'; evidenceSeq: number[]; reason: string }
  | { kind: 'execute'; evidenceSeq: number[]; itemRefs: string[]; usage: string; reason: string };
export interface ProbeContext {
  locale: 'ja' | 'en';
  generation: number;
  contextVersion: number;
  gameVersion: number;
  photo: { id: 'photo-1'; description: string };
  obstacle: 'rope-intact';
  fragments: ProbeFragment[];
  eligibleEvidenceSeq: number[];
  delegation: { id: string; offsetMs: number };
}
export interface ProbeTicket {
  id: string;
  delegationId: string;
  intent: Extract<ProbeDecision, { kind: 'execute' }>;
  gameVersion: number;
  acceptedAt: number;
}
export type ProbeAction = ProbeTicket & {
  status: 'pending' | 'committed' | 'failed';
  success?: boolean;
  reason?: string;
};
export interface ProbeOptions {
  locale: 'ja' | 'en';
  photoDescription?: string;
  classify: (context: ProbeContext) => Promise<ProbeDecision>;
  judge?: (ticket: ProbeTicket) => Promise<{ success: boolean; reason: string }>;
  now?: () => number;
}
interface Delegation {
  id: string;
  generation: number;
  offsetMs: number;
  decision?: ProbeDecision;
  receivedAt: number;
  attempts: number;
  lastContextVersion: number;
  status: 'pending' | 'evaluating' | 'consulted' | 'reserved' | 'expired';
}
export interface ProbeMeasurement {
  delegationId: string;
  event: 'delegation' | 'classification' | 'reservation' | 'commit' | 'failure';
  at: number;
  contextVersion: number;
}

export class CoreLiveProbe {
  private readonly now: () => number;
  private readonly fragments: ProbeFragment[] = [];
  private readonly delegations = new Map<string, Delegation>();
  private readonly eventIds = new Set<string>();
  private readonly handled = new Set<number>();
  private readonly actions: ProbeAction[] = [];
  private readonly measurements: ProbeMeasurement[] = [];
  private contextVersion = 0;
  private gameVersion = 0;
  private bytes = 0;
  private judging = false;
  private audioBoundary = -1;
  private worker: Promise<void> | undefined;
  private stopped = false;
  private readonly generation = 1;

  constructor(private readonly options: ProbeOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Does not await classification or judgment. The HTTP adapter can return 202 now. */
  acceptTranscript(input: ProbeTranscriptInput): { accepted: boolean; duplicate?: boolean } {
    this.validateGeneration(input.generation);
    if (this.eventIds.has(input.eventId)) return { accepted: false, duplicate: true };
    if (
      !input.eventId ||
      !['user', 'assistant'].includes(input.speaker) ||
      !input.delta.length ||
      !Number.isFinite(input.startMs) ||
      !Number.isFinite(input.endMs) ||
      input.startMs < 0 ||
      input.endMs < input.startMs
    )
      throw new Error('INVALID_TRANSCRIPT');
    const bytes = Buffer.byteLength(input.delta);
    if (this.eventIds.size + this.delegations.size >= 10_000 || this.bytes + bytes > 64 * 1024)
      throw new Error('PROBE_LIMIT');
    this.eventIds.add(input.eventId);
    this.bytes += bytes;
    this.fragments.push({
      ...input,
      serverSeq: this.fragments.length + 1,
      receivedGameVersion: this.gameVersion,
      executionEligible:
        input.speaker === 'user' && !this.judging && input.startMs > this.audioBoundary,
    });
    if (input.speaker === 'user') {
      this.contextVersion++;
      // Keep a permanent cutoff for audio known to belong to the action being judged.
      if (this.judging) this.audioBoundary = Math.max(this.audioBoundary, input.endMs);
      this.schedule();
    }
    return { accepted: true };
  }

  acceptDelegation(input: { id: string; generation: number; offsetMs: number }): {
    accepted: boolean;
    duplicate?: boolean;
  } {
    this.validateGeneration(input.generation);
    if (this.delegations.has(input.id)) return { accepted: false, duplicate: true };
    if (!input.id || !Number.isFinite(input.offsetMs) || input.offsetMs < 0)
      throw new Error('INVALID_DELEGATION');
    this.expire();
    if (
      this.delegations.size >= 100 ||
      this.eventIds.size + this.delegations.size >= 10_000 ||
      [...this.delegations.values()].filter(
        (d) => d.status === 'pending' || d.status === 'evaluating',
      ).length >= 4
    )
      throw new Error('PROBE_LIMIT');
    const d: Delegation = {
      ...input,
      receivedAt: this.now(),
      attempts: 0,
      lastContextVersion: -1,
      status: this.judging ? 'expired' : 'pending',
    };
    this.delegations.set(d.id, d);
    this.measure(d.id, 'delegation');
    this.schedule();
    return { accepted: true };
  }

  snapshot() {
    this.expire();
    return structuredClone({
      generation: this.generation,
      contextVersion: this.contextVersion,
      gameVersion: this.gameVersion,
      judging: this.judging,
      fragments: this.fragments,
      delegations: [...this.delegations.values()],
      actions: this.actions,
      measurements: this.measurements,
    });
  }

  /** Test/CLI flush only. Never use this in the event HTTP handler. */
  async settled(): Promise<void> {
    while (this.worker) await this.worker;
  }

  stop(): void {
    this.stopped = true;
    for (const d of this.delegations.values())
      if (d.status === 'pending' || d.status === 'evaluating') d.status = 'expired';
  }

  private validateGeneration(generation: number) {
    if (this.stopped || generation !== this.generation) throw new Error('PROBE_INACTIVE');
  }
  private measure(delegationId: string, event: ProbeMeasurement['event']) {
    this.measurements.push({
      delegationId,
      event,
      at: this.now(),
      contextVersion: this.contextVersion,
    });
  }
  private expire() {
    for (const d of this.delegations.values()) {
      if (
        (d.status === 'pending' || d.status === 'evaluating') &&
        this.now() - d.receivedAt >= 20_000
      )
        d.status = 'expired';
    }
  }
  private eligible() {
    return this.fragments.filter(
      (f) =>
        f.speaker === 'user' &&
        f.delta.trim().length > 0 &&
        f.executionEligible &&
        !this.handled.has(f.serverSeq) &&
        f.receivedGameVersion === this.gameVersion,
    );
  }
  private schedule() {
    if (this.worker || this.stopped) return;
    this.worker = Promise.resolve()
      .then(() => this.run())
      .finally(() => {
        this.worker = undefined;
      });
  }
  private async run() {
    while (!this.stopped) {
      this.expire();
      const eligible = this.eligible();
      if (!eligible.length || this.judging) return;
      const d = [...this.delegations.values()].find(
        (d) =>
          d.status === 'pending' && d.attempts < 3 && d.lastContextVersion !== this.contextVersion,
      );
      if (!d) return;
      const contextVersion = this.contextVersion;
      const gameVersion = this.gameVersion;
      const context: ProbeContext = {
        locale: this.options.locale,
        generation: this.generation,
        contextVersion,
        gameVersion,
        photo: {
          id: 'photo-1',
          description:
            this.options.photoDescription ??
            'uploaded photo; identify ordinary properties from the image',
        },
        obstacle: 'rope-intact',
        fragments: structuredClone(this.fragments),
        eligibleEvidenceSeq: eligible.map((f) => f.serverSeq),
        delegation: { id: d.id, offsetMs: d.offsetMs },
      };
      d.status = 'evaluating';
      d.attempts++;
      d.lastContextVersion = contextVersion;
      let decision: ProbeDecision;
      try {
        decision = await this.options.classify(context);
      } catch {
        decision = { kind: 'wait', reason: 'classification unavailable' };
      }
      this.measure(d.id, 'classification');
      this.expire();
      if (this.stopped || this.now() - d.receivedAt >= 20_000) continue;
      d.status = 'pending';
      if (contextVersion !== this.contextVersion || gameVersion !== this.gameVersion) continue;
      if (decision?.kind === 'wait') d.decision = structuredClone(decision);
      if (
        !decision ||
        decision.kind === 'wait' ||
        !('evidenceSeq' in decision) ||
        !Array.isArray(decision.evidenceSeq) ||
        !decision.evidenceSeq.length ||
        new Set(decision.evidenceSeq).size !== decision.evidenceSeq.length ||
        !decision.evidenceSeq.every((seq) => context.eligibleEvidenceSeq.includes(seq))
      )
        continue;
      if (decision.kind === 'consult') {
        d.decision = structuredClone(decision);
        decision.evidenceSeq.forEach((seq) => this.handled.add(seq));
        d.status = 'consulted';
        continue;
      }
      if (
        decision.kind !== 'execute' ||
        !this.options.judge ||
        !Array.isArray(decision.itemRefs) ||
        decision.itemRefs.length !== 1 ||
        decision.itemRefs[0] !== 'photo-1' ||
        typeof decision.usage !== 'string' ||
        !decision.usage.trim()
      )
        continue;
      d.decision = structuredClone(decision);
      // Reservation is synchronous; later inputs can never mutate this ticket.
      decision.evidenceSeq.forEach((seq) => this.handled.add(seq));
      d.status = 'reserved';
      this.judging = true;
      this.audioBoundary = Math.max(
        this.audioBoundary,
        ...this.fragments.filter((f) => f.speaker === 'user').map((f) => f.endMs),
      );
      const ticket = {
        id: `probe-action-${this.actions.length + 1}`,
        delegationId: d.id,
        intent: structuredClone(decision),
        gameVersion,
        acceptedAt: this.now(),
        status: 'pending' as const,
      };
      const action: ProbeAction = ticket;
      this.actions.push(action);
      this.measure(d.id, 'reservation');
      try {
        const judgment = await this.options.judge(structuredClone(ticket));
        if (this.stopped || typeof judgment.success !== 'boolean')
          throw new Error('STALE_JUDGMENT');
        action.status = 'committed';
        action.success = judgment.success;
        action.reason = judgment.reason;
        this.gameVersion++;
        this.measure(d.id, 'commit');
      } catch {
        action.status = 'failed';
        this.measure(d.id, 'failure');
      } finally {
        this.judging = false;
        // No queued request may reinterpret old-state speech after this action.
        for (const pending of this.delegations.values())
          if (pending.status === 'pending' || pending.status === 'evaluating')
            pending.status = 'expired';
      }
    }
  }
}
