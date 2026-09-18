import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Rpc } from '../tools/codex-poc/rpc.js';
import { voiceDiagnostic, voiceStartupDetail } from '../tools/codex-poc/live-diagnostics.js';
import { CodexLiveProbe, liveProbeDurationMs } from '../tools/codex-poc/live-probe.js';
import { createVoiceProbeApp } from '../tools/codex-live-poc.js';
import type { CodexWorker } from '../tools/codex-poc/worker.js';
const flush = () => new Promise<void>((r) => setImmediate(r));
function fixture(mode: 'ok' | 'wrong-version' | 'error' | 'stop-error' = 'ok') {
  let now = 0,
    closed = false,
    approve!: () => void,
    reject!: (e: Error) => void;
  const auth = new Promise<void>((yes, no) => {
    approve = yes;
    reject = no;
  });
  void auth.catch(() => {});
  const input = new PassThrough(),
    output = new PassThrough();
  const rpc = new Rpc(input, output);
  const calls: { method: string; params: any }[] = [];
  const emit = (v: unknown) => output.write(JSON.stringify(v) + '\n');
  input.on('data', (buffer) => {
    const m = JSON.parse(buffer.toString());
    calls.push(m);
    let result = {};
    if (m.method === 'thread/start') result = { thread: { id: 'thread' } };
    if (m.method === 'thread/realtime/start') {
      emit({ method: 'thread/realtime/sdp', params: { threadId: 'other', sdp: 'v=0 wrong' } });
      emit({
        method: 'thread/realtime/started',
        params: { threadId: 'thread', version: mode === 'wrong-version' ? 'v2' : 'v3' },
      });
      emit({
        method: 'thread/realtime/sdp',
        params: { threadId: 'thread', sdp: 'v=0 test answer' },
      });
      if (mode === 'error')
        emit({
          method: 'thread/realtime/error',
          params: { threadId: 'thread', message: 'Bearer private-token upstream text' },
        });
    }
    if (m.method === 'thread/realtime/stop') {
      if (mode === 'stop-error') {
        emit({ id: m.id, error: { code: -1 } });
        return;
      }
      emit({ method: 'thread/realtime/closed', params: { threadId: 'thread', reason: null } });
    }
    emit({ id: m.id, result });
  });
  const worker: CodexWorker = {
    rpc,
    work: 'fake',
    isUsable: () => !closed,
    authenticate: async (_mode, show) => {
      show?.({ url: 'https://auth.openai.com/codex/device', code: 'TEST-CODE' });
      await auth;
    },
    close: async () => {
      closed = true;
      reject(new Error('closed'));
      rpc.fail();
    },
    invalidate: async () => worker.close(),
  };
  const probe = new CodexLiveProbe(
    async () => worker,
    () => now,
  );
  return {
    emit,
    probe,
    calls,
    approve,
    worker,
    closed: () => closed,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
async function ready(f: ReturnType<typeof fixture>) {
  f.probe.login('a');
  await flush();
  f.approve();
  await flush();
  assert.equal(f.probe.status('a').state, 'ready');
}

test('voice probe isolates login, omits rejected voice model override, pins v3 and confirms stop', async () => {
  const f = fixture();
  try {
    f.probe.login('a');
    await flush();
    assert.equal(f.probe.status('a').state, 'pending');
    assert.equal(f.probe.status('b').state, 'disconnected');
    assert.throws(() => f.probe.login('b'), /CODEX_CAPACITY/);
    await assert.rejects(f.probe.start('b', 'v=0 offer'), /AUTH_REQUIRED/);
    f.approve();
    await flush();
    assert.equal(f.probe.status('a').userCode, undefined);
    assert.deepEqual(await f.probe.start('a', 'v=0 offer'), { sdp: 'v=0 test answer' });
    const start = f.calls.find((c) => c.method === 'thread/realtime/start')!;
    assert.equal(Object.hasOwn(start.params, 'model'), false);
    assert.equal(f.probe.status('a').requestedModel, null);
    assert.equal(f.calls.find((c) => c.method === 'thread/start')!.params.model, 'gpt-5.6-luna');
    assert.equal(start.params.version, 'v3');
    assert.deepEqual(start.params.transport, { type: 'webrtc', sdp: 'v=0 offer' });
    assert.equal(start.params.clientManagedHandoffs, true);
    assert.equal(Object.hasOwn(start.params, 'prompt'), false);
    for (let i = 0; i < 3; i++) await f.probe.speak('a');
    await assert.rejects(f.probe.speak('a'), /REQUEST_LIMIT/);
    assert.equal(f.calls.filter((c) => c.method === 'turn/start').length, 0);
    await f.probe.stop('a');
    assert.equal(f.probe.status('a').stopConfirmed, true);
    assert.equal(f.probe.status('a').processClosed, true);
  } finally {
    await f.probe.dispose();
  }
});

test('voice diagnostics retain only fixed labels and explicit HTTP status', () => {
  assert.equal(voiceDiagnostic('HTTP 403 Forbidden Bearer secret-token'), 'HTTP_403/ACCESS_DENIED');
  assert.equal(
    voiceDiagnostic('status code: 404 model_not_found private prompt'),
    'HTTP_404/MODEL_NOT_FOUND',
  );
  assert.equal(voiceDiagnostic('HTTP/1.1 429 Too Many Requests'), 'HTTP_429/RATE_LIMIT');
  assert.equal(voiceDiagnostic('invalid_request_error: secret SDP'), 'INVALID_REQUEST');
  assert.equal(
    voiceDiagnostic('https://private.example/token?secret=403 user conversation'),
    'UNKNOWN',
  );
  assert.equal(voiceDiagnostic(null), 'UNKNOWN');
});

test('startup details retain error context but redact arbitrary values and URLs', () => {
  const detail = voiceStartupDetail(
    'error sending request for url (https://example.test/private?token=SECRET) Bearer SECRET sk-private alice@example.test C:\\private\\auth.json',
  );
  assert.match(detail, /error sending request for url/);
  assert.doesNotMatch(detail, /SECRET|example|sk-private|alice|auth.json|C:/);
  assert.equal(voiceStartupDetail('Bearer private-token upstream text'), '[AUTH] upstream text');
  assert.ok(voiceStartupDetail('error '.repeat(10000)).length <= 1600);
  const restriction = 'Custom prompt is not allowed for ChatGPT realtime session';
  assert.equal(voiceDiagnostic(restriction), 'INVALID_REQUEST');
  assert.equal(voiceStartupDetail(restriction), restriction);
});

test('startup details preserve unknown fields and JSON wrappers while redacting credentials', () => {
  // Synthetic error shapes: actual upstream field remains unknown.
  for (const message of [
    'session.some_new_field=[] is not allowed for chatgpt-authenticated codex realtime session',
    '{"error":{"message":"field_x is not allowed for hosted codex realtime session"}}',
    'Error: ' +
      String.fromCharCode(96) +
      'field_x' +
      String.fromCharCode(96) +
      ' is not allowed for experimental codex realtime session.',
  ])
    assert.equal(voiceStartupDetail(message), message);
  for (const message of [
    '{"access_token":"private-value", "message":"invalid field"}',
    'Authorization: Bearer private-value',
    'Cookie: session=private-value',
    'refresh_token=private-value',
    'password="private-value"',
  ])
    assert.doesNotMatch(voiceStartupDetail(message), /private-value/);
});

test('connected error takes precedence over close and survives cleanup without exposing text', async () => {
  const f = fixture();
  await ready(f);
  await f.probe.start('a', 'v=0 offer');
  f.emit({ method: 'thread/realtime/closed', params: { threadId: 'thread', reason: 'secret' } });
  f.emit({
    method: 'thread/realtime/error',
    params: { threadId: 'thread', message: 'HTTP 403 Forbidden secret' },
  });
  f.probe.status('a');
  await f.probe.stop('a');
  const status = f.probe.status('a');
  assert.equal(status.errorCode, 'VOICE_UPSTREAM_ERROR');
  assert.equal(status.diagnostic, 'connected/error/HTTP_403/ACCESS_DENIED');
  assert.equal(status.processClosed, true);
  assert.equal(status.diagnosticRevision, 'startup-detail-v2');
  assert.doesNotMatch(JSON.stringify(status), /secret/);
  await f.probe.dispose();
});

test('wrong version and upstream errors fail without fallback and redact content', async () => {
  for (const mode of ['wrong-version', 'error'] as const) {
    const f = fixture(mode);
    await ready(f);
    await assert.rejects(f.probe.start('a', 'v=0 offer'));
    const status = f.probe.status('a');
    assert.equal(status.state, 'failed');
    assert.equal(status.processClosed, true);
    assert.doesNotMatch(JSON.stringify(status), /private upstream/);
    if (mode === 'error') assert.equal(status.diagnostic, 'starting/error/UNKNOWN');
    if (mode === 'error') assert.equal(status.startupDetail, '[AUTH] upstream text');
    assert.equal(f.calls.filter((c) => c.method === 'thread/realtime/start').length, 1);
    await f.probe.dispose();
  }
});

test('60 second deadline and missing browser heartbeat both destroy voice authentication', async () => {
  for (const timeout of [liveProbeDurationMs, 20_000]) {
    const f = fixture();
    await ready(f);
    await f.probe.start('a', 'v=0 offer');
    f.advance(timeout);
    if (timeout === liveProbeDurationMs) f.probe.status('a');
    await f.probe.tick();
    assert.equal(f.closed(), true);
    await f.probe.dispose();
  }
});

test('pending login expires, ready session expires, and failed stop is not reported confirmed', async () => {
  const pending = fixture();
  pending.probe.login('a');
  await flush();
  pending.advance(180000);
  await pending.probe.tick();
  assert.ok(pending.closed());
  await pending.probe.dispose();
  const idle = fixture();
  await ready(idle);
  idle.advance(300000);
  await idle.probe.tick();
  assert.ok(idle.closed());
  await idle.probe.dispose();
  const f = fixture('stop-error');
  await ready(f);
  await f.probe.start('a', 'v=0 offer');
  await f.probe.stop('a');
  assert.equal(f.probe.status('a').stopConfirmed, false);
  assert.equal(f.probe.status('a').processClosed, true);
  await f.probe.dispose();
});

test('cancel during process startup destroys late worker without logging in', async () => {
  const f = fixture();
  let resolve!: (w: CodexWorker) => void;
  const p = new Promise<CodexWorker>((r) => {
    resolve = r;
  });
  const probe = new CodexLiveProbe(() => p);
  probe.login('a');
  const stop = probe.stop('a');
  resolve(f.worker);
  await stop;
  assert.equal(f.closed(), true);
  assert.equal(probe.status('a').processClosed, true);
  await probe.dispose();
});

test('voice HTTP checks cookies, Origin, Host and body, never publishes arbitrary RPC', async (t) => {
  const f = fixture();
  const server = createVoiceProbeApp(f.probe).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await f.probe.dispose();
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, cookie = '', body?: unknown, origin = 'http://127.0.0.1:4311') =>
    new Promise<Response>((resolve, reject) => {
      const request = httpRequest(
        url + path,
        {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            Host: '127.0.0.1:4311',
            Origin: origin,
            Cookie: cookie,
            'Content-Type': 'application/json',
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            const headers = new Headers();
            for (const [key, value] of Object.entries(response.headers))
              if (value !== undefined)
                headers.set(key, Array.isArray(value) ? value.join(',') : value);
            resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers }));
          });
        },
      );
      request.on('error', reject);
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
  assert.equal((await fetch(url + '/')).status, 403);
  assert.equal((await request('/api/login', '', {})).status, 401);
  const auth = await request('/api/auth', '', {});
  const cookie = auth.headers.get('set-cookie')!.split(';')[0];
  assert.match(auth.headers.get('set-cookie')!, /HttpOnly/);
  assert.equal((await request('/api/login', cookie, {}, 'https://evil.example')).status, 403);
  assert.equal((await request('/api/login', cookie, { model: 'other' })).status, 400);
  assert.equal((await request('/api/login', cookie, {})).status, 200);
  assert.equal((await request('/api/rpc', cookie, {})).status, 404);
  assert.equal((await request('/api/status', cookie)).headers.get('cache-control'), 'no-store');
  assert.equal((await request('/api/stop', cookie, {})).status, 200);
});
