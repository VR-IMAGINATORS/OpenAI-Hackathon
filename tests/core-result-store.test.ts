import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { ResultStore, ResultStoreError } from '../apps/server/result-store.js';
import type { TranscriptFragment } from '../packages/shared/conversation.js';
const create = (store: ResultStore, owner = 'alice') => {
  const id = randomUUID();
  store.create({ playId: id, ownerDigest: owner, locale: 'ja' });
  return id;
};
const delta = (text: string, start: number, generation = 1): TranscriptFragment => ({
  serverSeq: start + 1,
  eventId: randomUUID(),
  generation,
  speaker: 'user',
  delta: text,
  startMs: start,
  endMs: start + 100,
  receivedGameVersion: 0,
  executionEligible: true,
});
const error = (code: string) => (e: unknown) => e instanceof ResultStoreError && e.code === code;

test('feed preserves raw deltas, stable late groups and fixed photo/result ordering', () => {
  const s = new ResultStore(),
    id = create(s);
  const f = delta('えっと、', 1000),
    first = s.appendTranscript(id, f);
  const result = s.appendMessage(id, { side: 'assistant', kind: 'result', text: '結果' });
  const late = s.appendTranscript(id, delta('これを切って', 1100));
  assert.equal(late.id, first.id);
  assert.equal(late.text, 'えっと、これを切って');
  assert.equal(s.appendTranscript(id, f).text, late.text);
  const feed = s.feed('alice', id, first.updatedVersion);
  assert.equal(feed.reset, false);
  assert.equal(feed.upserts[0]?.id, first.id);
  assert.equal(feed.upserts[1]?.id, result.id);
  assert.notEqual(s.appendTranscript(id, delta('new generation', 1200, 2)).id, first.id);
  assert.throws(() => s.feed('alice', id, 9999), error('INVALID_CURSOR'));
});
test('a prepared scene publishes at the end of the conversation and preserves image updates and its ID', () => {
  const s = new ResultStore(),
    id = create(s);
  const slot = {
    status: 'queued' as const,
    assetId: null,
    errorCode: null,
    deadline: new Date(Date.now() + 10000).toISOString(),
  };
  const prepared = s.appendMessage(
    id,
    { side: 'assistant', kind: 'system', text: '', liveGeneration: 1, imageSlot: slot },
    { deferDisplay: true },
  );
  const firstFeed = s.feed('alice', id);
  assert.deepEqual(firstFeed.upserts, []);
  const call = s.appendTranscript(
    id,
    { ...delta('聞こえる？', 100), speaker: 'assistant' },
    prepared.id,
  );
  assert.equal(call.imageSlot, null, 'call-check deltas cannot overwrite the deferred scene');
  s.appendTranscript(id, delta('聞こえるよ', 1000));
  const intro = s.appendTranscript(id, {
    ...delta('詳しくはメッセージで送るわ。', 3000),
    speaker: 'assistant',
  });
  s.updateMessage(id, prepared.id, { imageSlot: { ...slot, status: 'checking' } });
  const before = s.feed('alice', id, firstFeed.version);
  assert.equal(before.upserts.length, 3);
  const published = s.publishMessage(id, prepared.id, '状況説明');
  assert.ok(published.createdOrder > intro.createdOrder);
  assert.equal(published.imageSlot?.status, 'checking');
  const after = s.feed('alice', id, before.version);
  assert.deepEqual(after.upserts, [published]);
  assert.equal(s.feed('alice', id).upserts.at(-1)!.id, prepared.id);
  assert.deepEqual(s.publishMessage(id, prepared.id, '二重配送'), published);
  assert.deepEqual(s.feed('alice', id, after.version).upserts, []);
  s.updateMessage(id, prepared.id, {
    imageSlot: { ...slot, status: 'failed', errorCode: 'SCENE_RECEIVE_FAILED' },
  });
  const failed = s.feed('alice', id, after.version).upserts[0]!;
  assert.equal(failed.id, prepared.id);
  assert.equal(failed.text, '状況説明');
  assert.equal(failed.createdOrder, published.createdOrder);
});

test('history trims transcript first and supports removed IDs and stale cursor reset', () => {
  const s = new ResultStore(),
    id = create(s);
  const fixed = s.appendMessage(id, { side: 'assistant', kind: 'result', text: 'keep' });
  const old = s.appendTranscript(id, delta('first', 0));
  for (let i = 1; i < 128; i++) s.appendTranscript(id, delta('text', i * 3000));
  let feed = s.feed('alice', id, old.updatedVersion);
  assert.ok(feed.removedIds.includes(old.id));
  assert.ok(s.feed('alice', id).upserts.some((m) => m.id === fixed.id));
  for (let i = 128; i < 270; i++) s.appendTranscript(id, delta('text', i * 3000));
  feed = s.feed('alice', id, old.updatedVersion);
  assert.equal(feed.reset, true);
  assert.equal(feed.upserts.length, 128);
});
test('48KiB text bound does not modify original transcript text', () => {
  const s = new ResultStore(),
    id = create(s);
  for (let i = 0; i < 20; i++) s.appendTranscript(id, delta('声'.repeat(3000), i * 3000));
  const feed = s.feed('alice', id);
  assert.ok(feed.upserts.reduce((n, m) => n + Buffer.byteLength(m.text), 0) <= 48 * 1024);
  assert.ok(feed.upserts.every((m) => m.text === '声'.repeat(3000)));
});
test('result retention is owner-only, finite, independent of rereads and replay', () => {
  let now = 0;
  const evicted: string[] = [];
  const s = new ResultStore({ now: () => now, onEvict: (id) => evicted.push(id) }),
    id = create(s);
  s.appendMessage(id, { side: 'assistant', kind: 'result', text: 'old' });
  s.end(id, { status: 'won' });
  const next = create(s);
  s.appendMessage(next, { side: 'assistant', kind: 'result', text: 'new' });
  assert.throws(() => s.feed('bob', id), error('RESULT_NOT_FOUND'));
  now = 299999;
  assert.deepEqual(s.result('alice', id), { status: 'won' });
  assert.equal(s.feed('alice', id).retainUntil, '1970-01-01T00:05:00.000Z');
  now = 300000;
  assert.throws(() => s.feed('alice', id), error('RESULT_EXPIRED'));
  assert.deepEqual(evicted, [id]);
  assert.ok(s.has(next));
});
test('ended count eviction calls cancellation and preserves active entries', () => {
  const evicted: string[] = [];
  const s = new ResultStore({ maxEnded: 2, onEvict: (id) => evicted.push(id) }),
    active = create(s),
    ids = [];
  for (let i = 0; i < 3; i++) {
    const id = create(s);
    ids.push(id);
    s.end(id, { status: 'won' });
  }
  assert.deepEqual(evicted, [ids[0]]);
  assert.equal(s.has(active), true);
  assert.equal(s.hasOwner('alice'), true);
  s.clear();
  assert.equal(s.hasOwner('alice'), false);
});
test('assets are normalized JPEG, scoped to owner/play and limited before allocation', async () => {
  const s = new ResultStore(),
    id = create(s),
    other = create(s);
  const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } })
    .jpeg()
    .toBuffer();
  const asset = await s.putAsset(id, { kind: 'photo', bytes, mime: 'image/jpeg' });
  assert.equal(s.asset('alice', id, asset).mime, 'image/jpeg');
  assert.throws(() => s.asset('bob', id, asset), error('RESULT_NOT_FOUND'));
  assert.throws(() => s.asset('alice', other, asset), error('ASSET_NOT_FOUND'));
  const returned = s.asset('alice', id, asset);
  returned.bytes.fill(0);
  assert.equal(s.asset('alice', id, asset).bytes[0], 255);
  await assert.rejects(
    s.putAsset(id, { kind: 'scene', bytes: Buffer.from('<svg/>'), mime: 'image/jpeg' }),
    error('INVALID_ASSET'),
  );
  assert.throws(
    () => s.appendMessage(other, { side: 'user', kind: 'photo', text: '', assetIds: [asset] }),
    error('ASSET_NOT_FOUND'),
  );
});
test('capacity evicts old ended entries before refusing active image additions', async () => {
  const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'blue' } })
    .jpeg()
    .toBuffer();
  const evicted: string[] = [];
  const s = new ResultStore({
    maxTotalBytes: 700,
    maxEntryBytes: 600,
    onEvict: (id) => evicted.push(id),
  });
  const old = create(s);
  await s.putAsset(old, { kind: 'scene', bytes, mime: 'image/jpeg' });
  s.end(old, { status: 'won' });
  const active = create(s);
  await s.putAsset(active, { kind: 'scene', bytes, mime: 'image/jpeg' });
  await s.putAsset(active, { kind: 'scene', bytes, mime: 'image/jpeg' });
  assert.deepEqual(evicted, [old]);
  await assert.rejects(
    s.putAsset(active, { kind: 'scene', bytes, mime: 'image/jpeg' }),
    error('RESULT_CAPACITY'),
  );
  assert.ok(s.has(active));
});

test('JSON escaping remains below the feed wire limit', () => {
  const s = new ResultStore(),
    id = create(s);
  for (let i = 0; i < 20; i++) s.appendTranscript(id, delta('\u0000'.repeat(4000), i * 3000));
  assert.ok(Buffer.byteLength(JSON.stringify(s.feed('alice', id))) < 256 * 1024);
});
test('queued normalization cannot attach an asset after retention expiry', async () => {
  let now = 0;
  const s = new ResultStore({ now: () => now, ttlMs: 100 }),
    id = create(s);
  const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } })
    .jpeg()
    .toBuffer();
  s.end(id, { status: 'won' });
  const pending = s.putAsset(id, { kind: 'scene', bytes, mime: 'image/jpeg' });
  now = 100;
  await assert.rejects(pending, error('RESULT_EXPIRED'));
  assert.equal(s.has(id), false);
});
