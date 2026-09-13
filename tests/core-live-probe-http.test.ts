import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import sharp from 'sharp';
import { AiService } from '../packages/server/ai-service.js';
import { loadAiConfig } from '../packages/server/ai-config.js';
import { createProbeApp } from '../tools/core-live-probe-server.js';

function jsonOutput(value: unknown) {
  return {
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
  };
}
test('probe HTTP returns 202 while classification is pending and accepts correction', async (t) => {
  let release!: (value: unknown) => void;
  let classificationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    classificationStarted = resolve;
  });
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const ai = new AiService(loadAiConfig({ AI_MODE: 'mock' }), {
    createLiveSession: async () => ({
      session: { id: 'probe-test' },
      transport: { type: 'webrtc', sdp: 'test-sdp' },
    }),
    hangup: async () => {},
    createResponse: async () => {
      calls++;
      classificationStarted();
      return calls === 1
        ? pending
        : jsonOutput({
            kind: 'wait',
            evidenceSeq: [],
            itemRefs: [],
            usage: '',
            reason: 'corrected input',
          });
    },
  });
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as { port: number };
  const base = 'http://127.0.0.1:' + address.port;
  const runtime = createProbeApp({
    origin: base,
    token: 'test-token',
    ai,
    liveModel: 'gpt-live-1',
    responseModel: 'gpt-5.6-terra',
  });
  server.on('request', runtime.app);
  const headers = {
    Host: new URL(base).host,
    Origin: base,
    'X-Probe-Token': 'test-token',
    'Content-Type': 'application/json',
  };
  const post = (path: string, body: unknown) =>
    fetch(base + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
  t.after(async () => {
    release?.(
      jsonOutput({ kind: 'wait', evidenceSeq: [], itemRefs: [], usage: '', reason: 'cleanup' }),
    );
    await runtime.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const photo = (
    await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } })
      .jpeg()
      .toBuffer()
  ).toString('base64');
  const start = await post('/api/start', { locale: 'en', photo, sdp: 'offer' });
  assert.equal(start.status, 200);
  const { id } = await start.json();
  const event = (event_id: string, delta: string) => ({
    event_id,
    type: 'session.input_transcript.delta',
    delta,
    start_ms: 1,
    end_ms: 100,
  });
  assert.equal(
    (await post('/api/events', { id, event: event('u1', 'Cut the rope.') })).status,
    202,
  );
  const delegated = await post('/api/events', {
    id,
    event: {
      event_id: 'd-event',
      type: 'session.delegation.created',
      offset_ms: 100,
      delegation: { id: 'd1', type: 'delegation', target: 'client' },
    },
  });
  assert.equal(delegated.status, 202);
  await started;
  assert.equal(
    (await post('/api/events', { id, event: event('u2', 'Wait, do not cut it.') })).status,
    202,
  );
  const state = await fetch(base + '/api/state', { headers });
  assert.match(state.headers.get('cache-control')!, /no-store/);
  assert.equal((await state.json()).snapshot.fragments.length, 2);
  release(
    jsonOutput({
      kind: 'execute',
      evidenceSeq: [1],
      itemRefs: ['photo-1'],
      usage: 'cut',
      reason: 'old result',
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const after = await (await fetch(base + '/api/state', { headers })).json();
  assert.equal(after.snapshot.actions.length, 0);
  const wrongOrigin = await fetch(base + '/api/state', {
    headers: { ...headers, Origin: 'https://attacker.example' },
  });
  assert.equal(wrongOrigin.status, 403);
  assert.match(wrongOrigin.headers.get('cache-control')!, /no-store/);
  assert.equal((await fetch(base + '/api/state', { headers: { Host: headers.Host } })).status, 403);
  assert.equal((await post('/api/events', { id: 'old', event: event('u3', 'Cut') })).status, 409);
});
