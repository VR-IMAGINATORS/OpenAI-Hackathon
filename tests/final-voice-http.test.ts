import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createHostedApp } from '../apps/server/app.js';
import { loadHostedConfig } from '../apps/server/config.js';

test('HTTP keeps final playback alive with input rejected, then hangs up once after silence', async (t) => {
  let now = 1000,
    hangups = 0,
    clockReads = 0;
  const config = loadHostedConfig({
    HOSTED_NO_ENV_FILE: '1',
    AI_MODE: 'mock',

    SCENARIO_PATH: 'scenarios/mobile-playtest.json',
  });
  const hosted = createHostedApp(config, {
    // Real monotonic time advances between the watchdog's two clock reads.
    now: () => now + ++clockReads / 1000,
    transport: {
      async createLiveSession() {
        return {
          session: { id: 'final-voice-test' },
          transport: { type: 'webrtc', sdp: 'answer' },
        };
      },
      async createResponse() {
        throw new Error('No AI action is allowed after termination');
      },
      async hangup() {
        hangups++;
      },
    },
  });
  const server = hosted.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.allowedOrigins.add(origin);
  config.allowedHosts.add(new URL(origin).host);
  t.after(async () => {
    await hosted.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  let cookie = '',
    playId = '';
  const clientId = randomUUID();
  async function request(path: string, body: unknown) {
    const response = await fetch(origin + path, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-Play-Id': playId,
        'X-Client-Id': clientId,
        'X-Control-Epoch': '1',
      },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    assert.ok(response.ok, JSON.stringify(data));
    return { response, data };
  }
  cookie = (await request('/api/auth', {})).response.headers.get('set-cookie')!.split(';')[0];
  playId = (await request('/api/plays', { requestId: randomUUID(), clientId, locale: 'ja' })).data
    .playId;
  const { generation } = (
    await request('/api/play/live', { requestId: randomUUID(), sdp: 'offer' })
  ).data;
  await request('/api/play/heartbeat', { generation, voiceState: 'connected' });
  const runtime = hosted.registry.plays.get(playId)!.runtime!;
  runtime.game.end('won');
  const batch = (await request('/api/play/commands/poll', { generation, ackThrough: 0 })).data;
  assert.equal(batch.state.status, 'won');
  const ack = batch.commands.at(-1)?.seq ?? 0;
  await request('/api/play/commands/poll', { generation, ackThrough: ack });
  const credits = runtime.state().creditsRemaining;
  for (const type of ['session.input_transcript.delta', 'session.delegation.created']) {
    await request('/api/play/events', {
      generation,
      event:
        type === 'session.input_transcript.delta'
          ? { type, event_id: randomUUID(), delta: 'late input', start_ms: 1, end_ms: 2 }
          : {
              type,
              event_id: randomUUID(),
              offset_ms: 2,
              delegation: { id: 'late', type: 'delegation', target: 'client' },
            },
    });
  }
  assert.equal(runtime.state().creditsRemaining, credits);
  assert.equal(runtime.state().transcript, '');
  let sequence = 0;
  async function report(output: 'active' | 'quiet') {
    await request('/api/play/voice-activity', {
      generation,
      sequence: ++sequence,
      input: 'unknown',
      inputStopped: true,
      output,
      playbackReady: true,
    });
  }
  // Longer than both the old 12s timer and heartbeat recovery timeout.
  for (now = 1000; now <= 71000; now += 1000) {
    await report('active');
    if (now % 10000 === 1000)
      await request('/api/play/heartbeat', { generation, voiceState: 'connected' });
    await hosted.tick();
    assert.equal(hangups, 0);
  }
  now = 72000;
  await report('quiet');
  now = 73000;
  await report('quiet');
  assert.equal(hangups, 0);
  now = 74000;
  await hosted.tick();
  assert.equal(hangups, 1);
  assert.equal(hosted.registry.plays.get(playId)!.lifecycle, 'terminal');
  await hosted.tick();
  assert.equal(hangups, 1);
});
