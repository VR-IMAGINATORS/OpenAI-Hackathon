import type { TranscriptFragment } from '../../packages/shared/conversation.js';

export interface StoryEvidenceRecord {
  sourceId: string;
  kind: 'briefing' | 'situation' | 'action_result' | 'assistant_transcript';
  order: number;
  generation: number;
  gameVersion: number;
  text: string;
  eventId?: string;
  startMs?: number;
  endMs?: number;
}
export interface StoryEvidenceSnapshot {
  records: StoryEvidenceRecord[];
  truncated: boolean;
}

/** Play-owned presentation evidence: never reset it with the conversation controller. */
export class StoryEvidenceLedger {
  private records: StoryEvidenceRecord[] = [];
  private sourceIds = new Set<string>();
  private bytes = Buffer.byteLength(JSON.stringify({ records: [], truncated: false }));
  private truncated = false;
  private sealed = false;
  private generation = 0;
  private generationStartedAt = 0;
  private cutoff: { generation: number; audioEndMs: number; acceptUntil: number } | null = null;

  constructor(private readonly limits = { maxBytes: 512 * 1024, maxEvents: 10_000 }) {}

  startGeneration(generation: number, startedAt: number): void {
    if (this.cutoff || this.sealed) return;
    this.generation = generation;
    this.generationStartedAt = startedAt;
  }

  append(input: Omit<StoryEvidenceRecord, 'order'>): StoryEvidenceRecord | null {
    if (this.sealed || this.sourceIds.has(input.sourceId)) return null;
    const record = { ...input, order: this.records.length + 1 };
    const size = Buffer.byteLength(JSON.stringify(record)) + (this.records.length ? 1 : 0);
    if (this.records.length >= this.limits.maxEvents || this.bytes + size > this.limits.maxBytes) {
      this.truncated = true;
      return null;
    }
    this.records.push(structuredClone(record));
    this.sourceIds.add(record.sourceId);
    this.bytes += size;
    return structuredClone(record);
  }

  transcript(fragment: TranscriptFragment, receivedAt: number): StoryEvidenceRecord | null {
    if (fragment.speaker !== 'assistant' || fragment.generation !== this.generation) return null;
    if (
      this.cutoff &&
      (fragment.generation !== this.cutoff.generation ||
        receivedAt >= this.cutoff.acceptUntil ||
        fragment.endMs > this.cutoff.audioEndMs)
    )
      return null;
    return this.append({
      sourceId: `voice:${fragment.generation}:${fragment.eventId}`,
      kind: 'assistant_transcript',
      generation: fragment.generation,
      gameVersion: fragment.receivedGameVersion,
      text: fragment.delta,
      eventId: fragment.eventId,
      startMs: fragment.startMs,
      endMs: fragment.endMs,
    });
  }

  /** The live session's offset origin is captured before its answer is returned. */
  end(endedAt: number, acceptUntil: number): void {
    if (this.cutoff) return;
    this.cutoff = {
      generation: this.generation,
      audioEndMs: Math.max(0, Math.floor(endedAt - this.generationStartedAt)),
      acceptUntil,
    };
  }

  markTruncated(): void {
    if (!this.sealed) this.truncated = true;
  }
  snapshot(): StoryEvidenceSnapshot {
    return { records: structuredClone(this.records), truncated: this.truncated };
  }
  seal(): StoryEvidenceSnapshot {
    this.sealed = true;
    return this.snapshot();
  }
}
