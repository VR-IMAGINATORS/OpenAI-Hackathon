import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionStore } from '../apps/server/session-store.js';
import { PlayRegistry } from '../apps/server/play-registry.js';
function fixture(close = async () => true, closeConfirmed?: (playId: string) => boolean) {
  let now = 0;
  let factories = 0;
  const registry = new PlayRegistry({
    now: () => now,
    wallNow: () => 1_000_000 + now,
    factory: () => {
      factories++;
      return { secret: 'photo', ended: false };
    },
    expire: (r) => {
      r.ended = true;
    },
    close,
    snapshot: (r) => ({ ended: r.ended }),
    dispose: (r) => {
      r.secret = '';
    },
    transferControl: async () => true,
    closeConfirmed,
  });
  const sessions = new SessionStore({
    now: () => now,
    hasActivePlay: (owner) => registry.hasActivePlay(owner),
  });
  const auth = () => sessions.createSession();
  const create = (owner = auth().session, requestId = 'request', clientId = 'tab') =>
    registry.create(owner, { requestId, clientId }).play;
  return {
    registry,
    sessions,
    auth,
    create,
    time: (value: number) => {
      now = value;
    },
    factories: () => factories,
  };
}
test('auth does not allocate game; opaque cookie renewal and rate cap', () => {
  const f = fixture();
  const { token, session } = f.auth();
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.notEqual(token, session.digest);
  assert.equal(f.factories(), 0);
  assert.equal(f.registry.occupied, 0);
  f.time(100);
  assert.equal(f.sessions.createSession(token).session, session);
  assert.equal(session.expiresAt, 1_800_100);
  const rate = new SessionStore({ authAttemptsPerMinute: 1 });
  assert.ok(rate.createSession().token);
  assert.throws(() => rate.createSession(), /AUTH_RATE_LIMIT/);
});
test('five slots, idempotent create, independent owners, release and replay', async () => {
  const f = fixture();
  const owner = f.auth().session;
  const first = f.create(owner);
  assert.equal(f.registry.create(owner, { requestId: 'request', clientId: 'tab' }).play, first);
  assert.throws(() => f.create(owner, 'request', 'changed-tab'), /PLAY_CONFLICT/);
  assert.throws(() => f.create(owner, 'other'), /PLAY_ALREADY_ACTIVE/);
  for (let i = 0; i < 4; i++) f.create();
  assert.equal(f.registry.occupied, 5);
  assert.throws(() => f.create(), /PLAY_CAPACITY/);
  assert.throws(() => f.registry.get(f.auth().session, first.id), /PLAY_FORBIDDEN/);
  await f.registry.end(first);
  assert.equal(first.runtime, null);
  assert.equal(f.registry.occupied, 4);
  assert.notEqual(f.create(owner, 'new').id, first.id);
});
test('takeover invalidates old tab without extending deadline; GET does not renew', async () => {
  const f = fixture();
  const owner = f.auth().session;
  const p = f.create(owner);
  await assert.rejects(f.registry.control(owner, p.id, 'other', false), /CONTROL_BUSY/);
  f.time(20_000);
  assert.equal(f.registry.get(owner).lastHeartbeat, 0);
  await f.registry.control(owner, p.id, 'other', true);
  assert.equal(p.controllerEpoch, 2);
  assert.equal(p.deadline, 600_000);
  assert.equal(p.recoveryDeadline, 60_000);
  assert.throws(() => f.registry.assertControl(owner, p.id, 'tab', 1), /CONTROL_BUSY/);
  f.registry.heartbeat(owner, p.id, 'other', 2, 'connected');
  assert.equal(p.recoveryDeadline, null);
  f.time(50_000);
  await f.registry.control(owner, p.id, 'third', false);
  assert.equal(p.controllerEpoch, 3);
});
test('initial connection and heartbeat-loss recovery use fixed deadline', async () => {
  const f = fixture();
  const initial = f.create();
  f.time(60_000);
  await f.registry.sweep();
  assert.equal(initial.lifecycle, 'terminal');
  const owner = f.auth().session;
  const p = f.create(owner);
  f.registry.heartbeat(owner, p.id, 'tab', 1, 'connected');
  f.time(90_000);
  await f.registry.sweep();
  assert.equal(p.lifecycle, 'recovering');
  assert.equal(p.recoveryDeadline, 120_000);
  f.time(100_000);
  f.registry.heartbeat(owner, p.id, 'tab', 1, 'disconnected');
  assert.equal(p.recoveryDeadline, 120_000);
  f.time(120_000);
  assert.throws(() => f.registry.heartbeat(owner, p.id, 'tab', 1, 'connected'), /PLAY_EXPIRED/);
  await f.registry.sweep();
  assert.equal(p.lifecycle, 'terminal');
});
test('absolute lifetime and two-minute result retention', async () => {
  const f = fixture();
  const owner = f.auth().session;
  const p = f.create(owner);
  for (let n = 0; n < 600_000; n += 10_000) {
    f.time(n);
    f.registry.heartbeat(owner, p.id, 'tab', 1, 'connected');
  }
  f.time(600_000);
  await f.registry.sweep();
  assert.equal(p.lifecycle, 'terminal');
  assert.deepEqual(f.registry.get(owner).result, { ended: true });
  f.time(720_000);
  await f.registry.sweep();
  assert.throws(() => f.registry.get(owner), /PLAY_EXPIRED/);
});
test('unknown close quarantines slot and forbids drain resume', async () => {
  const f = fixture(async () => false);
  const p = f.create();
  await f.registry.end(p);
  assert.equal(p.lifecycle, 'quarantined');
  assert.equal(p.runtime, null);
  assert.equal(f.registry.occupied, 1);
  await f.registry.drain();
  assert.throws(() => f.create(), /DRAINING/);
  assert.throws(() => f.registry.resume(), /DRAIN_INCOMPLETE/);
  f.time(1_000_000);
  await f.registry.sweep();
  assert.equal(f.registry.occupied, 1);
});
test('late provider confirmation reconciles a disposed quarantine without reviving it', async () => {
  let confirmed = false;
  const f = fixture(
    async () => false,
    () => confirmed,
  );
  const p = f.create();
  const runtime = p.runtime!;
  await f.registry.end(p);
  assert.equal(p.lifecycle, 'quarantined');
  assert.equal(p.runtime, null);
  assert.equal(runtime.secret, '');
  assert.equal(f.registry.occupied, 1);
  confirmed = true;
  await f.registry.sweep();
  assert.equal(p.lifecycle, 'terminal');
  assert.equal(p.runtime, null);
  assert.equal(f.registry.occupied, 0);
});
test('late close reconciliation releases a completed but unconfirmed control cleanup', async () => {
  let confirmed = false;
  const registry = new PlayRegistry({
    now: () => 0,
    factory: () => ({}),
    expire: () => {},
    close: async () => true,
    snapshot: () => ({}),
    dispose: () => {},
    transferControl: async () => false,
    closeConfirmed: () => confirmed,
  });
  const owner = new SessionStore({}).createSession().session;
  const p = registry.create(owner, { requestId: 'r', clientId: 'first' }).play;
  await assert.rejects(registry.control(owner, p.id, 'second', true), /PLAY_EXPIRED/);
  assert.equal(p.lifecycle, 'quarantined');
  confirmed = true;
  registry.reconcileConfirmedClosures();
  assert.equal(p.lifecycle, 'terminal');
  assert.equal(p.runtime, null);
  assert.equal(registry.occupied, 0);
});
test('late close reconciliation does not release a thrown control cleanup', async () => {
  const registry = new PlayRegistry({
    now: () => 0,
    factory: () => ({}),
    expire: () => {},
    close: async () => true,
    snapshot: () => ({}),
    dispose: () => {},
    transferControl: async () => {
      throw new Error('unknown cleanup');
    },
    closeConfirmed: () => true,
  });
  const owner = new SessionStore({}).createSession().session;
  const p = registry.create(owner, { requestId: 'r', clientId: 'first' }).play;
  await assert.rejects(registry.control(owner, p.id, 'second', true), /PLAY_EXPIRED/);
  assert.equal(p.lifecycle, 'quarantined');
  registry.reconcileConfirmedClosures();
  assert.equal(p.lifecycle, 'quarantined');
  assert.equal(registry.occupied, 1);
});
test('pending close retains slot and repeated end shares promise', async () => {
  let resolve!: (v: boolean) => void;
  let calls = 0;
  const f = fixture(() => {
    calls++;
    return new Promise<boolean>((r) => {
      resolve = r;
    });
  });
  const p = f.create();
  const closing = f.registry.end(p);
  assert.equal(f.registry.end(p), closing);
  assert.equal(f.registry.occupied, 1);
  assert.equal(calls, 1);
  resolve(true);
  await closing;
  assert.equal(f.registry.occupied, 0);
});
test('auth expiry permits active game only; restart invalidates cookie', async () => {
  const f = fixture();
  const { token, session } = f.auth();
  f.time(1_790_000);
  const p = f.create(session);
  f.registry.heartbeat(session, p.id, 'tab', 1, 'connected');
  f.time(1_800_001);
  assert.equal(f.sessions.authorize(token), session);
  const restarted = new SessionStore({});
  assert.throws(() => restarted.authorize(token), /SESSION_EXPIRED/);
  await f.registry.end(p);
  assert.throws(() => f.sessions.authorize(token), /SESSION_EXPIRED/);
  f.sessions.sweep();
  assert.equal(f.sessions.size, 0);
});

test('late heartbeat cannot revive an expired play even before watchdog sweep', () => {
  const f = fixture();
  const owner = f.auth().session;
  const p = f.create(owner);
  f.registry.heartbeat(owner, p.id, 'tab', 1, 'connected');
  f.time(60_000);
  assert.throws(() => f.registry.heartbeat(owner, p.id, 'tab', 1, 'connected'), /PLAY_EXPIRED/);
});

test('auth map is bounded and sweeps expired owners', () => {
  let now = 0;
  const store = new SessionStore({ now: () => now, capacity: 1, ttlMs: 100 });
  const first = store.createSession();
  assert.throws(() => store.createSession(), /AUTH_CAPACITY/);
  now = 100;
  const second = store.createSession();
  assert.notEqual(first.token, second.token);
  assert.equal(store.size, 1);
});

test('control cleanup completion cannot return a newer tab control or revive an expired play', async () => {
  let now = 0;
  const pending: Array<(confirmed: boolean) => void> = [];
  const registry = new PlayRegistry({
    now: () => now,
    factory: () => ({}),
    expire: () => {},
    close: async () => true,
    snapshot: () => ({}),
    dispose: () => {},
    transferControl: () => new Promise<boolean>((r) => pending.push(r)),
  });
  const owner = new SessionStore({}).createSession().session;
  const p = registry.create(owner, { requestId: 'r', clientId: 'first' }).play;
  const old = registry.control(owner, p.id, 'second', true);
  const latest = registry.control(owner, p.id, 'third', true);
  pending[0](true);
  await assert.rejects(old, /CONTROL_BUSY/);
  now = 60_000;
  pending[1](true);
  await assert.rejects(latest, /PLAY_EXPIRED/);
});
