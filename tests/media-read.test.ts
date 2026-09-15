import assert from 'node:assert/strict';
import test from 'node:test';
import { readImageAsset } from '../apps/web/src/media-read.js';

const signal = () => new AbortController().signal;
const jpeg = () =>
  new Response(new Uint8Array([255, 216, 255, 217]), {
    headers: { 'Content-Type': 'image/jpeg' },
  });

test('asset retrieval recovers network and server failures using GET of the same saved asset', async () => {
  let calls = 0;
  const blob = await readImageAsset('/saved-image', { 'X-Play-Id': 'play' }, signal(), {
    retryMs: 1,
    fetch: async (url, init) => {
      assert.equal(url, '/saved-image');
      assert.equal(init?.method, undefined);
      assert.equal(init?.credentials, 'same-origin');
      calls++;
      if (calls === 1) throw new TypeError('connection lost');
      return calls === 2 ? new Response('', { status: 503 }) : jpeg();
    },
  });
  assert.equal(blob.size, 4);
  assert.equal(calls, 3);
});

test('asset retries are finite and do not retry expired, forbidden, invalid or oversized images', async () => {
  for (const kind of ['network', 'expired', 'forbidden', 'mime', 'oversized']) {
    let calls = 0;
    await assert.rejects(
      readImageAsset('/saved-image', {}, signal(), {
        retryMs: 1,
        fetch: async () => {
          calls++;
          if (kind === 'network') throw new TypeError('offline');
          if (kind === 'expired') return new Response('', { status: 410 });
          if (kind === 'forbidden') return new Response('', { status: 403 });
          if (kind === 'mime') return new Response('<html>failed</html>');
          return new Response(new Uint8Array(256 * 1024 + 1), {
            headers: { 'Content-Type': 'image/jpeg' },
          });
        },
      }),
    );
    assert.equal(calls, kind === 'network' ? 3 : 1);
  }
});

test('asset timeout cancels a stalled body and retries without blocking the entire result view', async () => {
  let calls = 0,
    cancelled = 0;
  const blob = await readImageAsset('/saved-image', {}, signal(), {
    timeoutMs: 10,
    retryMs: 1,
    fetch: async () => {
      if (++calls > 1) return jpeg();
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
        {
          headers: { 'Content-Type': 'image/jpeg' },
        },
      );
    },
  });
  assert.equal(blob.size, 4);
  assert.equal(calls, 2);
  assert.equal(cancelled, 1);
});

test('leaving a play aborts asset retrieval and prevents retry', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    readImageAsset('/saved-image', {}, controller.signal, {
      retryMs: 1,
      fetch: async () => {
        calls++;
        controller.abort();
        throw new TypeError('aborted');
      },
    }),
  );
  assert.equal(calls, 1);
});
