import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { CodexPlayerSessions } from '../tools/codex-poc/player-sessions.js';
import type { CodexWorker } from '../tools/codex-poc/worker.js';
import { createHostedApp } from '../apps/server/app.js';
import { loadHostedConfig } from '../apps/server/config.js';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((r) => setImmediate(r));
function fixture(capacity = 2) {
  let now = 0;
  const workers: {
    login: ReturnType<typeof deferred<void>>;
    worker: CodexWorker;
    closed: number;
  }[] = [];
  const manager = new CodexPlayerSessions({
    model: 'gpt-5.6-luna',
    capacity,
    now: () => now,
    factory: async () => {
      const login = deferred();
      const entry = { login, closed: 0, worker: null as unknown as CodexWorker };
      entry.worker = {
        work: 'fake',
        rpc: { clearEvents() {} } as CodexWorker['rpc'],
        isUsable: () => entry.closed === 0,
        close: async () => {
          entry.closed++;
          login.reject(new Error('closed'));
        },
        invalidate: async () => {
          await entry.worker.close();
        },
        authenticate: async (_mode, show) => {
          show?.({ url: 'https://auth.openai.com/codex/device', code: `TEST-${workers.length}` });
          await login.promise;
        },
      };
      // Cancellation may arrive even before authenticate attaches its listener.
      void login.promise.catch(() => {});
      workers.push(entry);
      return entry.worker;
    },
    checkModel: async () => {},
    responder: (worker) => async () => ({ worker: workers.findIndex((w) => w.worker === worker) }),
  });
  return {
    manager,
    workers,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('player login isolates owners and play routing, blocks switching, closes on release', async () => {
  const f = fixture();
  try {
    f.manager.start('a');
    f.manager.start('b');
    f.manager.start('a');
    await flush();
    assert.equal(f.workers.length, 2);
    assert.equal(f.manager.status('stranger').status, 'disconnected');
    assert.throws(() => f.manager.bind('a', 'pa'), /CODEX_LOGIN_REQUIRED/);
    f.workers[0].login.resolve();
    f.workers[1].login.resolve();
    await flush();
    assert.deepEqual(f.manager.status('a'), {
      status: 'ready',
      model: 'gpt-5.6-luna',
      expiresAt: 600000,
    });
    f.manager.bind('a', 'pa');
    f.manager.bind('b', 'pb');
    assert.deepEqual(await f.manager.respond({}, undefined, 'pa'), { worker: 0 });
    assert.deepEqual(await f.manager.respond({}, undefined, 'pb'), { worker: 1 });
    await assert.rejects(
      f.manager.respond({}, undefined, 'unknown'),
      (e: any) => e.code === 'CODEX_UNAVAILABLE',
    );
    await assert.rejects(f.manager.logout('a'), /CODEX_PLAY_ACTIVE/);
    await f.manager.release('pa');
    assert.equal(f.manager.status('a').status, 'disconnected');
    assert.equal(f.manager.status('b').status, 'ready');
    assert.ok(f.workers[0].closed);
  } finally {
    await f.manager.dispose();
  }
});

test('pending timeout, capacity and failed login cannot authorize a play', async () => {
  const f = fixture(1);
  try {
    f.manager.start('a');
    await flush();
    assert.throws(() => f.manager.start('b'), /CODEX_CAPACITY/);
    f.advance(180001);
    await f.manager.sweep();
    assert.equal(f.manager.status('a').status, 'disconnected');
    assert.ok(f.workers[0].closed);
    f.manager.start('b');
    await flush();
    f.workers[1].login.reject(new Error('private error'));
    await flush();
    assert.deepEqual(f.manager.status('b'), { status: 'failed' });
    assert.throws(() => f.manager.bind('b', 'pb'), /CODEX_LOGIN_REQUIRED/);
    await f.manager.logout('b');
  } finally {
    await f.manager.dispose();
  }
});

test('authenticated idle timeout closes auth, bound plays use registry lifetime', async () => {
  const f = fixture();
  f.manager.start('a');
  f.manager.start('b');
  await flush();
  f.workers.forEach((w) => w.login.resolve());
  await flush();
  f.manager.bind('b', 'pb');
  f.advance(600001);
  await f.manager.sweep();
  assert.equal(f.manager.status('a').status, 'disconnected');
  assert.equal(f.manager.status('b').status, 'ready');
  await f.manager.dispose();
  assert.ok(f.workers.every((w) => w.closed > 0));
  assert.throws(() => f.manager.start('c'), /DRAINING/);
});

test('cancel during delayed startup destroys the late worker and never publishes credentials', async () => {
  const factory = deferred<CodexWorker>();
  let closed = 0,
    authenticated = 0;
  const manager = new CodexPlayerSessions({
    model: 'x',
    capacity: 1,
    factory: () => factory.promise,
  });
  manager.start('a');
  const cancel = manager.logout('a');
  assert.equal(manager.status('a').status, 'failed');
  assert.throws(() => manager.start('b'), /CODEX_CAPACITY/);
  factory.resolve({
    close: async () => {
      closed++;
    },
    authenticate: async () => {
      authenticated++;
    },
  } as unknown as CodexWorker);
  await cancel;
  assert.ok(closed > 0);
  assert.equal(authenticated, 0);
  assert.equal(manager.status('a').status, 'disconnected');
  await manager.dispose();
});

test('HTTP login requires own cookie/origin, gates creation and routes game calls by play identity', async (t) => {
  const f = fixture();
  const config = loadHostedConfig({ HOSTED_NO_ENV_FILE: '1', AI_MODE: 'mock' });
  config.scenarioCatalog = undefined;
  const app = createHostedApp(config, { playerJudgments: f.manager, log: () => {} });
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
  const request = (path: string, cookie = '', body?: unknown, requestOrigin = origin) =>
    fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookie, Origin: requestOrigin, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const cookie = async () =>
    (await request('/api/auth', '', {})).headers.get('set-cookie')!.split(';')[0];
  const a = await cookie(),
    b = await cookie();
  assert.equal((await (await request('/api/bootstrap')).json()).ai.playerLogin, 'codex');
  assert.equal((await request('/api/codex/login', '', {})).status, 401);
  assert.equal((await request('/api/codex/login', a, {}, 'https://evil.example')).status, 403);
  assert.equal((await request('/api/codex/login', a, { owner: 'b' })).status, 400);
  assert.equal((await request('/api/codex/login', a, {})).status, 200);
  await flush();
  assert.equal((await (await request('/api/codex/status', a)).json()).status, 'pending');
  assert.deepEqual(await (await request('/api/codex/status', b)).json(), {
    status: 'disconnected',
  });
  const create = { requestId: randomUUID(), clientId: randomUUID() };
  assert.equal((await request('/api/plays', b, create)).status, 401);
  f.workers[0].login.resolve();
  await flush();
  const created = await request('/api/plays', a, create);
  assert.equal(created.status, 201);
  assert.equal((await request('/api/codex/logout', a, {})).status, 409);
  assert.equal(
    (await request('/api/plays', b, { ...create, requestId: randomUUID() })).status,
    401,
  );
  const play = [...app.registry.plays.values()][0];
  assert.deepEqual(
    await app.ai.respondGame(play.id, {
      model: config.ai.gameModel,
      instructions: 'Return JSON',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'test' }] }],
      text: {
        format: { type: 'json_schema', name: 'test', strict: true, schema: { type: 'object' } },
      },
      store: false,
      max_output_tokens: 1024,
    }),
    { worker: 0 },
  );
  await app.registry.end(play);
  assert.deepEqual(await (await request('/api/codex/status', a)).json(), {
    status: 'disconnected',
  });
  assert.ok(f.workers[0].closed > 0);
});

test('failed model verification closes auth and never enables play', async () => {
  const f = fixture();
  const factory = async () => {
    f.manager.start('inner');
    await flush();
    const w = f.workers[0];
    w.login.resolve();
    return w.worker;
  };
  const manager = new CodexPlayerSessions({
    model: 'missing',
    capacity: 1,
    factory,
    checkModel: async () => {
      throw new Error('MODEL_NOT_AVAILABLE');
    },
  });
  manager.start('a');
  await flush();
  await flush();
  assert.equal(manager.status('a').status, 'failed');
  assert.ok(f.workers[0].closed > 0);
  assert.throws(() => manager.bind('a', 'pa'), /CODEX_LOGIN_REQUIRED/);
  await manager.dispose();
  await f.manager.dispose();
});
