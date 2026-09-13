import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import {
  chatMessageSchema,
  type ChatMessage,
  type TranscriptFragment,
} from '../../packages/shared/conversation.js';

export interface FeedResponse {
  playId: string;
  locale: 'ja' | 'en';
  version: number;
  reset: boolean;
  upserts: ChatMessage[];
  removedIds: string[];
  retainUntil: string | null;
}
export interface ResultStoreOptions {
  now?: () => number;
  ttlMs?: number;
  maxEnded?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
  onEvict?: (playId: string) => void;
}
type MessageInput = Pick<ChatMessage, 'side' | 'kind' | 'text'> &
  Partial<Omit<ChatMessage, 'side' | 'kind' | 'text' | 'createdOrder' | 'updatedVersion'>>;
interface Group {
  generation: number;
  speaker: string;
  start: number;
  end: number;
  events: Set<string>;
}
interface Entry {
  playId: string;
  ownerDigest: string;
  locale: 'ja' | 'en';
  gap: number;
  version: number;
  order: number;
  messages: Map<string, ChatMessage>;
  groups: Map<string, Group>;
  removed: { id: string; version: number }[];
  floor: number;
  assets: Map<string, { bytes: Buffer; mime: 'image/jpeg'; kind: 'photo' | 'scene' }>;
  endedAt: number | null;
  retainUntil: number | null;
  result: unknown;
}
export class ResultStoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
/** Bounded presentation history, independent from action evidence and live lifetime. */
export class ResultStore {
  private entries = new Map<string, Entry>();
  private now: () => number;
  private normalization: Promise<unknown> = Promise.resolve();
  constructor(private options: ResultStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }
  create(input: {
    playId: string;
    ownerDigest: string;
    locale: 'ja' | 'en';
    groupingGapMs?: number;
  }): void {
    this.sweep();
    if (this.entries.has(input.playId)) throw new ResultStoreError(409, 'RESULT_EXISTS');
    this.entries.set(input.playId, {
      ...input,
      gap: input.groupingGapMs ?? 1200,
      version: 0,
      order: 0,
      messages: new Map(),
      groups: new Map(),
      removed: [],
      floor: 0,
      assets: new Map(),
      endedAt: null,
      retainUntil: null,
      result: null,
    });
  }
  private entry(id: string): Entry {
    this.sweep();
    const entry = this.entries.get(id);
    if (!entry) throw new ResultStoreError(410, 'RESULT_EXPIRED');
    return entry;
  }
  private owned(owner: string, id: string): Entry {
    const entry = this.entry(id);
    if (entry.ownerDigest !== owner) throw new ResultStoreError(404, 'RESULT_NOT_FOUND');
    return entry;
  }
  hasOwner(owner: string): boolean {
    this.sweep();
    return [...this.entries.values()].some((e) => e.ownerDigest === owner);
  }
  has(playId: string): boolean {
    this.sweep();
    return this.entries.has(playId);
  }
  retainUntil(playId: string): string | null {
    const n = this.entry(playId).retainUntil;
    return n === null ? null : new Date(n).toISOString();
  }
  feed(owner: string, playId: string, after = 0): FeedResponse {
    const e = this.owned(owner, playId);
    if (!Number.isSafeInteger(after) || after < 0 || after > e.version)
      throw new ResultStoreError(400, 'INVALID_CURSOR');
    const reset = after === 0 || after < e.floor;
    return {
      playId,
      locale: e.locale,
      version: e.version,
      reset,
      upserts: [...e.messages.values()]
        .filter((m) => reset || m.updatedVersion > after)
        .sort((a, b) => a.createdOrder - b.createdOrder)
        .map((m) => structuredClone(m)),
      removedIds: reset ? [] : e.removed.filter((r) => r.version > after).map((r) => r.id),
      retainUntil: e.retainUntil === null ? null : new Date(e.retainUntil).toISOString(),
    };
  }
  appendMessage(playId: string, input: MessageInput): ChatMessage {
    const e = this.entry(playId);
    if (input.id && e.messages.has(input.id)) return structuredClone(e.messages.get(input.id)!);
    const message = chatMessageSchema.parse({
      id: input.id ?? randomUUID(),
      createdOrder: e.order + 1,
      updatedVersion: e.version + 1,
      assetIds: [],
      imageSlot: null,
      relatedCommandSeq: null,
      liveGeneration: null,
      ...input,
    });
    this.validateAssets(e, message);
    e.version++;
    e.order++;
    e.messages.set(message.id, message);
    try {
      this.trim(e, message.id);
      this.makeRoom(e, 0);
    } catch (error) {
      e.messages.delete(message.id);
      throw error;
    }
    return structuredClone(message);
  }
  updateMessage(
    playId: string,
    id: string,
    patch: Partial<
      Pick<ChatMessage, 'text' | 'assetIds' | 'imageSlot' | 'relatedCommandSeq' | 'liveGeneration'>
    >,
  ): ChatMessage {
    const e = this.entry(playId),
      old = e.messages.get(id);
    if (!old) throw new ResultStoreError(404, 'MESSAGE_NOT_FOUND');
    const m = chatMessageSchema.parse({ ...old, ...patch, updatedVersion: e.version + 1 });
    this.validateAssets(e, m);
    e.version++;
    e.messages.set(id, m);
    try {
      this.trim(e, id);
      this.makeRoom(e, 0);
    } catch (error) {
      e.messages.set(id, old);
      throw error;
    }
    return structuredClone(m);
  }
  appendTranscript(playId: string, fragment: TranscriptFragment): ChatMessage {
    const e = this.entry(playId);
    for (const [id, g] of e.groups)
      if (g.events.has(fragment.eventId)) return structuredClone(e.messages.get(id)!);
    const matches = [...e.groups].filter(
      ([id, g]) =>
        g.generation === fragment.generation &&
        g.speaker === fragment.speaker &&
        fragment.startMs <= g.end + e.gap &&
        fragment.endMs >= g.start - e.gap &&
        e.messages.get(id)!.text.length + fragment.delta.length <= 4000,
    );
    const match = matches.at(-1);
    if (match) {
      const [id, g] = match;
      const m = this.updateMessage(playId, id, { text: e.messages.get(id)!.text + fragment.delta });
      g.start = Math.min(g.start, fragment.startMs);
      g.end = Math.max(g.end, fragment.endMs);
      g.events.add(fragment.eventId);
      return m;
    }
    const m = this.appendMessage(playId, {
      side: fragment.speaker,
      kind: 'transcript',
      text: fragment.delta,
      liveGeneration: fragment.generation,
    });
    e.groups.set(m.id, {
      generation: fragment.generation,
      speaker: fragment.speaker,
      start: fragment.startMs,
      end: fragment.endMs,
      events: new Set([fragment.eventId]),
    });
    return m;
  }
  private validateAssets(e: Entry, m: ChatMessage): void {
    const ids = [...m.assetIds, ...(m.imageSlot?.assetId ? [m.imageSlot.assetId] : [])];
    if (ids.some((id) => !e.assets.has(id))) throw new ResultStoreError(400, 'ASSET_NOT_FOUND');
  }
  private trim(e: Entry, preserve: string): void {
    const over = () =>
      e.messages.size > 128 ||
      [...e.messages.values()].reduce((n, m) => n + Buffer.byteLength(m.text), 0) > 48 * 1024 ||
      Buffer.byteLength(JSON.stringify([...e.messages.values()])) > 240 * 1024;
    while (over()) {
      const oldest = [...e.messages.values()].find(
        (m) => m.kind === 'transcript' && m.id !== preserve,
      );
      if (!oldest) throw new ResultStoreError(413, 'FEED_CAPACITY');
      e.messages.delete(oldest.id);
      e.groups.delete(oldest.id);
      e.removed.push({ id: oldest.id, version: ++e.version });
      if (e.removed.length > 128) e.floor = e.removed.shift()!.version;
    }
  }
  /** Re-encode before storage: strips metadata and rejects SVG/HTML/oversized pixel inputs. */
  async putAsset(
    playId: string,
    input: { kind: 'photo' | 'scene'; bytes: Buffer; mime: 'image/jpeg' },
  ): Promise<string> {
    const e = this.entry(playId);
    const cap = input.kind === 'photo' ? 32 * 1024 : 256 * 1024;
    if (
      input.mime !== 'image/jpeg' ||
      input.bytes.length > 6 * 1024 * 1024 ||
      input.bytes[0] !== 255 ||
      input.bytes[1] !== 216
    )
      throw new ResultStoreError(400, 'INVALID_ASSET');
    const pixels = input.kind === 'photo' ? 384 : 1024;
    let bytes: Buffer;
    try {
      const normalized = this.normalization.then(async () => {
        if (this.entry(playId) !== e) throw new ResultStoreError(410, 'RESULT_EXPIRED');
        return sharp(input.bytes, { limitInputPixels: 16 * 1024 * 1024, failOn: 'warning' })
          .rotate()
          .resize({ width: pixels, height: pixels, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 65 })
          .toBuffer();
      });
      this.normalization = normalized.catch(() => {});
      bytes = await normalized;
    } catch (error) {
      if (error instanceof ResultStoreError) throw error;
      throw new ResultStoreError(400, 'INVALID_ASSET');
    }
    if (bytes.length > cap) throw new ResultStoreError(413, 'ASSET_TOO_LARGE');
    if (this.entry(playId) !== e) throw new ResultStoreError(410, 'RESULT_EXPIRED');
    this.makeRoom(e, bytes.length);
    const id = randomUUID();
    e.assets.set(id, { bytes, mime: 'image/jpeg', kind: input.kind });
    return id;
  }
  asset(owner: string, playId: string, assetId: string): { bytes: Buffer; mime: 'image/jpeg' } {
    const a = this.owned(owner, playId).assets.get(assetId);
    if (!a) throw new ResultStoreError(404, 'ASSET_NOT_FOUND');
    return { bytes: Buffer.from(a.bytes), mime: a.mime };
  }
  private bytes(e: Entry): number {
    return (
      Buffer.byteLength(JSON.stringify([...e.messages.values()])) +
      Buffer.byteLength(JSON.stringify(e.result) ?? '') +
      [...e.assets.values()].reduce((n, a) => n + a.bytes.length, 0)
    );
  }
  private makeRoom(e: Entry, extra: number): void {
    if (this.bytes(e) + extra > (this.options.maxEntryBytes ?? 8 * 1024 * 1024))
      throw new ResultStoreError(413, 'RESULT_CAPACITY');
    const total = () => [...this.entries.values()].reduce((n, item) => n + this.bytes(item), 0);
    while (total() + extra > (this.options.maxTotalBytes ?? 128 * 1024 * 1024)) {
      const oldest = this.ended().find((item) => item !== e);
      if (!oldest) throw new ResultStoreError(413, 'RESULT_CAPACITY');
      this.evict(oldest.playId);
    }
  }
  end(playId: string, result: unknown): void {
    const e = this.entry(playId);
    if (e.endedAt !== null) return;
    const copy = structuredClone(result);
    this.makeRoom(e, Buffer.byteLength(JSON.stringify(copy) ?? ''));
    e.result = copy;
    e.endedAt = this.now();
    e.retainUntil = e.endedAt + (this.options.ttlMs ?? 300_000);
    e.version++;
    while (this.ended().length > (this.options.maxEnded ?? 10)) this.evict(this.ended()[0]!.playId);
  }
  result(owner: string, playId: string): unknown {
    return structuredClone(this.owned(owner, playId).result);
  }
  private ended(): Entry[] {
    return [...this.entries.values()]
      .filter((e) => e.endedAt !== null)
      .sort((a, b) => a.endedAt! - b.endedAt!);
  }
  sweep(): void {
    for (const e of this.entries.values())
      if (e.retainUntil !== null && this.now() >= e.retainUntil) this.evict(e.playId);
  }
  evict(playId: string): void {
    if (this.entries.delete(playId)) this.options.onEvict?.(playId);
  }
  clear(): void {
    for (const id of this.entries.keys()) this.evict(id);
  }
}
