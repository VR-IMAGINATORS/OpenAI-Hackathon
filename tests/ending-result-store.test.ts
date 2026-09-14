import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { ResultStore, ResultStoreError } from '../apps/server/result-store.js';
import { MAX_ENDING_VIDEO_BYTES } from '../packages/server/ending-video-media.js';
import type { EndingView } from '../packages/shared/ending.js';

const MiB = 1024 * 1024;
const create = (store: ResultStore, owner = 'alice') => {
  const playId = randomUUID();
  store.create({ playId, ownerDigest: owner, locale: 'ja' });
  return playId;
};
const view = (playId: string): EndingView => ({
  playId,
  outcome: 'normal',
  clearedCount: 2,
  status: 'queued',
  errorCode: null,
  retainUntil: null,
  videoPath: null,
  story: null,
});
const error = (status: number, code: string) => (value: unknown) =>
  value instanceof ResultStoreError && value.status === status && value.code === code;
const videoPath = (playId: string) => '/api/play/ending/video?playId=' + playId;
function ready(store: ResultStore, playId: string, bytes = Buffer.from('stored fake media')) {
  store.reserveVideo(playId);
  store.putVideo(playId, bytes);
  store.updateEnding(playId, { status: 'ready', videoPath: videoPath(playId) });
  return bytes;
}

test('ending views and media isolate owners and a new play; returned views cannot mutate state', () => {
  const store = new ResultStore({ maxEntryBytes: 32 * MiB });
  const first = create(store),
    second = create(store, 'bob'),
    replay = create(store);
  const input = view(first);
  assert.equal(store.initializeEnding(first, input), true);
  input.outcome = 'bad';
  assert.equal(store.initializeEnding(first, { ...view(first), outcome: 'happy' }), false);
  const story = {
    title: 'ランプの合図',
    text: '残しておいた合図が届いた。',
    evaluation: '二つの障害を解除した。',
  };
  store.updateEnding(first, { story });
  story.text = 'outside mutation';
  const read = store.ending('alice', first);
  assert.equal(read.outcome, 'normal');
  assert.equal(read.clearedCount, 2);
  assert.equal(read.story?.text, '残しておいた合図が届いた。');
  read.story!.text = 'reader mutation';
  assert.equal(store.ending('alice', first).story?.text, '残しておいた合図が届いた。');
  assert.throws(() => store.ending('bob', first), error(404, 'RESULT_NOT_FOUND'));
  assert.throws(() => store.endingVideo('bob', first), error(404, 'RESULT_NOT_FOUND'));
  assert.throws(() => store.ending('alice', second), error(404, 'RESULT_NOT_FOUND'));
  assert.throws(() => store.ending('alice', replay), error(409, 'ENDING_NOT_STARTED'));
  assert.throws(() => store.endingVideo('alice', replay), error(409, 'VIDEO_NOT_READY'));
  const bytes = ready(store, first);
  // HTTP Range callers can share the retained bytes without copying a whole video per request.
  assert.equal(store.endingVideo('alice', first), bytes);
  assert.equal(store.endingVideo('alice', first), store.endingVideo('alice', first));
  assert.throws(() => store.endingVideo('bob', first), error(404, 'RESULT_NOT_FOUND'));
  assert.throws(() => store.endingVideo('alice', replay), error(409, 'VIDEO_NOT_READY'));
});

test('ending lifetime starts at game end and neither updates nor repeated end extend it', () => {
  let now = 0;
  const evicted: string[] = [];
  const store = new ResultStore({
    now: () => now,
    ttlMs: 600_000,
    maxEntryBytes: 32 * MiB,
    onEvict: (id) => evicted.push(id),
  });
  const id = create(store);
  store.initializeEnding(id, { ...view(id), retainUntil: new Date(9_000_000).toISOString() });
  assert.equal(store.ending('alice', id).retainUntil, null);
  now = 1000;
  store.end(id, { status: 'lost', clearedCount: 2 });
  const deadline = new Date(601_000).toISOString();
  assert.equal(store.ending('alice', id).retainUntil, deadline);
  now = 590_000;
  store.end(id, { status: 'won', clearedCount: 3 });
  ready(store, id);
  assert.equal(store.ending('alice', id).retainUntil, deadline);
  assert.deepEqual(store.result('alice', id), { status: 'lost', clearedCount: 2 });
  now = 600_999;
  assert.equal(store.ending('alice', id).status, 'ready');
  assert.ok(store.endingVideo('alice', id).length > 0);
  now = 601_000;
  assert.throws(() => store.ending('alice', id), error(410, 'RESULT_EXPIRED'));
  assert.throws(() => store.endingVideo('alice', id), error(410, 'RESULT_EXPIRED'));
  assert.throws(() => store.updateEnding(id, { status: 'ready' }), error(410, 'RESULT_EXPIRED'));
  assert.throws(() => store.reserveVideo(id), error(410, 'RESULT_EXPIRED'));
  assert.throws(() => store.putVideo(id, Buffer.from('late')), error(410, 'RESULT_EXPIRED'));
  assert.deepEqual(evicted, [id]);
});

test('video storage requires a prior bounded reservation and a ready ending before reading', () => {
  const store = new ResultStore({ maxEntryBytes: 32 * MiB });
  const id = create(store);
  store.initializeEnding(id, view(id));
  const bytes = Buffer.from('fake verified MP4 bytes');
  assert.throws(() => store.putVideo(id, bytes), error(413, 'VIDEO_CAPACITY'));
  assert.throws(() => store.endingVideo('alice', id), error(409, 'VIDEO_NOT_READY'));
  store.reserveVideo(id);
  assert.throws(() => store.putVideo(id, Buffer.alloc(0)), error(413, 'VIDEO_CAPACITY'));
  assert.throws(
    () => store.putVideo(id, Buffer.alloc(MAX_ENDING_VIDEO_BYTES + 1)),
    error(413, 'VIDEO_CAPACITY'),
  );
  store.putVideo(id, bytes);
  assert.throws(() => store.endingVideo('alice', id), error(409, 'VIDEO_NOT_READY'));
  store.updateEnding(id, { status: 'ready', videoPath: videoPath(id) });
  assert.equal(store.endingVideo('alice', id), bytes);
  assert.throws(() => store.putVideo(id, Buffer.from('replacement')), error(413, 'VIDEO_CAPACITY'));
  store.reserveVideo(id);
  assert.throws(() => store.putVideo(id, Buffer.from('replacement')), error(413, 'VIDEO_CAPACITY'));
  assert.equal(store.endingVideo('alice', id), bytes);
});

test('24 MiB video reservations count toward aggregate capacity before downloading any bytes', () => {
  assert.equal(MAX_ENDING_VIDEO_BYTES, 24 * MiB);
  const store = new ResultStore({ maxEntryBytes: 32 * MiB, maxTotalBytes: 128 * MiB });
  const ids = Array.from({ length: 6 }, () => create(store));
  for (const id of ids) store.initializeEnding(id, view(id));
  for (const id of ids.slice(0, 5)) {
    store.reserveVideo(id);
    store.reserveVideo(id); // Repeated preparation does not reserve a second 24 MiB.
  }
  assert.throws(() => store.reserveVideo(ids[5]!), error(413, 'RESULT_CAPACITY'));
  store.releaseVideoReservation(ids[0]!);
  store.releaseVideoReservation(ids[0]!);
  store.reserveVideo(ids[5]!);
  assert.throws(() => store.reserveVideo(ids[0]!), error(413, 'RESULT_CAPACITY'));
  store.putVideo(ids[1]!, Buffer.alloc(128));
  // Committing a small download releases the unused part of the reservation.
  store.reserveVideo(ids[0]!);
});

test('entry capacity includes the video reservation plus its retained result metadata', () => {
  const store = new ResultStore({ maxEntryBytes: MAX_ENDING_VIDEO_BYTES });
  const id = create(store);
  store.initializeEnding(id, view(id));
  assert.throws(() => store.reserveVideo(id), error(413, 'RESULT_CAPACITY'));
  assert.throws(
    () => store.putVideo(id, Buffer.from('no reservation')),
    error(413, 'VIDEO_CAPACITY'),
  );
});

test('a maximum-size 24 MiB video fits its reservation in a 32 MiB result', () => {
  const store = new ResultStore({ maxEntryBytes: 32 * MiB });
  const id = create(store);
  store.initializeEnding(id, view(id));
  const bytes = Buffer.alloc(MAX_ENDING_VIDEO_BYTES);
  ready(store, id, bytes);
  assert.equal(store.endingVideo('alice', id).length, MAX_ENDING_VIDEO_BYTES);
  assert.equal(store.endingVideo('alice', id), bytes);
});

test('making room evicts the oldest ended reservation and notifies its job owner once', () => {
  let now = 0;
  const evicted: string[] = [];
  const store = new ResultStore({
    now: () => now,
    maxEntryBytes: 32 * MiB,
    maxTotalBytes: 50 * MiB,
    onEvict: (id) => evicted.push(id),
  });
  const old = create(store),
    newer = create(store),
    current = create(store);
  for (const id of [old, newer, current]) store.initializeEnding(id, view(id));
  store.reserveVideo(old);
  store.end(old, { outcome: 'bad' });
  now = 1;
  store.reserveVideo(newer);
  store.end(newer, { outcome: 'normal' });
  store.reserveVideo(current);
  assert.deepEqual(evicted, [old]);
  assert.equal(store.has(old), false);
  assert.equal(store.has(newer), true);
  assert.equal(store.has(current), true);
  assert.throws(
    () => store.putVideo(old, Buffer.from('late download')),
    error(410, 'RESULT_EXPIRED'),
  );
  store.releaseVideoReservation(old);
  store.evict(old);
  assert.deepEqual(evicted, [old]);
});

test('the ended-result count remains bounded and evicted videos cannot be read', () => {
  let now = 0;
  const evicted: string[] = [];
  const store = new ResultStore({
    now: () => now,
    maxEnded: 2,
    maxEntryBytes: 32 * MiB,
    onEvict: (id) => evicted.push(id),
  });
  const ids = Array.from({ length: 3 }, () => create(store));
  for (const id of ids) {
    store.initializeEnding(id, view(id));
    ready(store, id);
    store.end(id, { outcome: 'normal' });
    now++;
  }
  assert.deepEqual(evicted, [ids[0]]);
  assert.throws(() => store.endingVideo('alice', ids[0]!), error(410, 'RESULT_EXPIRED'));
  for (const id of ids.slice(1)) assert.ok(store.endingVideo('alice', id).length > 0);
});

const jpeg = async (color: string) =>
  sharp({ create: { width: 16, height: 16, channels: 3, background: color } })
    .jpeg()
    .toBuffer();
const imageSlot = (
  status: 'queued' | 'ready' | 'failed' | 'cancelled',
  assetId: string | null = null,
) => ({
  status,
  assetId,
  errorCode: status === 'failed' ? ('SCENE_RECEIVE_FAILED' as const) : null,
  deadline: new Date(100_000).toISOString(),
});

test('ending scene lookup follows exact message and game version even when images finish out of order', async () => {
  const store = new ResultStore();
  const id = create(store),
    other = create(store, 'bob');
  const earlier = randomUUID(),
    final = randomUUID();
  assert.equal(store.sceneReference(id, final, 9), null);
  store.appendMessage(id, {
    id: earlier,
    side: 'assistant',
    kind: 'result',
    text: 'before the final action',
    imageSlot: imageSlot('queued'),
  });
  store.bindScene(id, earlier, 8);
  store.appendMessage(id, {
    id: final,
    side: 'assistant',
    kind: 'result',
    text: 'final action',
    imageSlot: imageSlot('queued'),
  });
  store.bindScene(id, final, 9);
  assert.equal(store.sceneReference(id, final, 9), null);
  assert.throws(() => store.sceneReference(id, final, 8), error(409, 'SCENE_VERSION'));
  const finalAsset = await store.putAsset(id, {
    kind: 'scene',
    mime: 'image/jpeg',
    bytes: await jpeg('#00ff00'),
  });
  store.updateMessage(id, final, { imageSlot: imageSlot('ready', finalAsset) });
  const earlierAsset = await store.putAsset(id, {
    kind: 'scene',
    mime: 'image/jpeg',
    bytes: await jpeg('#ff0000'),
  });
  store.updateMessage(id, earlier, { imageSlot: imageSlot('ready', earlierAsset) });
  const reference = store.sceneReference(id, final, 9)!;
  assert.equal(reference.messageId, final);
  assert.equal(reference.gameVersion, 9);
  assert.deepEqual(reference.jpeg, store.asset('alice', id, finalAsset).bytes);
  assert.notDeepEqual(reference.jpeg, store.sceneReference(id, earlier, 8)!.jpeg);
  assert.equal(store.sceneReference(id, randomUUID(), 9), null);
  assert.equal(store.sceneReference(other, final, 9), null);
  assert.throws(() => store.bindScene(id, final, 8), error(409, 'SCENE_VERSION'));
  store.bindScene(id, final, 9);
});

test('failed, cancelled, and non-scene assets never become ending references', async () => {
  const store = new ResultStore();
  const id = create(store);
  for (const status of ['failed', 'cancelled'] as const) {
    const message = store.appendMessage(id, {
      side: 'assistant',
      kind: 'result',
      text: status,
      imageSlot: imageSlot(status),
    });
    store.bindScene(id, message.id, 2);
    assert.throws(
      () => store.sceneReference(id, message.id, 2),
      error(409, 'ENDING_REFERENCE_FAILED'),
    );
  }
  const asset = await store.putAsset(id, {
    kind: 'photo',
    mime: 'image/jpeg',
    bytes: await jpeg('#333333'),
  });
  const message = store.appendMessage(id, {
    side: 'assistant',
    kind: 'result',
    text: 'photo is not a scene',
    imageSlot: imageSlot('ready', asset),
  });
  store.bindScene(id, message.id, 2);
  assert.throws(() => store.sceneReference(id, message.id, 2), error(404, 'ASSET_NOT_FOUND'));
});
