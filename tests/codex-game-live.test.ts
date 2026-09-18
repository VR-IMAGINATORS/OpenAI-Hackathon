import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { AddressInfo } from 'node:net';
import { Rpc } from '../tools/codex-poc/rpc.js';
import { CodexGameVoice, type GameVoiceReport } from '../tools/codex-poc/game-voice.js';
import { CodexPlayerSessions } from '../tools/codex-poc/player-sessions.js';
import type { CodexWorker } from '../tools/codex-poc/worker.js';
import { localCodexEnvironment } from '../tools/play-codex.js';
import { loadHostedConfig } from '../apps/server/config.js';
import { createHostedApp } from '../apps/server/app.js';
import { AiService } from '../packages/server/ai-service.js';
import { EndingJobs } from '../apps/server/ending-jobs.js';
import { ResultStore } from '../apps/server/result-store.js';
import type { EndingPacket } from '../apps/local-server/ending.js';
const flush = () => new Promise<void>((r) => setImmediate(r));
const request = {
  session: {
    model: 'gpt-live-1',
    instructions: 'public game facts',
    delegation: { type: 'client' },
    store: false,
  },
  transport: { type: 'webrtc', sdp: 'v=0 offer' },
};

function worker(mode = 'ok', generatedImage?: string) {
  const input = new PassThrough(),
    output = new PassThrough();
  const rpc = new Rpc(input, output);
  let usable = true,
    counter = 0;
  const calls: any[] = [];
  const emit = (m: unknown) => output.write(JSON.stringify(m) + '\n');
  input.on('data', (chunk) => {
    const m = JSON.parse(chunk.toString());
    calls.push(m);
    let result: any = {};
    if (m.method === 'modelProvider/capabilities/read')
      result = { imageGeneration: !!generatedImage };
    if (m.method === 'thread/start') result = { thread: { id: `thread-${++counter}` } };
    if (m.method === 'turn/start' && generatedImage) {
      const turnId = 'turn-' + m.params.threadId;
      const item = m.params.outputSchema
        ? {
            id: 'inspection',
            type: 'agentMessage',
            phase: 'final_answer',
            text: JSON.stringify({ verdict: 'pass', contradictions: [] }),
          }
        : {
            id: 'image',
            type: 'imageGeneration',
            status: 'completed',
            result: generatedImage,
            failure: null,
          };
      emit({ method: 'item/completed', params: { threadId: m.params.threadId, turnId, item } });
      emit({
        method: 'turn/completed',
        params: {
          threadId: m.params.threadId,
          turn: { id: turnId, status: 'completed', items: m.params.outputSchema ? [item] : [] },
        },
      });
      result = { turn: { id: turnId } };
    }
    if (m.method === 'thread/realtime/start') {
      emit({ method: 'thread/realtime/sdp', params: { threadId: 'stranger', sdp: 'v=0 wrong' } });
      emit({
        method: 'thread/realtime/started',
        params: { threadId: m.params.threadId, version: mode === 'wrong-version' ? 'v2' : 'v3' },
      });
      emit({
        method: 'thread/realtime/sdp',
        params: { threadId: m.params.threadId, sdp: 'v=0 answer' },
      });
      if (mode === 'error')
        emit({
          method: 'thread/realtime/error',
          params: { threadId: m.params.threadId, message: 'private credential' },
        });
    }
    if (m.method === 'thread/realtime/stop') {
      if (mode === 'stop-error') {
        emit({ id: m.id, error: { code: -1 } });
        return;
      }
      emit({ method: 'thread/realtime/closed', params: { threadId: m.params.threadId } });
    }
    emit({ id: m.id, result });
  });
  const value: CodexWorker = {
    rpc,
    work: 'fake',
    isUsable: () => usable,
    authenticate: async () => {},
    close: async () => {
      usable = false;
      rpc.fail();
    },
    invalidate: async () => {
      usable = false;
      rpc.fail();
    },
  };
  return { value, emit, calls };
}

test('subscription config removes keys and cannot instantiate an API fallback', () => {
  const env = localCodexEnvironment({
    HOSTED_NO_ENV_FILE: '1',
    OPENAI_API_KEY: 'private',
    FAL_KEY: 'private',
    ENDING_VIDEO_ENABLED: 'true',
  });
  const config = loadHostedConfig(env);
  assert.equal(env.OPENAI_API_KEY, '');
  assert.equal(config.ai.apiKey, undefined);
  assert.equal(config.ending!.enabled, false);
  assert.equal(config.ending!.apiKey, undefined);
  assert.equal(config.ai.gameModel, 'gpt-5.6-luna');
  assert.throws(() => new AiService(config.ai), /explicit subscription transport/);
  assert.throws(() => createHostedApp(config), /requires player/);
});

test('a winning subscription play skips both ending story and video generation', () => {
  const config = loadHostedConfig(localCodexEnvironment({ HOSTED_NO_ENV_FILE: '1' }));
  const noApi = async () => {
    throw new Error('Unexpected API call');
  };
  const ai = new AiService(config.ai, {
    createResponse: noApi,
    createLiveSession: noApi,
    hangup: noApi,
  });
  const results = new ResultStore();
  results.create({ playId: 'p', ownerDigest: 'owner', locale: 'ja', reserveEnding: true });
  const jobs = new EndingJobs(
    ai,
    { enabled: true, globalAttempts: 1, timeoutMs: 60000, concurrent: 1 },
    results,
  );
  jobs.enqueue(
    { playId: 'p', outcome: 'happy', clearedIds: ['a', 'b', 'c'] } as EndingPacket,
    () => {
      throw new Error('Must not generate ending');
    },
  );
  const ending = results.ending('owner', 'p');
  assert.equal(ending.status, 'disabled');
  assert.equal(ending.storyStatus, 'disabled');
  assert.equal(ending.outcome, 'happy');
  assert.equal(ending.clearedCount, 3);
  assert.equal(ai.snapshot().responseAttempts, 0);
  assert.equal(ai.snapshot().imageAttempts, 0);
  jobs.dispose();
});

test('game voice accepts early SDP, omits rejected fields and isolates its journal', async () => {
  const f = worker();
  const voice = new CodexGameVoice(f.value, 'gpt-5.6-luna');
  const answer = await voice.start(request);
  assert.equal(answer.transport.sdp, 'v=0 answer');
  const start = f.calls.find((m) => m.method === 'thread/realtime/start');
  assert.equal(start.params.version, 'v3');
  assert.equal(Object.hasOwn(start.params, 'model'), false);
  assert.equal(start.params.prompt, request.session.instructions);
  assert.equal(start.params.voice, 'juniper');
  assert.equal(start.params.clientManagedHandoffs, true);
  f.value.rpc.clearEvents();
  for (let i = 0; i < 5000; i++)
    f.emit({
      method: 'thread/realtime/itemAdded',
      params: { threadId: start.params.threadId, item: {} },
    });
  assert.equal(f.value.rpc.since(0).length, 0);
  assert.equal(f.value.isUsable(), true);
  f.emit({ method: 'turn/completed', params: { threadId: 'judgment', turn: { id: 'j' } } });
  assert.equal(f.value.rpc.since(0).length, 1);
  await voice.stop();
  await voice.stop();
  assert.equal(voice.isClosed(), true);
  assert.equal(f.calls.filter((m) => m.method === 'thread/realtime/stop').length, 1);
  await f.value.close();
});

test('close without an error distinguishes upstream closure from a server stop request', async () => {
  for (const serverStop of [false, true]) {
    const f = worker();
    const reports: GameVoiceReport[] = [];
    const voice = new CodexGameVoice(f.value, 'gpt-5.6-luna', (entry) => reports.push(entry));
    await voice.start(request);
    if (!serverStop) {
      const start = f.calls.find((m) => m.method === 'thread/realtime/start');
      f.emit({
        method: 'thread/realtime/closed',
        params: { threadId: start.params.threadId, reason: null },
      });
    }
    await voice.stop();
    const closed = reports.find((r) => r.status === 'closed')!;
    assert.equal(closed.code, serverStop ? 'AFTER_STOP_REQUEST' : 'WITHOUT_SERVER_STOP');
    assert.equal(closed.detail, 'No close reason supplied');
    assert.equal(reports.filter((r) => r.status === 'stopping').length, 1);
    await f.value.close();
  }
});

test('active upstream errors keep redacted details even for unknown classifications', async () => {
  const f = worker();
  const reports: GameVoiceReport[] = [];
  const voice = new CodexGameVoice(f.value, 'gpt-5.6-luna', (entry) => reports.push(entry));
  await voice.start(request);
  const start = f.calls.find((m) => m.method === 'thread/realtime/start');
  f.emit({
    method: 'thread/realtime/error',
    params: {
      threadId: start.params.threadId,
      message:
        'Unexpected field session.example; Bearer private-token; data:image/png;base64,private-image',
      unrelated: 'never expose this payload',
    },
  });
  await flush();
  const failure = reports.find((r) => r.status === 'failed')!;
  assert.equal(failure.code, 'UNKNOWN');
  assert.equal(failure.phase, 'active');
  assert.match(failure.detail!, /Unexpected field session.example/);
  assert.doesNotMatch(JSON.stringify(reports), /private-token|private-image|never expose/);
  assert.ok(reports.some((r) => r.status === 'closed'));
  await voice.stop();
  await f.value.close();
});

test('voice start/version/stop failures destroy auth without fallback or false closure', async () => {
  for (const mode of ['error', 'wrong-version', 'stop-error']) {
    const f = worker(mode),
      voice = new CodexGameVoice(f.value, 'gpt-5.6-luna');
    if (mode === 'stop-error') {
      await voice.start(request);
      await assert.rejects(voice.stop());
    } else await assert.rejects(voice.start(request));
    assert.equal(f.value.isUsable(), false);
    assert.equal(voice.isClosed(), false);
    assert.equal(f.calls.filter((m) => m.method === 'thread/realtime/start').length, 1);
  }
});

test('player voice is bound to its own worker and unknown plays cannot connect', async () => {
  const workers: ReturnType<typeof worker>[] = [];
  const manager = new CodexPlayerSessions({
    model: 'gpt-5.6-luna',
    capacity: 2,
    factory: async () => {
      const w = worker();
      workers.push(w);
      return w.value;
    },
    checkModel: async () => {},
    responder: () => async () => ({}),
  });
  try {
    manager.start('a');
    manager.start('b');
    await flush();
    manager.bind('a', 'pa');
    manager.bind('b', 'pb');
    await assert.rejects(manager.transport.createLiveSession(request, 'unknown'));
    const a = await manager.transport.createLiveSession(request, 'pa');
    const b = await manager.transport.createLiveSession(request, 'pb');
    assert.notEqual(a.session.id, b.session.id);
    await manager.transport.hangup(a.session.id);
    assert.equal(manager.transport.isLiveSessionClosed!(b.session.id), false);
    assert.equal(
      workers[1].calls.some((m) => m.method === 'thread/realtime/stop'),
      false,
    );
    await assert.rejects(manager.transport.createResponse({}), /SUBSCRIPTION_API_DISABLED/);
    await manager.release('pa');
    assert.equal(workers[0].value.isUsable(), true);
    manager.bind('a', 'pa-replay');
    const replay = await manager.transport.createLiveSession(request, 'pa-replay');
    assert.notEqual(replay.session.id, a.session.id);
    assert.equal(workers.length, 2);
    assert.equal(workers[0].calls.filter((m) => m.method === 'thread/realtime/start').length, 2);
    assert.equal(workers[1].value.isUsable(), true);
  } finally {
    await manager.dispose();
  }
});

test('keyless hosted game uses owned voice and generates inspected scene images', async (t) => {
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'blue' } })
    .png()
    .toBuffer();
  const f = worker('ok', png.toString('base64'));
  f.value.work = await mkdtemp(join(tmpdir(), 'codex-scene-test-'));
  t.after(() => rm(f.value.work, { recursive: true, force: true }));
  const manager = new CodexPlayerSessions({
    model: 'gpt-5.6-luna',
    capacity: 1,
    factory: async () => f.value,
    checkModel: async () => {},
    responder: () => async () => ({}),
  });
  const config = loadHostedConfig(localCodexEnvironment({ HOSTED_NO_ENV_FILE: '1' }));
  const app = createHostedApp(config, {
    playerJudgments: manager,
    transport: manager.transport,
    log: () => {},
  });
  let sceneMessageId = '';
  const appendMessage = app.results.appendMessage.bind(app.results);
  app.results.appendMessage = (...args) => {
    const result = appendMessage(...args);
    if (result.imageSlot) sceneMessageId = result.id;
    return result;
  };
  const server = app.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.allowedHosts.add(new URL(origin).host);
  config.allowedOrigins.add(origin);
  t.after(async () => {
    await app.dispose();
    server.closeAllConnections();
    server.close();
  });
  let cookie = '';
  const clientId = randomUUID();
  let playId = '';
  const call = (path: string, body?: unknown) =>
    fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Cookie: cookie,
        Origin: origin,
        'Content-Type': 'application/json',
        'X-Play-Id': playId,
        'X-Client-Id': clientId,
        'X-Control-Epoch': '1',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  cookie = (await call('/api/auth', {})).headers.get('set-cookie')!.split(';')[0];
  await call('/api/codex/login', {});
  await flush();
  const create = await call('/api/plays', { requestId: randomUUID(), clientId, locale: 'ja' });
  assert.equal(create.status, 201);
  playId = [...app.registry.plays.keys()][0];
  const live = await call('/api/play/live', { requestId: randomUUID(), sdp: 'v=0 offer' });
  const answer: any = await live.json();
  assert.equal(live.status, 201, JSON.stringify(answer));
  assert.equal(answer.sdp, 'v=0 answer');
  assert.deepEqual(answer.initialization, []);
  assert.equal(answer.sessionStarted, true);
  assert.equal(answer.protocol, 'codex-frameless');
  assert.ok(
    answer.initialization.every(
      (c: any) => c.type === 'session.instructions.append' && c.delegation_id === null,
    ),
  );
  const voiceStart = f.calls.find((m) => m.method === 'thread/realtime/start');
  assert.match(voiceStart.params.prompt, /client/);
  const beat = await call('/api/play/heartbeat', {
    generation: answer.generation,
    voiceState: 'connected',
  });
  assert.equal(beat.status, 200);
  const deadline = Date.now() + 5000;
  while (
    !f.calls.some((m) => m.method === 'turn/start' && m.params.outputSchema) &&
    Date.now() < deadline
  )
    await new Promise((r) => setTimeout(r, 20));
  assert.ok(f.calls.some((m) => m.method === 'turn/start' && m.params.outputSchema));
  assert.ok(app.ai.snapshot().imageAttempts > 0);
  // Simulate the separately tested opening-briefing delivery gate, not real speech.
  assert.ok(sceneMessageId);
  app.results.publishMessage(playId, sceneMessageId, 'Test opening briefing');
  let feed: any;
  while (Date.now() < deadline) {
    feed = await (await call('/api/play/feed')).json();
    if (feed.upserts?.some((m: any) => m.imageSlot?.status === 'ready')) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const scene = feed.upserts.find((m: any) => m.imageSlot?.status === 'ready');
  assert.ok(scene, JSON.stringify(feed));
  const asset = await call('/api/play/assets/' + scene.imageSlot.assetId);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type')!, /image\/jpeg/);
  const play = app.registry.plays.get(playId)!;
  play.runtime!.expire();
  await app.registry.end(play);
  assert.equal(app.ai.snapshot().responseAttempts, 0);
  assert.equal(f.value.isUsable(), true);
  await app.dispose();
  assert.equal(f.value.isUsable(), false);
});
