import {
  transcriptFragmentSchema,
  type TranscriptFragment,
} from '../../packages/shared/conversation.js';

export interface TranscriptInput {
  eventId: string;
  generation: number;
  speaker: 'user' | 'assistant';
  delta: string;
  startMs: number;
  endMs: number;
}
export interface ConversationState {
  generation: number;
  gameVersion: number;
  actionEpoch: number;
  controllerEpoch: number;
  judging: boolean;
}
export interface IntentContext extends Omit<ConversationState, 'judging'> {
  contextVersion: number;
  fragments: TranscriptFragment[];
  eligibleEvidenceSeq: number[];
}

/** Original speech only. Display grouping must never mutate this evidence ledger. */
export class ConversationLedger {
  private state: ConversationState;
  private fragments: TranscriptFragment[] = [];
  private readonly handled = new Set<number>();
  private readonly ids = new Map<string, TranscriptFragment>();
  private bytes = 0;
  private version = 0;
  private sequence = 0;
  private stopped = false;
  private audioCutoff = -1;
  private latestAudio = -1;
  private latestAudioAt = 0;
  private readonly now: () => number;

  constructor(options: { generation: number; now?: () => number }) {
    this.now = options.now ?? Date.now;
    this.state = {
      generation: options.generation,
      gameVersion: 0,
      actionEpoch: 0,
      controllerEpoch: 0,
      judging: false,
    };
  }
  get contextVersion() {
    return this.version;
  }
  get judging() {
    return this.state.judging;
  }
  get active() {
    return !this.stopped;
  }
  get eventCount() {
    return this.fragments.length;
  }

  append(input: TranscriptInput): TranscriptFragment | null {
    if (this.stopped || input.generation !== this.state.generation)
      throw new Error('CONVERSATION_INACTIVE');
    const parsed = transcriptFragmentSchema.parse({
      ...input,
      serverSeq: this.sequence + 1,
      receivedGameVersion: this.state.gameVersion,
      executionEligible:
        input.speaker === 'user' && !this.state.judging && input.startMs > this.audioCutoff,
    });
    const key = `${input.generation}:${input.eventId}`;
    if (this.ids.has(key)) return null;
    const size = Buffer.byteLength(input.delta, 'utf8');
    if (this.fragments.length >= 10_000 || this.bytes + size > 64 * 1024)
      throw new Error('CONVERSATION_LIMIT');
    this.sequence++;
    this.bytes += size;
    this.fragments.push(parsed);
    this.ids.set(key, parsed);
    if (input.speaker === 'user') {
      this.version++;
      if (input.endMs > this.latestAudio) {
        this.latestAudio = input.endMs;
        this.latestAudioAt = this.now();
      }
      if (this.state.judging) this.audioCutoff = Math.max(this.audioCutoff, input.endMs);
    }
    return structuredClone(parsed);
  }

  updateState(next: Partial<ConversationState>): void {
    const previous = this.state;
    const merged = { ...previous, ...next };
    if (merged.generation !== previous.generation) {
      this.fragments = [];
      this.ids.clear();
      this.handled.clear();
      this.bytes = 0;
      this.audioCutoff = -1;
      this.latestAudio = -1;
      this.latestAudioAt = 0;
    }
    // Live offsets are not authoritative turn boundaries. Conservatively exclude the
    // whole known/ambiguous audio interval around a judgment, including late delivery.
    if (merged.generation === previous.generation && (previous.judging || merged.judging)) {
      const estimatedAudio =
        this.latestAudio < 0 ? -1 : this.latestAudio + Math.max(0, this.now() - this.latestAudioAt);
      this.audioCutoff = Math.max(this.audioCutoff, estimatedAudio);
    }
    if (
      merged.generation !== previous.generation ||
      merged.gameVersion !== previous.gameVersion ||
      merged.actionEpoch !== previous.actionEpoch ||
      merged.controllerEpoch !== previous.controllerEpoch
    )
      this.version++;
    this.state = merged;
  }
  /** Photo replacement or control changes invalidate an in-flight classification. */
  contextChanged(): void {
    this.version++;
  }
  captureUnconsumedContext(): IntentContext {
    const { judging: _judging, ...state } = this.state;
    return {
      ...state,
      contextVersion: this.version,
      fragments: structuredClone(this.fragments),
      eligibleEvidenceSeq: this.fragments
        .filter(
          (f) =>
            f.speaker === 'user' &&
            f.delta.trim() &&
            f.executionEligible &&
            !this.handled.has(f.serverSeq) &&
            f.receivedGameVersion === state.gameVersion,
        )
        .map((f) => f.serverSeq),
    };
  }
  /** Only actual speech received during this game's pending action may be promoted. */
  promoteControlEvidence(evidenceSeq: number[]): void {
    if (this.stopped || this.state.judging || !evidenceSeq.length)
      throw new Error('INVALID_CONTROL');
    const selected = this.fragments.filter((f) => evidenceSeq.includes(f.serverSeq));
    if (
      selected.length !== evidenceSeq.length ||
      selected.some(
        (f) =>
          f.speaker !== 'user' ||
          f.generation !== this.state.generation ||
          f.receivedGameVersion !== this.state.gameVersion ||
          this.handled.has(f.serverSeq),
      )
    )
      throw new Error('INVALID_CONTROL');
    selected.forEach((f) => {
      f.executionEligible = true;
    });
    this.version++;
  }
  consume(evidenceSeq: number[]): void {
    const eligible = new Set(this.captureUnconsumedContext().eligibleEvidenceSeq);
    if (!evidenceSeq.length || !evidenceSeq.every((seq) => eligible.has(seq)))
      throw new Error('INVALID_EVIDENCE');
    // Consume the prefix too: a correction's earlier fragments must not become a
    // second action when another delegation arrives.
    const through = Math.max(...evidenceSeq);
    for (const f of this.fragments)
      if (f.speaker === 'user' && f.serverSeq <= through) this.handled.add(f.serverSeq);
  }
  stop(): void {
    this.stopped = true;
    this.fragments = [];
    this.ids.clear();
    this.handled.clear();
    this.bytes = 0;
    this.version++;
  }
}
