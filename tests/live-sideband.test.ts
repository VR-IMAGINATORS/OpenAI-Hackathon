import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LiveSidebandError,
  type LiveSidebandConnectOptions,
  type LiveSidebandConnector,
  type LiveSidebandSocket,
} from '../packages/server/live-sideband.js';
import { createOpenAITransport } from '../packages/server/openai.js';
import { AiService } from '../packages/server/ai-service.js';
import { loadAiConfig } from '../packages/server/ai-config.js';
import { PlayRegistry } from '../apps/server/play-registry.js';
import { SessionStore } from '../apps/server/session-store.js';

class FakeSocket implements LiveSidebandSocket {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  on(event: string, listener: (...args: unknown[]) => void): this {
    const current = this.listeners.get(event) ?? [];
    current.push(listener);
    this.listeners.set(event, current);
    return this;
  }

  send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(data);
    callback?.();
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }

  terminate(): void {
    this.close();
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  message(value: unknown): void {
    const data = typeof value === 'string' ? value : JSON.stringify(value);
    this.emit('message', Buffer.from(data));
  }

  fail(error = new Error('socket failed')): void {
    this.emit('error', error);
    this.close();
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

interface SocketRecord {
  url: string;
  options: LiveSidebandConnectOptions;
  socket: FakeSocket;
}

function fixture(
  options: {
    closeTimeoutMs?: number;
    observationTimeoutMs?: number;
    maxSessions?: number;
    now?: () => number;
    createGate?: Promise<void>;
  } = {},
) {
  const sockets: SocketRecord[] = [];
  const requests: { url: string; init?: RequestInit }[] = [];
  let nextId = 0;
  let connectFailure: Error | undefined;
  const connector: LiveSidebandConnector = (url, connectOptions) => {
    if (connectFailure) {
      const error = connectFailure;
      connectFailure = undefined;
      throw error;
    }
    const socket = new FakeSocket();
    sockets.push({ url, options: connectOptions, socket });
    return socket;
  };
  const request = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    await options.createGate;
    const id = `live_${nextId++}`;
    return new Response(
      JSON.stringify({
        session: { id },
        transport: { type: 'webrtc', sdp: `answer-${id}` },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
  const transport = createOpenAITransport('sentinel-private-key', request, {
    connector,
    closeTimeoutMs: options.closeTimeoutMs ?? 100,
    maxSessions: options.maxSessions,
    observationTimeoutMs: options.observationTimeoutMs,
    now: options.now,
  });
  return {
    transport,
    sockets,
    requests,
    failNextConnect(error = new Error('attach secret detail')) {
      connectFailure = error;
    },
  };
}

function closed(id: string, reason = 'close_requested') {
  return {
    type: 'session.closed',
    event_id: `event_${id}`,
    reason,
    session: { id },
    usage: { seconds: 1 },
  };
}

const liveBody = {
  session: {
    model: 'gpt-live-1',
    instructions: 'test',
    delegation: { type: 'client' },
    store: false,
  },
  transport: { type: 'webrtc', sdp: 'offer' },
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('Live transport attaches a trusted sideband and confirms close only from session.closed', async () => {
  const f = fixture();
  const answer = await f.transport.createLiveSession(liveBody);
  assert.equal(answer.session.id, 'live_0');
  assert.equal(f.sockets.length, 1);
  assert.equal(f.sockets[0]!.url, 'wss://api.openai.com/v1/live/sessions/live_0/attach');
  assert.deepEqual(f.sockets[0]!.options.headers, {
    Authorization: 'Bearer sentinel-private-key',
  });
  assert.equal(f.sockets[0]!.options.perMessageDeflate, false);
  assert.equal(f.sockets[0]!.options.maxPayload, 1024 * 1024);

  f.sockets[0]!.socket.open();
  const finishing = f.transport.hangup('live_0');
  await tick();
  assert.deepEqual(
    f.sockets[0]!.socket.sent.map((value) => JSON.parse(value)),
    [{ type: 'session.close' }],
  );
  f.sockets[0]!.socket.message(closed('live_0'));
  await finishing;
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]!.url, 'https://api.openai.com/v1/live/sessions');
});

test('an early browser close is retained and later hangup needs no second command', async () => {
  const f = fixture();
  await f.transport.createLiveSession(liveBody);
  const socket = f.sockets[0]!.socket;
  socket.open();
  socket.message(closed('live_0', 'remote_hangup'));
  await f.transport.hangup('live_0');
  assert.deepEqual(socket.sent, []);
});

test('attach failure preserves the HTTP-created ID and hangup retries the sideband', async () => {
  const f = fixture();
  f.failNextConnect();
  const answer = await f.transport.createLiveSession(liveBody);
  assert.equal(answer.session.id, 'live_0');
  assert.equal(f.sockets.length, 0);

  const finishing = f.transport.hangup('live_0');
  assert.equal(f.sockets.length, 1);
  f.sockets[0]!.socket.open();
  await tick();
  f.sockets[0]!.socket.message(closed('live_0'));
  await finishing;
});

test('disconnect and timeout never count as finalization', async () => {
  const disconnected = fixture();
  await disconnected.transport.createLiveSession(liveBody);
  disconnected.sockets[0]!.socket.open();
  const first = disconnected.transport.hangup('live_0');
  disconnected.sockets[0]!.socket.fail(new Error('sentinel-private-key provider detail'));
  await assert.rejects(
    first,
    (error) =>
      error instanceof LiveSidebandError && !error.message.includes('sentinel-private-key'),
  );

  const timedOut = fixture({ closeTimeoutMs: 10 });
  await timedOut.transport.createLiveSession(liveBody);
  timedOut.sockets[0]!.socket.open();
  await assert.rejects(timedOut.transport.hangup('live_0'), LiveSidebandError);
  assert.equal(timedOut.transport.isLiveSessionClosed!('live_0'), false);
  assert.equal(timedOut.sockets[0]!.socket.readyState, 1);
  timedOut.sockets[0]!.socket.message(closed('live_0'));
  assert.equal(timedOut.transport.isLiveSessionClosed!('live_0'), true);
});

test('duplicate hangups share one command and a late trusted event remains confirmed', async () => {
  const f = fixture({ closeTimeoutMs: 100 });
  await f.transport.createLiveSession(liveBody);
  const socket = f.sockets[0]!.socket;
  socket.open();
  const first = f.transport.hangup('live_0');
  const duplicate = f.transport.hangup('live_0');
  await tick();
  assert.equal(socket.sent.length, 1);

  const callerTimedOut = await Promise.race([
    first.then(() => false),
    new Promise<true>((resolve) => setTimeout(() => resolve(true), 5)),
  ]);
  assert.equal(callerTimedOut, true);
  socket.message(closed('live_0'));
  await Promise.all([first, duplicate]);
  await f.transport.hangup('live_0');
  assert.equal(socket.sent.length, 1);
});

test('wrong-session and malformed close events are ignored', async () => {
  const f = fixture();
  await f.transport.createLiveSession(liveBody);
  const socket = f.sockets[0]!.socket;
  socket.open();
  const finishing = f.transport.hangup('live_0');
  socket.message(closed('live_other'));
  socket.message({ type: 'session.closed', session: { id: 'live_0' } });
  const stillPending = await Promise.race([
    finishing.then(() => false),
    new Promise<true>((resolve) => setTimeout(() => resolve(true), 5)),
  ]);
  assert.equal(stillPending, true);
  socket.message(closed('live_0'));
  await finishing;
});

test('invalid IDs are rejected without opening a socket or exposing the secret', async () => {
  const f = fixture();
  await assert.rejects(f.transport.hangup('../responses'));
  assert.equal(f.sockets.length, 0);
  assert.equal(JSON.stringify(f.requests), '[]');

  const answer = await f.transport.createLiveSession(liveBody);
  assert.equal(JSON.stringify(answer).includes('sentinel-private-key'), false);
  assert.equal(f.sockets[0]!.url.includes('sentinel-private-key'), false);
});

test('sideband capacity is reserved before another upstream Live session is created', async () => {
  const f = fixture({ maxSessions: 1 });
  await f.transport.createLiveSession(liveBody);
  await assert.rejects(f.transport.createLiveSession(liveBody), LiveSidebandError);
  assert.equal(f.requests.length, 1);
});

test('early close evidence survives long idle time and is released only by its owner', async () => {
  let now = 0;
  const f = fixture({ maxSessions: 1, now: () => now });
  await f.transport.createLiveSession(liveBody);
  f.transport.releaseClosedLiveSession!('live_0');
  await assert.rejects(f.transport.createLiveSession(liveBody), LiveSidebandError);
  const socket = f.sockets[0]!.socket;
  socket.open();
  socket.message(closed('live_0', 'connection_lost'));
  now = 600_000;
  await assert.rejects(f.transport.createLiveSession(liveBody), LiveSidebandError);
  await f.transport.hangup('live_0');
  assert.equal(f.transport.isLiveSessionClosed!('live_0'), true);
  f.transport.releaseClosedLiveSession!('live_0');
  await f.transport.createLiveSession(liveBody);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(socket.sent, []);
});

function registeredAi(f: ReturnType<typeof fixture>) {
  const ai = new AiService(
    { ...loadAiConfig({ AI_MODE: 'mock' }), timeoutMs: 10 },
    f.transport,
    () => 0,
  );
  const registry = new PlayRegistry({
    now: () => 0,
    factory: (id, deadline) => {
      ai.register(id, deadline);
      return { id };
    },
    expire: () => {},
    snapshot: () => ({}),
    dispose: () => {},
    close: ({ id }) => ai.retire(id),
    closeConfirmed: (id) => ai.isLiveCloseConfirmed(id),
    transferControl: ({ id }) => ai.closeLive(id),
  });
  const owner = new SessionStore({}).createSession().session;
  const play = registry.create(owner, { requestId: 'create', clientId: 'tab' }).play;
  return { ai, registry, play };
}

test('real transport late finalization releases AI and quarantined play after all close attempts fail', async () => {
  const f = fixture({ closeTimeoutMs: 5 });
  const { ai, registry, play } = registeredAi(f);
  await ai.createLive(play.id, liveBody);
  const socket = f.sockets[0]!.socket;
  socket.open();
  await registry.end(play);
  assert.equal(play.lifecycle, 'quarantined');
  assert.equal(ai.snapshot().unconfirmedLive, 1);
  assert.equal(socket.readyState, 1);
  socket.message(closed('live_other'));
  registry.reconcileConfirmedClosures();
  assert.equal(registry.occupied, 1);
  socket.message(closed('live_0'));
  registry.reconcileConfirmedClosures();
  assert.equal(registry.occupied, 0);
  assert.equal(play.runtime, null);
  assert.equal(ai.snapshot().liveBusy, 0);
  assert.equal(ai.playSnapshot(play.id), undefined);
  assert.equal(f.transport.isLiveSessionClosed!('live_0'), false); // owner consumed evidence
  assert.equal(await ai.shutdown(), true);
});

test('late create remains quarantined until an owned ID and trusted finalization arrive', async () => {
  let create!: () => void;
  const f = fixture({
    createGate: new Promise<void>((resolve) => {
      create = resolve;
    }),
  });
  const { ai, registry, play } = registeredAi(f);
  await assert.rejects(ai.createLive(play.id, liveBody), /作成結果を確認できません/);
  await registry.end(play);
  registry.reconcileConfirmedClosures();
  assert.equal(play.lifecycle, 'quarantined');
  assert.equal(ai.snapshot().unknownCreates, 1);
  create();
  await tick();
  f.sockets[0]!.socket.open();
  await tick();
  assert.equal(ai.snapshot().unknownCreates, 0);
  assert.equal(ai.snapshot().liveBusy, 1);
  f.sockets[0]!.socket.message(closed('live_0'));
  await tick();
  registry.reconcileConfirmedClosures();
  assert.equal(play.lifecycle, 'terminal');
  assert.equal(ai.snapshot().liveBusy, 0);
  assert.equal(ai.snapshot().pendingCreates, 0);
});

test('observation deadline closes the socket but retains an unconfirmed reservation', async () => {
  const f = fixture({ closeTimeoutMs: 5, observationTimeoutMs: 30 });
  const { ai, registry, play } = registeredAi(f);
  await ai.createLive(play.id, liveBody);
  const socket = f.sockets[0]!.socket;
  socket.open();
  await registry.end(play);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(socket.readyState, 3);
  socket.message(closed('live_0'));
  registry.reconcileConfirmedClosures();
  assert.equal(registry.occupied, 1);
  assert.equal(ai.snapshot().liveBusy, 1);
  assert.equal(await ai.closeLive(play.id), false);
  assert.equal(f.sockets.length, 1);
});
