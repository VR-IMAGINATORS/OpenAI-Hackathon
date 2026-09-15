import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import sharp from 'sharp';
import { createHostedApp } from '../apps/server/app.js';
import { loadHostedConfig } from '../apps/server/config.js';
import type { PublicGameState, PlayUpdate } from '../packages/shared/game.js';

// Only the paid provider boundary is faked. HTTP, ownership,
// photo decoding, prompts, schemas, clock and game transitions are real.
test('hosted owner plays all three obstacles through unified HTTP with fake OpenAI', async (t) => {
  const passphrase = 'integration-only-passphrase';
  const apiKey = 'integration-only-provider-secret';
  let recognitionCalls = 0,
    judgmentCalls = 0,
    hangups = 0,
    liveCreates = 0;
  const config = loadHostedConfig({
    HOSTED_NO_ENV_FILE: '1',
    APP_PASSPHRASE: passphrase,
    AI_MODE: 'mock',
    GAME_MODEL: 'integration-vision',
    SCENARIO_PATH: 'scenarios/mobile-playtest.json',
  });
  // Keep the legacy endpoint regression suite explicit during the core migration.
  config.scenarioCatalog = undefined;
  const hosted = createHostedApp(config, {
    transport: {
      async createLiveSession(body) {
        liveCreates++;
        const value = body as {
          session: { model: string; instructions: string };
          transport: { type: string; sdp: string };
        };
        assert.equal(value.session.model, 'gpt-live-1');
        assert.equal(value.transport.type, 'webrtc');
        assert.equal(value.transport.sdp, 'integration-offer');
        assert.match(value.session.instructions, /未来/);
        return {
          session: { id: 'live_integration' },
          transport: { type: 'webrtc', sdp: 'integration-answer' },
        };
      },
      async createResponse(body) {
        const value = body as {
          model: string;
          store: boolean;
          input: { content: { type: string; text?: string; image_url?: string }[] }[];
        };
        assert.equal(value.model, 'integration-vision');
        assert.equal(value.store, false);
        const parts = value.input[0]!.content;
        const context = JSON.parse(parts.find((p) => p.type === 'input_text')!.text!) as {
          photos: { id: string }[];
          transcript: string;
          proposal?: unknown;
          inventory: { id: string }[];
        };
        const picture = parts.find((p) => p.type === 'input_image');
        assert.match(picture!.image_url!, /^data:image\/jpeg;base64,/);
        const metadata = await sharp(
          Buffer.from(picture!.image_url!.split(',')[1]!, 'base64'),
        ).metadata();
        assert.equal(metadata.format, 'jpeg');
        assert.equal(metadata.exif, undefined);
        let result: unknown;
        if (context.proposal) {
          judgmentCalls++;
          assert.ok(context.inventory.length >= judgmentCalls);
          result = {
            success: true,
            narrative: '工夫した道具で障害を突破した。',
            situation: '先へ進めるようになった。',
            inventoryChanges: [],
          };
        } else {
          recognitionCalls++;
          result = {
            items: [{ photoId: context.photos[0]!.id, inventoryId: null, name: '丈夫な道具' }],
            usage: context.transcript ? '道具をてことして使う' : '',
            summary: context.transcript ? '道具をてことして使う案' : '用途を相談してください',
          };
        }
        return {
          output: [
            { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] },
          ],
        };
      },
      async hangup(id) {
        assert.equal(id, 'live_integration');
        hangups++;
      },
    },
  });
  const localServer = hosted.app.listen(0, '127.0.0.1');
  await once(localServer, 'listening');
  const origin = 'http://127.0.0.1:' + (localServer.address() as AddressInfo).port;
  config.allowedHosts.add(new URL(origin).host);
  config.allowedOrigins.add(origin);
  t.after(async () => {
    await hosted.dispose();
    localServer.closeAllConnections();
    await new Promise<void>((r) => localServer.close(() => r()));
  });
  let playId = '',
    epoch = 1;
  const clientId = randomUUID();
  let owner = '';
  async function request(path: string, body?: unknown, method = 'POST', authenticated = true) {
    const response = await fetch(origin + path, {
      method,
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        ...(authenticated && owner ? { Cookie: owner } : {}),
        ...(playId
          ? { 'X-Play-Id': playId, 'X-Client-Id': clientId, 'X-Control-Epoch': String(epoch) }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    assert.ok(!raw.includes(passphrase) && !raw.includes(apiKey));
    assert.doesNotMatch(raw, /Bearer |"token"|live_integration|data:image/);
    return { response, data: JSON.parse(raw), raw };
  }
  const bootstrap = await request('/api/bootstrap', undefined, 'GET');
  assert.equal(bootstrap.data.ai.mode, 'mock');
  assert.equal((await request('/api/play/state', undefined, 'GET')).response.status, 401);
  const claim = await request('/api/auth', { passphrase });
  assert.equal(claim.response.status, 200);
  const cookie = claim.response.headers.get('set-cookie')!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  owner = cookie.split(';')[0]!;
  const created = await request('/api/plays', { requestId: randomUUID(), clientId });
  playId = created.data.playId;
  epoch = created.data.controlEpoch;
  const live = await request('/api/play/live', {
    requestId: randomUUID(),
    sdp: 'integration-offer',
  });
  assert.equal(live.response.status, 201, live.raw);
  assert.equal(live.data.sdp, 'integration-answer');
  const generation = live.data.generation as number;
  assert.equal(
    (await request('/api/play/heartbeat', { generation, voiceState: 'connected' })).response.status,
    200,
  );
  assert.equal((await request('/api/play/start', {})).data.state.status, 'playing');
  const photo = (
    await sharp({ create: { width: 32, height: 32, channels: 3, background: '#aaaaaa' } })
      .png()
      .toBuffer()
  ).toString('base64');
  let final: PublicGameState | undefined;
  for (let obstacle = 0; obstacle < 3; obstacle++) {
    const uploaded = await request(
      '/api/play/photos',
      { requestId: randomUUID(), images: [photo] },
      'PUT',
    );
    assert.equal(uploaded.response.status, 200, uploaded.raw);
    assert.equal(uploaded.data.state.photoCount, 1);
    assert.equal(uploaded.data.state.proposal.usage, '');
    const event = await request('/api/play/events', {
      generation,
      event: {
        type: 'session.input_transcript.delta',
        event_id: randomUUID(),
        delta: 'この道具をてことして使ってください',
        start_ms: obstacle * 1000,
        end_ms: obstacle * 1000 + 800,
      },
    });
    assert.equal(event.response.status, 200, event.raw);
    assert.equal(event.data.state.proposal, null);
    const recognized = await request('/api/play/events', {
      generation,
      event: {
        type: 'session.delegation.created',
        event_id: randomUUID(),
        offset_ms: obstacle * 1000 + 800,
        delegation: { id: 'delegate_' + obstacle, type: 'delegation', target: 'client' },
      },
    });
    assert.equal(recognized.response.status, 200, recognized.raw);
    const proposal = (recognized.data as PlayUpdate).state.proposal!;
    assert.ok(proposal.usage);
    const action = { actionId: randomUUID(), proposalRevision: proposal.revision };
    const committed = await request('/api/play/actions', action);
    assert.equal(committed.response.status, 200, committed.raw);
    final = (committed.data as PlayUpdate).state;
    assert.equal(final.creditsRemaining, 1000 - (obstacle + 1) * 120);
    assert.equal(final.inventory.length, obstacle + 1);
    const duplicate = await request('/api/play/actions', action);
    assert.equal(duplicate.response.status, 200, duplicate.raw);
    assert.equal(duplicate.data.state.creditsRemaining, final.creditsRemaining);
  }
  assert.equal(final!.status, 'won');
  assert.equal(judgmentCalls, 3);
  assert.equal(recognitionCalls, 6);
  assert.equal(liveCreates, 1);
  assert.equal((await request('/api/play/end', {})).response.status, 200);
  assert.equal(hangups, 1);
});
