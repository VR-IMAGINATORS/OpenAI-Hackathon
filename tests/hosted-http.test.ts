import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import sharp from 'sharp';
import { createHostedApp } from '../apps/server/app.js';
import { loadHostedConfig } from '../apps/server/config.js';

const opsToken = 'http-test-ops-secret-00000000000000000000';
const version = 'a'.repeat(40);
interface Client {
  cookie: string;
  clientId: string;
  playId?: string;
  epoch: number;
  generation?: number;
}
async function fixture(
  t: TestContext,
  failClose = false,
  core = false,
  hangup?: () => Promise<void>,
  closeTimeoutMs?: number,
) {
  let now = 0,
    liveCreates = 0,
    responses = 0,
    judgments = 0,
    hangups = 0;
  const logs: unknown[] = [];
  const config = loadHostedConfig({
    HOSTED_NO_ENV_FILE: '1',

    OPS_TOKEN: opsToken,
    AI_MODE: 'mock',
    APP_VERSION: version,
  });
  // Keep the legacy endpoint regression suite explicit during the core migration.
  if (!core) config.scenarioCatalog = undefined;
  if (closeTimeoutMs !== undefined) config.ai.timeoutMs = closeTimeoutMs;
  const hosted = createHostedApp(config, {
    now: () => now,
    wallNow: () => 1_000_000 + now,
    log: (event) => logs.push(event),
    transport: {
      async createLiveSession() {
        liveCreates++;
        return {
          session: { id: 'live_private_' + liveCreates },
          transport: { type: 'webrtc', sdp: 'fake-answer' },
        };
      },
      async createResponse(body) {
        responses++;
        const value = body as { input: { content: { type: string; text?: string }[] }[] };
        const context = JSON.parse(
          value.input[0].content.find((p) => p.type === 'input_text')!.text!,
        );
        let result;
        if (context.proposal) {
          judgments++;
          result = {
            success: true,
            narrative: '突破した',
            situation: '次の障害へ',
            inventoryChanges: [],
          };
        } else
          result = {
            items: [{ photoId: context.photos[0].id, inventoryId: null, name: '道具' }],
            usage: context.transcript ? 'てこにする' : '',
            summary: '道具を使う',
          };
        return {
          output: [
            { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] },
          ],
        };
      },
      async hangup() {
        hangups++;
        if (hangup) return hangup();
        if (failClose) throw new Error('private-provider-failure');
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
  async function request(
    path: string,
    body?: unknown,
    client?: Client,
    method = 'POST',
    headers: Record<string, string> = {},
  ) {
    const response = await fetch(origin + path, {
      method,
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        ...(client
          ? {
              Cookie: client.cookie,
              'X-Client-Id': client.clientId,
              'X-Control-Epoch': String(client.epoch),
              ...(client.playId ? { 'X-Play-Id': client.playId } : {}),
            }
          : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    assert.ok(!raw.includes(opsToken));
    assert.doesNotMatch(raw, /live_private_|private-provider-failure|data:image/);
    return { response, data: raw ? JSON.parse(raw) : null, raw };
  }
  async function auth(): Promise<Client> {
    const r = await request('/api/auth', {});
    assert.equal(r.response.status, 200, r.raw);
    const cookie = r.response.headers.get('set-cookie')!;
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    return { cookie: cookie.split(';')[0], clientId: randomUUID(), epoch: 1 };
  }
  async function create(c: Client, requestId = randomUUID()) {
    const r = await request(
      '/api/plays',
      { requestId, clientId: c.clientId, ...(core ? { locale: 'ja' } : {}) },
      c,
    );
    if (r.response.ok) {
      c.playId = r.data.playId;
      c.epoch = r.data.controlEpoch;
    }
    return r;
  }
  async function live(c: Client) {
    const r = await request('/api/play/live', { requestId: randomUUID(), sdp: 'fake-offer' }, c);
    assert.equal(r.response.status, 201, r.raw);
    c.generation = r.data.generation;
    assert.equal(
      (
        await request(
          '/api/play/heartbeat',
          { generation: c.generation, voiceState: 'connected' },
          c,
        )
      ).response.status,
      200,
    );
    return r;
  }
  return {
    hosted,
    config,
    origin,
    request,
    auth,
    create,
    live,
    logs,
    time: (n: number) => {
      now = n;
    },
    counts: () => ({ liveCreates, responses, judgments, hangups }),
  };
}

test('HTTP anonymous entry/Origin, independent five plays, sixth refusal, replay and cross-owner denial', async (t) => {
  const f = await fixture(t);
  const bootstrap = await f.request('/api/bootstrap', undefined, undefined, 'GET');
  assert.equal(bootstrap.data.auth.required, false);
  assert.equal((await f.request('/api/session', undefined, undefined, 'GET')).response.status, 401);
  assert.equal(
    (
      await f.request('/api/auth', {}, undefined, 'POST', {
        Origin: 'https://other.invalid',
      })
    ).response.status,
    403,
  );
  const clients = await Promise.all(Array.from({ length: 6 }, () => f.auth()));
  assert.equal(f.hosted.registry.occupied, 0);
  assert.equal(f.counts().liveCreates, 0);
  const requestId = randomUUID();
  const first = await f.create(clients[0], requestId);
  assert.equal(first.response.status, 201, first.raw);
  const renewed = await f.request('/api/auth', {}, clients[0]);
  assert.equal(renewed.response.status, 200);
  assert.equal(renewed.response.headers.get('set-cookie')!.split(';')[0], clients[0].cookie);
  const restored = await f.request('/api/session', undefined, clients[0], 'GET');
  assert.equal(restored.data.playId, first.data.playId);
  const duplicate = await f.create(clients[0], requestId);
  assert.equal(duplicate.response.status, 200, duplicate.raw);
  assert.equal(duplicate.data.playId, first.data.playId);
  const rest = await Promise.all(clients.slice(1, 5).map((c) => f.create(c)));
  rest.forEach((r) => assert.equal(r.response.status, 201, r.raw));
  assert.equal((await f.create(clients[5])).response.status, 409);
  const stolen = { ...clients[1], playId: clients[0].playId };
  assert.equal((await f.request('/api/play/state', undefined, stolen, 'GET')).response.status, 403);
  assert.equal((await f.request('/api/play/end', {}, clients[0])).response.status, 200);
  assert.equal((await f.create(clients[5])).response.status, 201);
});

test('HTTP tab takeover invalidates stale epoch and preserves play lifetime; expiry rejects recovery', async (t) => {
  const f = await fixture(t);
  const c = await f.auth();
  const created = await f.create(c);
  await f.live(c);
  const tab = { ...c, clientId: randomUUID() };
  assert.equal(
    (await f.request('/api/play/control', { clientId: tab.clientId, takeover: false }, tab))
      .response.status,
    409,
  );
  const takeover = await f.request(
    '/api/play/control',
    { clientId: tab.clientId, takeover: true },
    tab,
  );
  assert.equal(takeover.response.status, 200, takeover.raw);
  tab.epoch = takeover.data.controlEpoch;
  assert.equal(
    (
      await f.request(
        '/api/play/heartbeat',
        { generation: c.generation, voiceState: 'connected' },
        c,
      )
    ).response.status,
    409,
  );
  const state = await f.request('/api/play/state', undefined, tab, 'GET');
  assert.equal(state.data.expiresAt, created.data.expiresAt);
  f.time(60_000);
  await f.hosted.tick();
  assert.equal(
    (await f.request('/api/play/control', { clientId: tab.clientId, takeover: true }, tab)).response
      .status,
    410,
  );
});

test('HTTP photos and action retries charge once; another owner never receives transcript', async (t) => {
  const f = await fixture(t);
  const c = await f.auth();
  await f.create(c);
  await f.live(c);
  await f.request('/api/play/start', {}, c);
  const photo = (
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#abcdef' } })
      .png()
      .toBuffer()
  ).toString('base64');
  const payload = { requestId: randomUUID(), images: [photo] };
  const uploaded = await f.request('/api/play/photos', payload, c, 'PUT');
  assert.equal(uploaded.response.status, 200, uploaded.raw);
  const count = f.counts().responses;
  assert.equal((await f.request('/api/play/photos', payload, c, 'PUT')).response.status, 200);
  assert.equal(f.counts().responses, count);
  assert.equal(
    (await f.request('/api/play/photos', { ...payload, images: [] }, c, 'PUT')).response.status,
    409,
  );
  const transcript = 'private-conversation-sentinel';
  await f.request(
    '/api/play/events',
    {
      generation: c.generation,
      event: {
        type: 'session.input_transcript.delta',
        event_id: randomUUID(),
        delta: transcript,
        start_ms: 0,
        end_ms: 800,
      },
    },
    c,
  );
  const recognized = await f.request(
    '/api/play/events',
    {
      generation: c.generation,
      event: {
        type: 'session.delegation.created',
        event_id: randomUUID(),
        offset_ms: 800,
        delegation: { id: 'delegate', type: 'delegation', target: 'client' },
      },
    },
    c,
  );
  assert.equal(recognized.response.status, 200, recognized.raw);
  const action = {
    actionId: randomUUID(),
    proposalRevision: recognized.data.state.proposal.revision,
  };
  const first = await f.request('/api/play/actions', action, c);
  assert.equal(first.response.status, 200, first.raw);
  const retry = await f.request('/api/play/actions', action, c);
  assert.equal(retry.response.status, 200, retry.raw);
  assert.equal(retry.data.state.creditsRemaining, first.data.state.creditsRemaining);
  assert.equal(f.counts().judgments, 1);
  const other = await f.auth();
  await f.create(other);
  const state = await f.request('/api/play/state', undefined, other, 'GET');
  assert.ok(!state.raw.includes(transcript));
  assert.ok(!JSON.stringify(f.logs).includes(transcript));
  assert.ok(!JSON.stringify(f.logs).includes(photo));
});

test('HTTP ops require Bearer, reject browser Origin, drain closes audio and permits explicit resume', async (t) => {
  const f = await fixture(t);
  const c = await f.auth();
  await f.create(c);
  await f.live(c);
  const body = { requestId: randomUUID(), expectedVersion: version };
  assert.equal((await f.request('/api/ops/drain', body, c)).response.status, 403);
  // ops is a non-browser boundary: make requests without Origin.
  async function ops(path: string, method = 'GET', body?: unknown) {
    const r = await fetch(f.origin + path, {
      method,
      headers: { Authorization: 'Bearer ' + opsToken, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  }
  const started = await ops('/api/ops/drain', 'POST', body);
  assert.equal(started.status, 202);
  await f.hosted.drain();
  const status = await ops('/api/ops/drain');
  assert.equal(status.status, 200);
  assert.equal(status.data.readyToDeploy, true);
  assert.deepEqual(status.data.blockers, {
    registryOccupied: 0,
    liveBusy: 0,
    pendingCreates: 0,
    unknownCreates: 0,
    unconfirmedLive: 0,
    responseBusy: 0,
    imageBusy: 0,
    inspectionBusy: 0,
    endingJobs: 0,
  });
  assert.equal(f.counts().hangups, 1);
  assert.equal((await f.create(await f.auth())).response.status, 503);
  const resumed = await ops('/api/ops/resume', 'POST', {
    expectedVersion: version,
    expectedBootId: f.hosted.bootId,
  });
  assert.equal(resumed.status, 200);
  assert.equal((await f.create(await f.auth())).response.status, 201);
  const text = JSON.stringify(f.logs);
  assert.ok(!text.includes(opsToken));
});

test('HTTP restart invalidates cookies and unknown Live close keeps player reservation', async (t) => {
  const f = await fixture(t, true);
  const c = await f.auth();
  await f.create(c);
  await f.live(c);
  await f.request('/api/play/end', {}, c);
  assert.equal(f.hosted.registry.occupied, 1);
  const otherProcess = await fixture(t);
  assert.equal(
    (await otherProcess.request('/api/session', undefined, c, 'GET')).response.status,
    410,
  );
});

test('HTTP drain status reconciles a provider close confirmed after local timeout', async (t) => {
  let attempts = 0;
  let confirm!: () => void;
  const lateConfirmation = new Promise<void>((resolve) => {
    confirm = resolve;
  });
  const f = await fixture(
    t,
    false,
    false,
    () => (++attempts === 1 ? lateConfirmation : Promise.reject(new Error('still unknown'))),
    10,
  );
  const c = await f.auth();
  await f.create(c);
  await f.live(c);
  await f.request('/api/play/end', {}, c);
  await f.hosted.drain();
  const opsStatus = async () => {
    const response = await fetch(f.origin + '/api/ops/drain', {
      headers: { Authorization: 'Bearer ' + opsToken },
    });
    return response.json();
  };
  const blocked = await opsStatus();
  assert.equal(blocked.readyToDeploy, false);
  assert.equal(blocked.blockers.registryOccupied, 1);
  assert.equal(blocked.blockers.liveBusy, 1);
  assert.equal(blocked.blockers.unconfirmedLive, 1);
  confirm();
  await new Promise((r) => setImmediate(r));
  const ready = await opsStatus();
  assert.equal(ready.readyToDeploy, true);
  assert.equal(ready.remaining, 0);
  assert.equal(ready.blockers.registryOccupied, 0);
  assert.equal(ready.blockers.liveBusy, 0);
});

test('HTTP five simultaneous Live connections and retries reserve only five upstream calls', async (t) => {
  const f = await fixture(t);
  const clients = await Promise.all(Array.from({ length: 5 }, () => f.auth()));
  await Promise.all(clients.map((c) => f.create(c)));
  await Promise.all(clients.map((c) => f.live(c)));
  assert.equal(f.counts().liveCreates, 5);
  const c = clients[0];
  const payload = { requestId: randomUUID(), sdp: 'second-offer' };
  const first = await f.request('/api/play/live', payload, c);
  assert.equal(first.response.status, 201, first.raw);
  const duplicate = await f.request('/api/play/live', payload, c);
  assert.equal(duplicate.response.status, 200, duplicate.raw);
  assert.equal(first.data.sdp, duplicate.data.sdp);
  assert.equal(f.counts().liveCreates, 6);
  const wrong = await f.request('/api/play/live', { ...payload, sdp: 'different-offer' }, c);
  assert.equal(wrong.response.status, 409);
});

test('HTTP rejects unauthenticated photos before JSON parsing and wrong GET Origin', async (t) => {
  const f = await fixture(t);
  const raw = await fetch(f.origin + '/api/play/photos', {
    method: 'PUT',
    headers: { Origin: f.origin, 'Content-Type': 'application/json' },
    body: '{invalid',
  });
  assert.equal(raw.status, 401);
  const c = await f.auth();
  await f.create(c);
  const state = await f.request('/api/play/state', undefined, c, 'GET', {
    Origin: 'https://untrusted.invalid',
  });
  assert.equal(state.response.status, 403);
});

test('HTTP disconnected peer closes voice but permits same-play reconnect within grace', async (t) => {
  const f = await fixture(t);
  const c = await f.auth();
  const initial = await f.create(c);
  await f.live(c);
  const disconnected = await f.request(
    '/api/play/heartbeat',
    { generation: c.generation, voiceState: 'closed' },
    c,
  );
  assert.equal(disconnected.response.status, 200, disconnected.raw);
  assert.equal(disconnected.data.lifecycle, 'recovering');
  assert.equal(disconnected.data.state.status, 'briefing');
  assert.equal(f.counts().hangups, 1);
  f.time(20_000);
  await f.live(c);
  const state = await f.request('/api/play/state', undefined, c, 'GET');
  assert.equal(state.data.playId, initial.data.playId);
  assert.equal(state.data.expiresAt, initial.data.expiresAt);
  assert.equal(state.data.lifecycle, 'active');
});

test('voice activity is advisory, owner-bound, strict and separately limited to four per second', async (t) => {
  const f = await fixture(t, false, true);
  const c = await f.auth();
  await f.create(c);
  await f.live(c);
  const path = '/api/play/voice-activity';
  const activity = {
    generation: c.generation,
    sequence: 1,
    input: 'quiet',
    output: 'quiet',
    playbackReady: true,
  };
  const before = (await f.request('/api/play/state', undefined, c, 'GET')).data.state;
  assert.equal((await f.request(path, activity, c)).response.status, 202);
  assert.equal((await f.request(path, activity, c)).response.status, 202); // old sequence ignored
  assert.equal(
    (await f.request(path, { ...activity, generation: c.generation! + 1 }, c)).response.status,
    409,
  );
  assert.equal(
    (await f.request(path, { ...activity, remainingMs: 999999 }, c)).response.status,
    400,
  );
  assert.equal(
    (await f.request(path, activity, c, 'POST', { Origin: 'https://other.invalid' })).response
      .status,
    403,
  );
  const other = await f.auth();
  assert.equal(
    (await f.request(path, activity, { ...c, cookie: other.cookie })).response.status,
    403,
  );
  assert.equal(
    (await f.request(path, activity, { ...c, epoch: c.epoch + 1 })).response.status,
    409,
  );
  const after = (await f.request('/api/play/state', undefined, c, 'GET')).data.state;
  assert.equal(after.remainingMs, before.remainingMs);
  assert.equal(after.creditsRemaining, before.creditsRemaining);
  assert.equal(after.actionsUsed, before.actionsUsed);
  f.time(2000);
  for (let sequence = 2; sequence <= 9; sequence++)
    assert.equal((await f.request(path, { ...activity, sequence }, c)).response.status, 202);
  assert.equal((await f.request(path, { ...activity, sequence: 10 }, c)).response.status, 429);
  f.time(2250);
  assert.equal((await f.request(path, { ...activity, sequence: 10 }, c)).response.status, 202);
  await f.request('/api/play/end', {}, c);
  assert.equal((await f.request(path, { ...activity, sequence: 11 }, c)).response.status, 410);
});
