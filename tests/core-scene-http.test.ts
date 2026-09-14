import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import sharp from 'sharp';
import { createHostedApp } from '../apps/server/app.js';
import { loadHostedConfig } from '../apps/server/config.js';
import type { ChatMessage } from '../packages/shared/conversation.js';

async function setup(t: TestContext, reject = false) {
  const config = loadHostedConfig({
    HOSTED_NO_ENV_FILE: '1',
    APP_PASSPHRASE: 'scene-http-test-only',
    AI_MODE: 'mock',
  });
  const jpeg = await sharp({ create: { width: 24, height: 24, channels: 3, background: 'navy' } })
    .jpeg()
    .toBuffer();
  const pending: { resolve: (value: unknown) => void; signal?: AbortSignal }[] = [];
  let imageCalls = 0,
    inspectionCalls = 0;
  const hosted = createHostedApp(config, {
    log: () => {},
    transport: {
      async createLiveSession() {
        return {
          session: { id: 'live_scene_test' },
          transport: { type: 'webrtc', sdp: 'fake-answer' },
        };
      },
      async hangup() {},
      async createImage(_body, signal) {
        imageCalls++;
        return new Promise((resolve, rejectPromise) => {
          pending.push({ resolve, signal });
          signal?.addEventListener('abort', () => rejectPromise(new Error('aborted')), {
            once: true,
          });
        });
      },
      async createResponse(body) {
        inspectionCalls++;
        const input = body as any;
        assert.equal(input.text.format.name, 'scene_inspection');
        const context = JSON.parse(input.input[0].content[0].text);
        return {
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    verdict: reject ? 'reject' : 'pass',
                    contradictions: reject
                      ? [{ ruleId: context.rules[0].ruleId, reason: 'major test mismatch' }]
                      : [],
                  }),
                },
              ],
            },
          ],
        };
      },
    },
  });
  const server = hosted.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  config.allowedHosts.add(new URL(origin).host);
  config.allowedOrigins.add(origin);
  t.after(async () => {
    await hosted.dispose();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const auth = await fetch(origin + '/api/auth', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ passphrase: 'scene-http-test-only' }),
  });
  const cookie = auth.headers.get('set-cookie')!.split(';')[0]!;
  async function request(
    path: string,
    play?: { playId: string; clientId: string },
    body?: unknown,
  ) {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        Cookie: cookie,
        ...(play
          ? { 'X-Play-Id': play.playId, 'X-Client-Id': play.clientId, 'X-Control-Epoch': '1' }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return response;
  }
  async function create(start = true) {
    const clientId = randomUUID();
    const response = await request('/api/plays', undefined, {
      requestId: randomUUID(),
      clientId,
      locale: 'ja',
    });
    assert.equal(response.status, 201);
    const play = { playId: (await response.json()).playId, clientId };
    if (start) {
      const live = await request('/api/play/live', play, { requestId: randomUUID(), sdp: 'offer' });
      assert.equal(live.status, 201);
      const generation = (await live.json()).generation;
      assert.equal(
        (await request('/api/play/heartbeat', play, { generation, voiceState: 'connected' }))
          .status,
        200,
      );
      const again = await request('/api/play/heartbeat', play, {
        generation,
        voiceState: 'connected',
      });
      assert.equal(again.status, 200);
      assert.equal((await again.json()).state.status, 'playing');
    }
    return play;
  }
  async function messages(play: { playId: string; clientId: string }): Promise<ChatMessage[]> {
    const response = await request('/api/play/feed', play);
    assert.equal(response.status, 200);
    return (await response.json()).upserts;
  }
  return {
    hosted,
    request,
    create,
    messages,
    pending,
    counts: () => ({ imageCalls, inspectionCalls }),
    resolve: () => {
      const p = pending.shift();
      assert.ok(p);
      p.resolve({ data: [{ b64_json: jpeg.toString('base64') }] });
    },
  };
}
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('test condition timed out');
}

test('start image stays private until passed inspection, then attaches to its original message', async (t) => {
  const f = await setup(t),
    play = await f.create();
  await until(() => f.pending.length === 1);
  const before = (await f.messages(play)).find((m) => m.imageSlot)!;
  assert.ok(before);
  assert.equal(before.imageSlot!.assetId, null);
  assert.notEqual(before.imageSlot!.status, 'ready');
  f.resolve();
  await until(
    async () =>
      !!(await f.messages(play)).find((m) => m.id === before.id && m.imageSlot?.status === 'ready'),
  );
  const message = (await f.messages(play)).find((m) => m.id === before.id)!;
  const asset = await f.request('/api/play/assets/' + message.imageSlot!.assetId, play);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type') ?? '', /image\/jpeg/);
  assert.deepEqual(f.counts(), { imageCalls: 1, inspectionCalls: 1 });
});
test('two rejected generations fail the original slot without publishing assets', async (t) => {
  const f = await setup(t, true),
    play = await f.create();
  await until(() => f.pending.length === 1);
  f.resolve();
  await until(() => f.pending.length === 1);
  f.resolve();
  await until(async () => (await f.messages(play)).some((m) => m.imageSlot?.status === 'failed'));
  const slot = (await f.messages(play)).find((m) => m.imageSlot)!.imageSlot!;
  assert.equal(slot.assetId, null);
  assert.equal(slot.errorCode, 'SCENE_RECEIVE_FAILED');
  assert.deepEqual(f.counts(), { imageCalls: 2, inspectionCalls: 2 });
});

test('scene stays checking while saving its asset and publishes ready with a readable image atomically', async (t) => {
  const f = await setup(t);
  const originalPutAsset = f.hosted.results.putAsset.bind(f.hosted.results);
  let release!: () => void;
  const saving = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  f.hosted.results.putAsset = async (playId, input) => {
    entered = true;
    await saving;
    return originalPutAsset(playId, input);
  };
  try {
    const play = await f.create();
    await until(() => f.pending.length === 1);
    f.resolve();
    await until(() => entered);
    const pending = (await f.messages(play)).find((m) => m.imageSlot)!.imageSlot!;
    assert.equal(pending.status, 'checking');
    assert.equal(pending.assetId, null);
    assert.deepEqual(f.hosted.results.readySceneReferences(play.playId, 0), []);
    release();
    await until(async () => (await f.messages(play)).some((m) => m.imageSlot?.status === 'ready'));
    const ready = (await f.messages(play)).find((m) => m.imageSlot?.status === 'ready')!.imageSlot!;
    assert.ok(ready.assetId);
    assert.equal((await f.request('/api/play/assets/' + ready.assetId, play)).status, 200);
    assert.equal(f.hosted.results.readySceneReferences(play.playId, 0).length, 1);
  } finally {
    release();
  }
});
test('started image survives manual end and stays out of the next play', async (t) => {
  const f = await setup(t),
    old = await f.create();
  await until(() => f.pending.length === 1);
  assert.equal((await f.request('/api/play/end', old, {})).status, 200);
  const next = await f.create(false);
  f.resolve();
  await until(async () => (await f.messages(old)).some((m) => m.imageSlot?.status === 'ready'));
  const oldMessage = (await f.messages(old)).find((m) => m.imageSlot?.status === 'ready')!;
  assert.ok(!(await f.messages(next)).some((m) => m.id === oldMessage.id));
  assert.equal(
    (await f.request('/api/play/assets/' + oldMessage.imageSlot!.assetId, next)).status,
    404,
  );
});
test('drain aborts an in-flight generation and cannot publish a late image', async (t) => {
  const f = await setup(t),
    play = await f.create();
  await until(() => f.pending.length === 1);
  const pending = f.pending[0]!;
  await f.hosted.drain();
  assert.equal(pending.signal?.aborted, true);
  await until(async () => (await f.messages(play)).some((m) => m.imageSlot?.status === 'failed'));
  f.resolve();
  await new Promise((r) => setTimeout(r, 40));
  assert.ok((await f.messages(play)).every((m) => m.imageSlot?.status !== 'ready'));
  assert.equal(f.counts().inspectionCalls, 0);
});

test('clock loss registers one terminal scene and delivers it after Live is closed', async (t) => {
  const f = await setup(t),
    play = await f.create();
  await until(() => f.pending.length === 1);
  f.resolve();
  await until(async () => (await f.messages(play)).some((m) => m.imageSlot?.status === 'ready'));
  // Inject only the elapsed game-clock condition; HTTP state reads run the actual ending path.
  f.hosted.registry.plays.get(play.playId)!.runtime!.game.clock.remainingMs = 0;
  const state = await (await f.request('/api/play/state', play)).json();
  assert.equal(state.state.status, 'lost');
  await until(() => f.pending.length === 1);
  await f.request('/api/play/state', play);
  assert.equal((await f.messages(play)).filter((m) => m.imageSlot).length, 2);
  assert.equal((await f.request('/api/play/end', play, {})).status, 200);
  f.resolve();
  await until(
    async () =>
      (await f.messages(play)).filter((m) => m.imageSlot?.status === 'ready').length === 2,
  );
  assert.deepEqual(f.counts(), { imageCalls: 2, inspectionCalls: 2 });
});
