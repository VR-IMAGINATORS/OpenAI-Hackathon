import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { createHostedApp } from '../apps/server/app.js';
import { loadHostedConfig } from '../apps/server/config.js';
import type { PreparedEnding } from '../apps/server/ending-jobs.js';
import type { EndingPacket } from '../apps/local-server/ending.js';
import type { EndingView } from '../packages/shared/ending.js';
import { syntheticEndingMp4 } from './helpers/ending-mp4.js';

const passphrase = 'test-only-ending-password';
const video = syntheticEndingMp4();
const prepared: PreparedEnding & { story: import('../packages/shared/ending.js').EndingStory } = {
  start: Buffer.from('injected-start-image'),
  end: Buffer.from('injected-end-image'),
  prompt: 'PRIVATE_ENDING_PROMPT',
  story: {
    title: '残った赤い印',
    text: '扉は開かなかったが、最初に見た印を残せた。',
    evaluation: '試した工夫と確定結果を残した。',
    tagId: null,
    tagCatalogVersion: 1,
  },
};

async function setup(t: TestContext, holdPreparation = false) {
  let now = 0;
  const config = loadHostedConfig({
    HOSTED_NO_ENV_FILE: '1',
    APP_PASSPHRASE: passphrase,
    AI_MODE: 'mock',
    ENDING_VIDEO_ENABLED: 'true',
    FAL_KEY: 'test-only-fal-key',
    AI_GLOBAL_VIDEO_ATTEMPTS: '10',
    RESULT_TTL_SECONDS: '600',
  });
  // Both transports are injected below; no live upstream is used by this test.
  config.ai.mode = 'live';
  let releasePreparation!: () => void;
  const preparationGate = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  const counts = { prepare: 0, submit: 0, download: 0 };
  const packets: EndingPacket[] = [];
  const hosted = createHostedApp(config, {
    now: () => now,
    wallNow: () => Date.UTC(2026, 8, 14),
    log() {},
    transport: {
      async createLiveSession() {
        throw new Error('NO_LIVE_CALL_EXPECTED');
      },
      async createResponse(body) {
        assert.equal((body as any).text.format.name, 'ending_text');
        return {
          output: [
            {
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    title: prepared.story.title,
                    story: prepared.story.text,
                    evaluation: prepared.story.evaluation,
                    tag: null,
                    usedEvidenceIds: [],
                  }),
                },
              ],
            },
          ],
        };
      },
      async createImage() {
        throw new Error('SCENE_IMAGE_DISABLED_IN_HTTP_TEST');
      },
      async hangup() {},
    },
    ending: {
      graceMs: 0,
      pollMs: 1,
      async prepare(_jobId, packet, signal, publishedStory) {
        counts.prepare++;
        packets.push(packet);
        assert.deepEqual(publishedStory, prepared.story);
        if (holdPreparation)
          await Promise.race([
            preparationGate,
            new Promise<never>((_resolve, reject) => {
              if (signal.aborted) reject(signal.reason);
              else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            }),
          ]);
        return prepared;
      },
      fal: {
        async submit() {
          counts.submit++;
          return {
            requestId: 'PRIVATE_REQUEST_ID',
            statusUrl: 'PRIVATE_STATUS_URL',
            resultUrl: 'PRIVATE_RESULT_URL',
            cancelUrl: 'PRIVATE_CANCEL_URL',
          };
        },
        async status() {
          return 'COMPLETED';
        },
        async result() {
          return { videoUrl: 'https://private-provider.invalid/PRIVATE_VIDEO' };
        },
        async cancel() {
          return { stopConfirmed: true };
        },
        async downloadVideo() {
          counts.download++;
          return video;
        },
      },
    },
  });
  const server = hosted.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  config.allowedHosts.add(new URL(origin).host);
  config.allowedOrigins.add(origin);
  t.after(async () => {
    releasePreparation();
    await hosted.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  async function request(
    path: string,
    options: {
      cookie?: string;
      body?: unknown;
      method?: string;
      origin?: string | false;
      headers?: Record<string, string>;
    } = {},
  ) {
    return fetch(origin + path, {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(options.origin === false ? {} : { Origin: options.origin ?? origin }),
        'Content-Type': 'application/json',
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  }
  async function login() {
    const response = await request('/api/auth', { body: { passphrase } });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie')!.split(';')[0]!;
  }
  async function wrongHostRequest(path: string, cookie: string) {
    return new Promise<{ status: number; body: { error: { code: string } } }>((resolve, reject) => {
      const request = httpRequest(
        origin + path,
        {
          headers: { Host: 'other.invalid', Cookie: cookie },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          response.on('end', () =>
            resolve({
              status: response.statusCode!,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            }),
          );
          response.on('error', reject);
        },
      );
      request.on('error', reject);
      request.end();
    });
  }
  async function create(cookie: string) {
    const response = await request('/api/plays', {
      cookie,
      body: { clientId: randomUUID(), requestId: randomUUID(), locale: 'ja' },
    });
    assert.equal(response.status, 201);
    const { playId } = await response.json();
    return playId as string;
  }
  function endByGameTime(playId: string) {
    const play = hosted.registry.plays.get(playId)!;
    const runtime = play.runtime!;
    runtime.game.heartbeat('connected');
    runtime.start();
    runtime.game.clock.remainingMs = 0;
    runtime.game.check();
    assert.equal(runtime.game.endReason, 'time_limit');
    return hosted.results.ending(play.ownerDigest, playId);
  }
  const statusPath = (playId: string) => '/api/play/ending?playId=' + playId;
  const videoPath = (playId: string) => '/api/play/ending/video?playId=' + playId;
  const downloadPath = (playId: string) => videoPath(playId) + '&download=1';
  async function ready(cookie: string, playId: string): Promise<EndingView> {
    for (let i = 0; i < 200; i++) {
      const response = await request(statusPath(playId), { cookie });
      assert.equal(response.status, 200);
      const state = (await response.json()) as EndingView;
      if (state.status === 'ready') return state;
      assert.notEqual(state.status, 'failed', state.errorCode ?? 'ending failed');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('ending did not complete');
  }
  return {
    hosted,
    counts,
    packets,
    request,
    login,
    create,
    endByGameTime,
    ready,
    statusPath,
    videoPath,
    downloadPath,
    releasePreparation,
    wrongHostRequest,
    setNow(value: number) {
      now = value;
    },
  };
}

function privateResponse(response: Response) {
  assert.match(response.headers.get('cache-control') ?? '', /private.*no-store/);
  assert.match(response.headers.get('vary') ?? '', /Cookie/i);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}

test('game timeout queues one ending, keeps factual results visible, then completes after runtime retirement', async (t) => {
  const f = await setup(t, true);
  const cookie = await f.login(),
    playId = await f.create(cookie);
  const initial = f.endByGameTime(playId);
  assert.equal(initial.status, 'queued');
  assert.equal(initial.outcome, 'bad');
  assert.equal(initial.clearedCount, 0);
  const waiting = await f.request(f.statusPath(playId), { cookie });
  assert.equal(waiting.status, 200);
  const early = (await waiting.json()) as EndingView;
  assert.equal(early.status, 'preparing');
  assert.equal(early.storyStatus, 'ready');
  assert.deepEqual(early.story, prepared.story);
  assert.equal(f.counts.submit, 0, 'owner can read text before video submission');
  assert.equal((await f.request(f.videoPath(playId), { cookie })).status, 409);
  const state = await f.request('/api/play/state', { cookie, headers: { 'X-Play-Id': playId } });
  assert.equal(state.status, 200);
  assert.equal((await state.json()).state.status, 'lost');
  // This fixture has no playback telemetry: use the abandoned-call timeout.
  f.setNow(60_001);
  await f.hosted.tick();
  assert.equal(f.hosted.registry.plays.get(playId)!.runtime, null);
  assert.equal(f.hosted.registry.plays.get(playId)!.lifecycle, 'terminal');
  f.releasePreparation();
  const ending = await f.ready(cookie, playId);
  assert.equal(ending.videoPath, f.videoPath(playId));
  assert.deepEqual(ending.story, prepared.story);
  assert.ok(ending.retainUntil);
  const response = await f.request(ending.videoPath!, { cookie });
  assert.equal(response.status, 200);
  privateResponse(response);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(response.headers.get('content-disposition'), null, 'playback remains inline');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), video);
  assert.deepEqual(f.counts, { prepare: 1, submit: 1, download: 1 });
  assert.equal(f.packets[0].endReason, 'time_limit');
  assert.ok(f.packets[0].finalMessageId);
  assert.doesNotMatch(JSON.stringify(ending), /PRIVATE_|private-provider|test-only-fal-key/);
});

test('ending status and video authenticate cookies and return 404 to another owner', async (t) => {
  const f = await setup(t);
  const alice = await f.login(),
    bob = await f.login(),
    playId = await f.create(alice);
  assert.equal((await f.request(f.statusPath(playId), { cookie: alice })).status, 409);
  assert.equal(f.counts.submit, 0);
  f.endByGameTime(playId);
  await f.ready(alice, playId);
  for (const path of [f.statusPath(playId), f.videoPath(playId), f.downloadPath(playId)]) {
    for (const cookie of [undefined, 'play_session=unknown-token']) {
      const response = await f.request(path, { cookie });
      assert.equal(response.status, cookie === undefined ? 401 : 410);
      privateResponse(response);
    }
    const forbidden = await f.request(path, { cookie: bob });
    assert.equal(forbidden.status, 404);
    privateResponse(forbidden);
    assert.equal((await f.request(path, { cookie: alice })).status, 200);
  }
  assert.equal((await f.request(f.statusPath(randomUUID()), { cookie: alice })).status, 410);
  assert.equal((await f.request(f.videoPath(randomUUID()), { cookie: alice })).status, 410);
  assert.equal(
    (
      await f.request(f.statusPath(playId), {
        cookie: alice,
        headers: { 'X-Play-Id': randomUUID() },
      })
    ).status,
    400,
  );
});

test('video download returns the retained MP4 as an attachment without generating again', async (t) => {
  const f = await setup(t, true),
    cookie = await f.login(),
    playId = await f.create(cookie);
  f.endByGameTime(playId);
  const pending = await f.request(f.downloadPath(playId), { cookie });
  assert.equal(pending.status, 409);
  assert.equal(pending.headers.get('content-disposition'), null);
  f.releasePreparation();
  await f.ready(cookie, playId);
  for (const method of ['GET', 'HEAD']) {
    const response = await f.request(f.downloadPath(playId), { cookie, method, origin: false });
    assert.equal(response.status, 200);
    privateResponse(response);
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.equal(response.headers.get('content-length'), String(video.length));
    assert.equal(
      response.headers.get('content-disposition'),
      `attachment; filename="call-to-the-past-${playId}.mp4"`,
    );
    assert.deepEqual(
      Buffer.from(await response.arrayBuffer()),
      method === 'HEAD' ? Buffer.alloc(0) : video,
    );
  }
  const resumed = await f.request(f.downloadPath(playId), {
    cookie,
    origin: false,
    headers: { Range: 'bytes=16-' },
  });
  assert.equal(resumed.status, 206);
  assert.match(resumed.headers.get('content-disposition') ?? '', /^attachment;/);
  assert.deepEqual(Buffer.from(await resumed.arrayBuffer()), video.subarray(16));
  const invalid = await f.request(f.videoPath(playId) + '&download=invalid', { cookie });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get('content-disposition'), null);
  assert.deepEqual(f.counts, { prepare: 1, submit: 1, download: 1 });
});

test('MP4 supports no-Origin GET, HEAD and exact single byte ranges without a controller lease', async (t) => {
  const f = await setup(t),
    cookie = await f.login(),
    playId = await f.create(cookie);
  f.endByGameTime(playId);
  await f.ready(cookie, playId);
  const head = await f.request(f.videoPath(playId), { cookie, origin: false, method: 'HEAD' });
  assert.equal(head.status, 200);
  privateResponse(head);
  assert.equal(head.headers.get('accept-ranges'), 'bytes');
  assert.equal(head.headers.get('content-length'), String(video.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  for (const [range, start, end] of [
    ['bytes=0-15', 0, 15],
    ['bytes=16-', 16, video.length - 1],
    ['bytes=-8', video.length - 8, video.length - 1],
    ['bytes=0-999999', 0, video.length - 1],
  ] as const) {
    const response = await f.request(f.videoPath(playId), {
      cookie,
      origin: false,
      headers: { Range: range },
    });
    assert.equal(response.status, 206);
    privateResponse(response);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${video.length}`);
    assert.equal(response.headers.get('content-length'), String(end - start + 1));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), video.subarray(start, end + 1));
  }
  const rangeHead = await f.request(f.videoPath(playId), {
    cookie,
    origin: false,
    method: 'HEAD',
    headers: { Range: 'bytes=0-15' },
  });
  assert.equal(rangeHead.status, 206);
  assert.equal(rangeHead.headers.get('content-length'), '16');
  assert.equal((await rangeHead.arrayBuffer()).byteLength, 0);
  assert.deepEqual(f.counts, { prepare: 1, submit: 1, download: 1 });
});

test('invalid or multiple ranges return 416 and host/origin guards still apply to video', async (t) => {
  const f = await setup(t),
    cookie = await f.login(),
    playId = await f.create(cookie);
  f.endByGameTime(playId);
  await f.ready(cookie, playId);
  for (const range of [
    'bytes=',
    'bytes=-',
    'bytes=-0',
    'bytes=10-2',
    'bytes=0-1,4-5',
    'bytes=999999-',
    'bytes=9007199254740992-',
    'items=0-1',
  ]) {
    const response = await f.request(f.videoPath(playId), { cookie, headers: { Range: range } });
    assert.equal(response.status, 416, range);
    privateResponse(response);
    assert.equal(response.headers.get('content-range'), `bytes */${video.length}`);
  }
  const wrongOrigin = await f.request(f.videoPath(playId), {
    cookie,
    origin: 'https://other.invalid',
  });
  assert.equal(wrongOrigin.status, 403);
  assert.equal((await wrongOrigin.json()).error.code, 'ORIGIN_FORBIDDEN');
  const wrongHost = await f.wrongHostRequest(f.videoPath(playId), cookie);
  assert.equal(wrongHost.status, 403);
  assert.equal(wrongHost.body.error.code, 'HOST_FORBIDDEN');
});

test('retained video reads survive expired login, never extend retention, and return 410 at expiry', async (t) => {
  const f = await setup(t),
    cookie = await f.login(),
    playId = await f.create(cookie);
  f.hosted.sessions.authorize(cookie.slice('play_session='.length)).expiresAt = 100;
  f.endByGameTime(playId);
  const initial = await f.ready(cookie, playId);
  f.setNow(60_001);
  await f.hosted.tick();
  for (const at of [12_001, 599_999]) {
    f.setNow(at);
    const status = await f.request(f.statusPath(playId), { cookie });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).retainUntil, initial.retainUntil);
    assert.equal((await f.request(f.videoPath(playId), { cookie })).status, 200);
    assert.equal((await f.request(f.downloadPath(playId), { cookie })).status, 200);
  }
  f.setNow(600_000);
  await f.hosted.tick();
  // Renew authentication without recreating the missing result, so expiry is tested independently.
  const renewed = await f.request('/api/auth', { cookie, body: { passphrase } });
  assert.equal(renewed.status, 200);
  const renewedCookie = renewed.headers.get('set-cookie')!.split(';')[0]!;
  assert.equal((await f.request(f.statusPath(playId), { cookie: renewedCookie })).status, 410);
  assert.equal((await f.request(f.videoPath(playId), { cookie: renewedCookie })).status, 410);
  const expired = await f.request(f.downloadPath(playId), { cookie: renewedCookie });
  assert.equal(expired.status, 410);
  assert.equal(expired.headers.get('content-disposition'), null);
  assert.deepEqual(f.counts, { prepare: 1, submit: 1, download: 1 });
});

test('repeated GETs never submit again and replay keeps the previous video out of the new play', async (t) => {
  const f = await setup(t),
    cookie = await f.login(),
    previous = await f.create(cookie);
  f.endByGameTime(previous);
  await f.ready(cookie, previous);
  f.setNow(60_001);
  await f.hosted.tick();
  const next = await f.create(cookie);
  assert.notEqual(next, previous);
  for (let i = 0; i < 3; i++) {
    assert.equal((await f.request(f.statusPath(previous), { cookie })).status, 200);
    assert.equal((await f.request(f.videoPath(previous), { cookie })).status, 200);
    assert.equal((await f.request(f.statusPath(next), { cookie })).status, 409);
    assert.equal((await f.request(f.videoPath(next), { cookie })).status, 409);
  }
  assert.deepEqual(f.counts, { prepare: 1, submit: 1, download: 1 });
});

test('interrupted play exposes not_applicable and never starts preparation or video generation', async (t) => {
  const f = await setup(t),
    cookie = await f.login(),
    playId = await f.create(cookie);
  await f.hosted.registry.end(f.hosted.registry.plays.get(playId)!);
  const response = await f.request(f.statusPath(playId), { cookie });
  assert.equal(response.status, 200);
  const ending = (await response.json()) as EndingView;
  assert.equal(ending.status, 'not_applicable');
  assert.equal(ending.outcome, null);
  assert.equal(ending.videoPath, null);
  assert.equal((await f.request(f.videoPath(playId), { cookie })).status, 409);
  assert.deepEqual(f.counts, { prepare: 0, submit: 0, download: 0 });
});
