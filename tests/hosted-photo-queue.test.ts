import test from 'node:test';
import assert from 'node:assert/strict';
import { PhotoQueue } from '../apps/server/photo-queue.js';

test('photo queue runs one decode and caps waiting work at four', async () => {
  const queue = new PhotoQueue();
  let release!: () => void;
  let active = 0,
    peak = 0;
  const first = queue.run(
    async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => (release = resolve));
      active--;
    },
    () => true,
  );
  const waiting = Array.from({ length: 4 }, () =>
    queue.run(
      async () => {
        active++;
        peak = Math.max(peak, active);
        active--;
      },
      () => true,
    ),
  );
  await assert.rejects(
    queue.run(
      async () => {},
      () => true,
    ),
    /写真を処理中/,
  );
  release();
  await Promise.all([first, ...waiting]);
  assert.equal(peak, 1);
  queue.dispose();
});

test('expired queued photo is discarded before expensive decoding', async () => {
  const queue = new PhotoQueue();
  let release!: () => void;
  const first = queue.run(
    () => new Promise<void>((resolve) => (release = resolve)),
    () => true,
  );
  let decoded = false;
  const discarded = assert.rejects(
    queue.run(
      async () => {
        decoded = true;
      },
      () => false,
    ),
    /失効/,
  );
  release();
  await Promise.all([first, discarded]);
  assert.equal(decoded, false);
  queue.dispose();
});

test('aborting a queued upload releases its wait slot immediately', async () => {
  const queue = new PhotoQueue();
  let release!: () => void;
  const active = queue.run(
    () => new Promise<void>((resolve) => (release = resolve)),
    () => true,
  );
  const abort = new AbortController();
  let decoded = false;
  const waiting = assert.rejects(
    queue.run(
      async () => {
        decoded = true;
      },
      () => true,
      abort.signal,
    ),
    /中止/,
  );
  abort.abort();
  await waiting;
  assert.equal(decoded, false);
  release();
  await active;
  queue.dispose();
});
