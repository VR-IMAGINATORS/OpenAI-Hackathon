import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import { createRelayApp } from '../apps/relay/app.js';
import { loadRelayConfig, type RelayConfig } from '../apps/relay/config.js';
import { createOpenAITransport, type OpenAITransport } from '../apps/relay/openai.js';
const liveBody = {
  session: {
    model: 'gpt-live-1',
    instructions: 'test',
    delegation: { type: 'client' },
    store: false,
  },
  transport: { type: 'webrtc', sdp: 'offer' },
};
const responseBody = {
  model: 'test-vision',
  instructions: 'test',
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'test' }] }],
  text: { format: { type: 'json_schema', name: 'test', strict: true, schema: { type: 'object' } } },
  store: false,
  max_output_tokens: 1000,
};
function config(): RelayConfig {
  return {
    ...loadRelayConfig({ FOUNDATION_DEMO: '1' }),
    mode: 'live',
    authMode: 'none',
    apiKey: 'fake-never-sent',
    authGlobalMaxAttempts: 100,
    live: {
      liveModels: ['gpt-live-1'],
      responseModels: ['test-vision'],
      tokenLiveAttempts: 3,
      tokenResponseAttempts: 2,
      globalLiveAttempts: 4,
      globalResponseAttempts: 3,
      globalLiveConcurrent: 1,
      globalResponseConcurrent: 1,
      durationMs: 600000,
      heartbeatMs: 30000,
      outputTokens: 1000,
    },
  };
}
async function setup(t: TestContext, upstream: Partial<OpenAITransport> = {}, conf = config()) {
  let ids = 0;
  const app = createRelayApp(conf, {
    createLiveSession: async () => ({
      session: { id: 'live_' + ++ids },
      transport: { type: 'webrtc', sdp: 'answer' },
    }),
    createResponse: async () => ({ output: [] }),
    hangup: async () => {},
    ...upstream,
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  t.after(async () => {
    await app.locals.relayShutdown?.();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const post = (path: string, body: unknown = {}, token?: string) =>
    fetch(base + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: JSON.stringify(body),
    });
  const token = async () => {
    const r = await post('/v1/sessions');
    return ((await r.json()) as { token: string }).token;
  };
  return { app, post, token };
}
test('paid routes require authentication and reject unapproved models/tools/remote images', async (t) => {
  let calls = 0;
  const a = await setup(t, {
    createResponse: async () => {
      calls++;
      return {};
    },
  });
  assert.equal((await a.post('/v1/responses', responseBody)).status, 401);
  const token = await a.token();
  for (const body of [
    { ...responseBody, tools: [] },
    { ...responseBody, model: 'unapproved' },
    {
      ...responseBody,
      input: [
        {
          role: 'user',
          content: [{ type: 'input_image', image_url: 'https://example.com/private' }],
        },
      ],
    },
  ])
    assert.equal((await a.post('/v1/responses', body, token)).status, 400);
  assert.equal(calls, 0);
});
test('Responses reserves before await, counts failed attempts, releases only concurrency', async (t) => {
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  const a = await setup(t, {
    createResponse: async () => {
      entered();
      await new Promise<void>((r) => (release = r));
      throw new Error('secret');
    },
  });
  const token = await a.token();
  const first = a.post('/v1/responses', responseBody, token);
  await ready;
  assert.equal((await a.post('/v1/responses', responseBody, token)).status, 429);
  release();
  const result = await first;
  assert.equal(result.status, 502);
  assert.doesNotMatch(await result.text(), /secret/);
});
test('global response attempts persist across tokens and failure', async (t) => {
  const c = config();
  c.live!.globalResponseAttempts = 1;
  const a = await setup(
    t,
    {
      createResponse: async () => {
        throw new Error();
      },
    },
    c,
  );
  assert.equal((await a.post('/v1/responses', responseBody, await a.token())).status, 502);
  assert.equal((await a.post('/v1/responses', responseBody, await a.token())).status, 429);
});
test('Live ownership, heartbeat deadline and confirmed hangup release concurrency', async (t) => {
  let now = 1000,
    hangups = 0;
  const c = config();
  c.now = () => now;
  const a = await setup(
    t,
    {
      hangup: async () => {
        hangups++;
      },
    },
    c,
  );
  const token = await a.token(),
    other = await a.token();
  assert.equal((await a.post('/v1/live/sessions', liveBody, token)).status, 201);
  assert.equal((await a.post('/v1/live/live_1/hangup', {}, other)).status, 404);
  assert.equal((await a.post('/v1/live/sessions', liveBody, token)).status, 429);
  now += 30001;
  await a.app.locals.relayWatchdog();
  assert.equal(hangups, 1);
  assert.equal((await a.post('/v1/live/sessions', liveBody, token)).status, 201);
});
test('unknown Live creation result and failed hangup retain paid slots', async (t) => {
  const a = await setup(t, {
    createLiveSession: async () => {
      throw new Error();
    },
  });
  const token = await a.token();
  assert.equal((await a.post('/v1/live/sessions', liveBody, token)).status, 502);
  assert.equal((await a.post('/v1/live/sessions', liveBody, await a.token())).status, 429);
  let hangups = 0;
  const b = await setup(t, {
    hangup: async () => {
      hangups++;
      throw new Error();
    },
  });
  const owner = await b.token();
  await b.post('/v1/live/sessions', liveBody, owner);
  assert.equal((await b.post('/v1/live/live_1/hangup', {}, owner)).status, 502);
  assert.equal(hangups, 3);
  assert.equal((await b.post('/v1/live/sessions', liveBody, owner)).status, 429);
});
test('Live creation in flight holds global slot before await', async (t) => {
  let resolve!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  const a = await setup(t, {
    createLiveSession: async () => {
      entered();
      await new Promise<void>((r) => (resolve = r));
      return { session: { id: 'live_one' }, transport: { type: 'webrtc', sdp: 'answer' } };
    },
  });
  const first = a.post('/v1/live/sessions', liveBody, await a.token());
  await ready;
  assert.equal((await a.post('/v1/live/sessions', liveBody, await a.token())).status, 429);
  resolve();
  assert.equal((await first).status, 201);
});
test('fixed OpenAI transport bounds response bytes, rejects redirects and validates Live response', async () => {
  let target = '';
  const transport = createOpenAITransport('test-only', async (url, init) => {
    target = String(url);
    assert.equal(init?.redirect, 'error');
    return new Response(JSON.stringify({ bad: true }), { status: 201 });
  });
  await assert.rejects(transport.createLiveSession(liveBody));
  assert.equal(target, 'https://api.openai.com/v1/live/sessions');
  const oversized = createOpenAITransport(
    'fake',
    async () => new Response('a'.repeat(256 * 1024 + 1)),
  );
  await assert.rejects(oversized.createResponse(responseBody));
});
test('live config requires credentials, explicit global budgets and allowlists', () => {
  assert.throws(() =>
    loadRelayConfig(
      { RELAY_MODE: 'live', RELAY_AUTH_MODE: 'none' },
      join(tmpdir(), 'callpast-no-config-' + randomUUID()),
    ),
  );
});
test('heartbeats cannot extend wall-clock duration and shutdown closes late creation', async (t) => {
  let now = 0,
    hangups = 0;
  const c = config();
  c.now = () => now;
  c.live!.durationMs = 40000;
  const a = await setup(
    t,
    {
      hangup: async () => {
        hangups++;
      },
    },
    c,
  );
  const token = await a.token();
  await a.post('/v1/live/sessions', liveBody, token);
  now = 20000;
  assert.equal((await a.post('/v1/live/live_1/heartbeat', {}, token)).status, 200);
  now = 40001;
  await a.app.locals.relayWatchdog();
  assert.equal(hangups, 1);
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((r) => (entered = r));
  const b = await setup(t, {
    createLiveSession: async () => {
      entered();
      await new Promise<void>((r) => (release = r));
      return { session: { id: 'late' }, transport: { type: 'webrtc', sdp: 'answer' } };
    },
    hangup: async () => {
      hangups++;
    },
  });
  const creating = b.post('/v1/live/sessions', liveBody, await b.token());
  await ready;
  const shutting = b.app.locals.relayShutdown();
  release();
  await creating;
  await shutting;
  assert.equal(hangups, 2);
});
test('global authentication attempts do not reset when fixed window recovers', async (t) => {
  let now = 0;
  const c = config();
  c.now = () => now;
  c.authGlobalMaxAttempts = 1;
  const a = await setup(t, {}, c);
  assert.equal((await a.post('/v1/sessions')).status, 200);
  now = 100000;
  assert.equal((await a.post('/v1/sessions')).status, 429);
});
