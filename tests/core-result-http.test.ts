import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import sharp from 'sharp';
import { createHostedApp } from '../apps/server/app.js';
import { loadHostedConfig } from '../apps/server/config.js';
import { openingHandoff } from '../apps/local-server/story.js';

async function setup(t: TestContext, withLive = false) {
  let now = 0;
  const config = loadHostedConfig({
    HOSTED_NO_ENV_FILE: '1',
    APP_PASSPHRASE: 'test-only-result-password',
    AI_MODE: 'mock',
  });
  const hosted = createHostedApp(config, {
    now: () => now,
    wallNow: () => Date.UTC(2026, 8, 13),
    log: () => {},
    ...(withLive
      ? {
          transport: {
            async createLiveSession() {
              return {
                session: { id: 'test-briefing-live' },
                transport: { type: 'webrtc', sdp: 'answer' },
              };
            },
            async hangup() {},
            async createResponse() {
              throw new Error('No text AI call expected for the opening');
            },
          },
        }
      : {}),
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
    options: {
      cookie?: string;
      playId?: string;
      clientId?: string;
      body?: unknown;
      method?: string;
    } = {},
  ) {
    const response = await fetch(origin + path, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(options.playId ? { 'X-Play-Id': options.playId } : {}),
        ...(options.clientId ? { 'X-Client-Id': options.clientId, 'X-Control-Epoch': '1' } : {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return response;
  }
  async function login() {
    const response = await request('/api/auth', {
      body: { passphrase: 'test-only-result-password' },
    });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie')!.split(';')[0]!;
  }
  async function create(cookie: string, locale: 'ja' | 'en' = 'ja') {
    const clientId = randomUUID(),
      requestId = randomUUID();
    const response = await request('/api/plays', { cookie, body: { clientId, requestId, locale } });
    assert.equal(response.status, 201);
    return { clientId, requestId, ...(await response.json()) };
  }
  return {
    hosted,
    request,
    login,
    create,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
function privateResponse(response: Response) {
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  assert.match(response.headers.get('vary') ?? '', /Cookie/i);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}

test('HTTP opening feed starts without text and streams into the same image bubble', async (t) => {
  const f = await setup(t);
  const cookie = await f.login();
  const play = await f.create(cookie);
  const control = { cookie, playId: play.playId, clientId: play.clientId };
  const connected = await f.request('/api/play/heartbeat', {
    ...control,
    body: { generation: 1, voiceState: 'connected' },
  });
  assert.equal(connected.status, 200);
  const feed = async () => {
    const response = await f.request('/api/play/feed', control);
    assert.equal(response.status, 200);
    return response.json();
  };
  const initial = await feed();
  assert.equal(initial.upserts.length, 1);
  const opening = initial.upserts[0];
  assert.equal(opening.text, '');
  assert.ok(opening.imageSlot);
  let expected = '';
  for (const [index, delta] of ['聞こえる？', '写真を送って。'].entries()) {
    const response = await f.request('/api/play/events', {
      ...control,
      body: {
        generation: 1,
        event: {
          type: 'session.output_transcript.delta',
          event_id: randomUUID(),
          delta,
          start_ms: index * 1000,
          end_ms: index * 1000 + 100,
        },
      },
    });
    assert.equal(response.status, 202);
    expected += delta;
    const current = await feed();
    assert.equal(current.upserts.length, 1);
    assert.equal(current.upserts[0].id, opening.id);
    assert.equal(current.upserts[0].text, expected);
    assert.ok(current.upserts[0].imageSlot);
  }
});

for (const locale of ['ja', 'en'] as const)
  test(
    'HTTP delivers a separate silent briefing after intro playback and retains it on reconnect: ' +
      locale,
    async (t) => {
      const f = await setup(t, true);
      const cookie = await f.login();
      const play = await f.create(cookie, locale);
      const control = { cookie, playId: play.playId, clientId: play.clientId };
      const post = async (path: string, body: unknown) => {
        const response = await f.request(path, { ...control, body });
        assert.ok(
          response.ok,
          `${path}: ${response.status} ${response.ok ? '' : await response.text()}`,
        );
        return response;
      };
      const live = await (
        await post('/api/play/live', { requestId: randomUUID(), sdp: 'offer' })
      ).json();
      await post('/api/play/heartbeat', { generation: live.generation, voiceState: 'connected' });
      const feed = async () => (await f.request('/api/play/feed', control)).json();
      const initial = await feed();
      assert.equal(initial.upserts.length, 1);
      assert.ok(initial.upserts[0].imageSlot, 'image generation begins before the introduction');
      let position = 100;
      const say = async (speaker: 'input' | 'output', delta: string) => {
        const event = {
          type: `session.${speaker}_transcript.delta`,
          event_id: randomUUID(),
          delta,
          start_ms: position,
          end_ms: position + 100,
        };
        position += 1000;
        await post('/api/play/events', { generation: live.generation, event });
        return event;
      };
      let sequence = 0;
      const activity = async (output: 'active' | 'quiet' | 'unknown', playbackReady = true) => {
        f.advance(100);
        await post('/api/play/voice-activity', {
          generation: live.generation,
          sequence: ++sequence,
          input: 'quiet',
          output,
          playbackReady,
        });
      };
      await say('output', locale === 'ja' ? '聞こえる？' : 'Can you hear me?');
      await say('input', locale === 'ja' ? '聞こえるよ' : 'I can hear you');
      await activity('active');
      await say('output', locale === 'ja' ? '私はメイ。' : 'I’m Mei.');
      await activity('quiet');
      assert.equal((await feed()).upserts.length, 3, 'a pause does not reveal the briefing');
      await activity('active');
      const finalEvent = await say('output', openingHandoff[locale]);
      await activity('quiet', false);
      assert.equal((await feed()).upserts.length, 3, 'blocked playback is not completion');
      await activity('unknown');
      assert.equal((await feed()).upserts.length, 3);
      await activity('quiet');
      const delivered = await feed();
      assert.equal(delivered.upserts.length, 4);
      const briefing = delivered.upserts[3];
      assert.equal(briefing.side, 'assistant');
      assert.equal(briefing.kind, 'system');
      assert.equal(briefing.relatedCommandSeq, null, 'display-only text has no speech command');
      assert.equal(briefing.imageSlot, null, 'no additional scene image job');
      assert.match(briefing.text, locale === 'ja' ? /特殊な通信/ : /special connection/);
      assert.ok(
        briefing.text.endsWith(
          locale === 'ja'
            ? '身近なものの写真を撮って、私に送ってください。そして、それをどう使うか教えて。'
            : 'Take a photo of something nearby and send it to me. Then tell me how to use it.',
        ),
      );
      await post('/api/play/events', { generation: live.generation, event: finalEvent });
      const reconnected = await (
        await post('/api/play/live', { requestId: randomUUID(), sdp: 'offer-2' })
      ).json();
      assert.equal(reconnected.opening, null);
      await post('/api/play/heartbeat', {
        generation: reconnected.generation,
        voiceState: 'connected',
      });
      assert.deepEqual(
        (await feed()).upserts.map((m: { id: string }) => m.id),
        delivered.upserts.map((m: { id: string }) => m.id),
      );
    },
  );

test('HTTP feed/assets require owner but no control lease and expose only JPEG bytes', async (t) => {
  const f = await setup(t),
    alice = await f.login(),
    bob = await f.login(),
    play = await f.create(alice);
  const message = f.hosted.results.appendMessage(play.playId, {
    side: 'user',
    kind: 'transcript',
    text: 'え、これを切って',
  });
  const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } })
    .jpeg()
    .toBuffer();
  const assetId = await f.hosted.results.putAsset(play.playId, {
    kind: 'photo',
    bytes,
    mime: 'image/jpeg',
  });
  f.hosted.results.appendMessage(play.playId, {
    side: 'user',
    kind: 'photo',
    text: '',
    assetIds: [assetId],
  });
  for (const path of ['/api/play/feed', '/api/play/assets/' + assetId]) {
    let response = await f.request(path, { playId: play.playId });
    assert.equal(response.status, 401);
    privateResponse(response);
    response = await f.request(path, { cookie: bob, playId: play.playId });
    assert.equal(response.status, 404);
    privateResponse(response);
    response = await f.request(path, { cookie: alice, playId: play.playId });
    assert.equal(response.status, 200);
    privateResponse(response);
    if (path.endsWith('feed')) {
      const feed = await response.json();
      assert.equal(feed.upserts[0].text, 'え、これを切って');
      assert.equal(feed.reset, true);
      assert.equal(feed.locale, 'ja');
    } else {
      assert.match(response.headers.get('content-type') ?? '', /image\/jpeg/);
      assert.equal(Buffer.from(await response.arrayBuffer())[0], 255);
    }
  }
  const incremental = await f.request('/api/play/feed?after=' + message.updatedVersion, {
    cookie: alice,
    playId: play.playId,
  });
  assert.equal((await incremental.json()).reset, false);
  assert.equal(
    (await f.request('/api/play/feed?after=99999', { cookie: alice, playId: play.playId })).status,
    400,
  );
});

test('locale is fixed on request replay and stateVersion is stable until state changes', async (t) => {
  const f = await setup(t),
    cookie = await f.login(),
    play = await f.create(cookie, 'en');
  const same = await f.request('/api/plays', {
    cookie,
    body: { clientId: play.clientId, requestId: play.requestId, locale: 'en' },
  });
  assert.equal(same.status, 200);
  const conflict = await f.request('/api/plays', {
    cookie,
    body: { clientId: play.clientId, requestId: play.requestId, locale: 'ja' },
  });
  assert.equal(conflict.status, 409);
  const first = await (await f.request('/api/play/state', { cookie, playId: play.playId })).json();
  const second = await (await f.request('/api/play/state', { cookie, playId: play.playId })).json();
  assert.equal(first.state.locale, 'en');
  assert.ok(first.state.stateVersion >= 1);
  assert.equal(second.state.stateVersion, first.state.stateVersion);
  const ended = await f.request('/api/play/end', {
    cookie,
    playId: play.playId,
    clientId: play.clientId,
    body: {},
  });
  assert.equal(ended.status, 200);
  const last = await (await f.request('/api/play/state', { cookie, playId: play.playId })).json();
  assert.ok(last.state.stateVersion > first.state.stateVersion);
});

test('retained results survive authentication expiry for reads only, then expire without extension', async (t) => {
  const f = await setup(t),
    cookie = await f.login(),
    play = await f.create(cookie);
  const token = cookie.slice('play_session='.length);
  f.hosted.sessions.authorize(token).expiresAt = 100;
  f.hosted.results.appendMessage(play.playId, {
    side: 'assistant',
    kind: 'result',
    text: '保持された結果',
  });
  assert.equal(
    (
      await f.request('/api/play/end', {
        cookie,
        playId: play.playId,
        clientId: play.clientId,
        body: {},
      })
    ).status,
    200,
  );
  f.advance(101);
  await f.hosted.tick();
  const restored = await f.request('/api/session', { cookie });
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).playId, play.playId);
  const retained = await f.request('/api/play/feed', { cookie, playId: play.playId });
  assert.equal(retained.status, 200);
  const until = (await retained.json()).retainUntil;
  assert.ok(until);
  assert.equal((await f.request('/api/play/state', { cookie, playId: play.playId })).status, 200);
  assert.equal(
    (
      await f.request('/api/plays', {
        cookie,
        body: { clientId: randomUUID(), requestId: randomUUID(), locale: 'ja' },
      })
    ).status,
    410,
  );
  f.advance(299_898);
  assert.equal((await f.request('/api/play/feed', { cookie, playId: play.playId })).status, 200);
  f.advance(1);
  await f.hosted.tick();
  assert.equal((await f.request('/api/play/feed', { cookie, playId: play.playId })).status, 410);
});
