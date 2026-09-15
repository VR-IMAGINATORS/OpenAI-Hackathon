import { randomUUID } from 'node:crypto';
import type { VoiceActivity, WarningPolicy } from '../../packages/shared/harness.js';

export type VoiceNoticeKind =
  | 'ending'
  | 'correction'
  | 'final-warning'
  | 'result'
  | 'normal-warning';
export interface PendingVoiceNotice<T> {
  id: string;
  kind: VoiceNoticeKind;
  generation: number;
  payload: T;
  validUntil?: number;
  includesTimeWarning?: boolean;
}
interface QueuedNotice<T> extends PendingVoiceNotice<T> {
  milestoneId?: string;
  waitUntil?: number;
  expiresAt?: number;
  interruptPayload?: T;
}
const priority: Record<VoiceNoticeKind, number> = {
  ending: 0,
  correction: 1,
  'final-warning': 2,
  result: 3,
  'normal-warning': 4,
};

/** Advisory audio telemetry only affects presentation, never the game clock or outcome. */
export class VoiceNotificationScheduler<T> {
  private generation = 0;
  private activity: { value: VoiceActivity; receivedAt: number } | null = null;
  private pending: QueuedNotice<T>[] = [];
  private delivered = new Set<string>();
  private ended = false;
  constructor(
    private policy: WarningPolicy,
    private now: () => number = () => performance.now(),
    private wallNow: () => number = Date.now,
    private combineWarningWithResult?: (warning: T, result: T) => T,
  ) {}

  reset(generation: number) {
    this.generation = generation;
    this.activity = null;
    this.pending = [];
  }
  report(value: VoiceActivity): boolean {
    if (
      value.generation !== this.generation ||
      (this.activity && value.sequence <= this.activity.value.sequence)
    )
      return false;
    this.activity = { value: { ...value }, receivedAt: this.now() };
    return true;
  }
  enqueue(notice: PendingVoiceNotice<T>) {
    if (notice.generation !== this.generation) return false;
    if (notice.kind === 'ending') this.endWarnings();
    if (this.pending.some((entry) => entry.id === notice.id)) return false;
    if (this.pending.length >= 128) throw new Error('VOICE_NOTICE_CAPACITY');
    this.pending.push({ ...notice });
    return true;
  }
  updateWarnings(remainingMs: number, locale: 'ja' | 'en', makePayload: (text: string) => T) {
    if (remainingMs <= 0) {
      this.endWarnings();
      return;
    }
    if (this.ended || !this.policy.enabled || this.generation < 1) return;
    const reached = this.policy.milestones.filter(
      (entry) => remainingMs <= entry.thresholdSeconds * 1000,
    );
    const milestone = reached.at(-1);
    if (!milestone) return;
    // A newer milestone supersedes older pending warnings, not committed results.
    for (const earlier of reached.slice(0, -1)) this.delivered.add(earlier.id);
    this.pending = this.pending.filter(
      (entry) => !entry.milestoneId || entry.milestoneId === milestone.id,
    );
    if (
      this.delivered.has(milestone.id) ||
      this.pending.some((entry) => entry.milestoneId === milestone.id)
    )
      return;
    const format = (text: string) =>
      text.replaceAll('{thresholdSeconds}', String(milestone.thresholdSeconds));
    const now = this.now();
    const nextMilestone = this.policy.milestones[this.policy.milestones.indexOf(milestone) + 1];
    const validityMs = Math.max(0, remainingMs - (nextMilestone?.thresholdSeconds ?? 0) * 1000);
    this.pending.push({
      id: randomUUID(),
      kind: milestone.kind === 'final' ? 'final-warning' : 'normal-warning',
      generation: this.generation,
      milestoneId: milestone.id,
      payload: makePayload(format(milestone.message[locale])),
      interruptPayload: makePayload(format(milestone.transitionMessage[locale])),
      waitUntil: milestone.kind === 'final' ? now + (milestone.maxWaitMs ?? 0) : undefined,
      expiresAt: now + validityMs,
      validUntil: Math.floor(this.wallNow() + validityMs),
    });
  }
  takeNext(): PendingVoiceNotice<T> | null {
    const now = this.now();
    this.pending = this.pending.filter(
      (entry) =>
        entry.generation === this.generation &&
        (entry.expiresAt === undefined || now < entry.expiresAt),
    );
    this.pending.sort((a, b) => priority[a.kind] - priority[b.kind]);
    const next = this.pending[0];
    if (!next) return null;
    const warning = next.kind === 'normal-warning' || next.kind === 'final-warning';
    const quiet = this.isQuiet(now);
    if (warning && !quiet && (next.waitUntil === undefined || now < next.waitUntil)) return null;
    const pairedWarning =
      next.kind === 'final-warning'
        ? next
        : next.kind === 'result' && quiet
          ? this.pending.find((entry) => entry.kind === 'normal-warning')
          : undefined;
    if (pairedWarning && this.combineWarningWithResult) {
      const result =
        next.kind === 'result' ? next : this.pending.find((entry) => entry.kind === 'result');
      if (result) {
        const warningPayload = quiet
          ? pairedWarning.payload
          : (pairedWarning.interruptPayload ?? pairedWarning.payload);
        // Compose before removing either entry, so a formatter failure loses neither.
        const payload = this.combineWarningWithResult(warningPayload, result.payload);
        this.pending = this.pending.filter((entry) => entry !== result && entry !== pairedWarning);
        if (pairedWarning.milestoneId) this.delivered.add(pairedWarning.milestoneId);
        // Expiry was checked immediately above. Do not expire the committed result
        // merely because it now contains the currently valid warning as well.
        return {
          id: result.id,
          kind: 'result',
          generation: result.generation,
          payload,
          includesTimeWarning: true,
        };
      }
    }
    this.pending.shift();
    if (next.milestoneId) this.delivered.add(next.milestoneId);
    return {
      id: next.id,
      kind: next.kind,
      generation: next.generation,
      payload: warning && !quiet ? (next.interruptPayload ?? next.payload) : next.payload,
      ...(next.validUntil === undefined ? {} : { validUntil: next.validUntil }),
    };
  }
  endWarnings() {
    this.ended = true;
    this.pending = this.pending.filter(
      (entry) => entry.kind !== 'normal-warning' && entry.kind !== 'final-warning',
    );
  }
  clear() {
    this.pending = [];
    this.activity = null;
  }
  private isQuiet(now: number) {
    const activity = this.activity;
    // Browser quiet already requires 800ms continuously sampled silence on each side.
    return (
      !!activity &&
      now - activity.receivedAt < 2000 &&
      activity.value.playbackReady &&
      activity.value.input === 'quiet' &&
      activity.value.output === 'quiet'
    );
  }
}
