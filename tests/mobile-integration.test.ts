import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import sharp from 'sharp';
import { createRelayApp } from '../apps/relay/app.js';
import { loadRelayConfig, type RelayConfig } from '../apps/relay/config.js';
import { createMobileApp } from '../apps/local-server/mobile-app.js';
import { loadLocalConfig } from '../apps/local-server/config.js';
import type { PublicGameState, PlayUpdate } from '../packages/shared/game.js';

// Only the paid provider boundary is faked. Both HTTP services, ownership,
// photo decoding, prompts, schemas, clock and game transitions are real.
test('mobile owner plays three obstacles through local and authenticated relay with fake OpenAI', async (t) => {
  const passphrase = 'integration-only-passphrase';
  const apiKey = 'integration-only-provider-secret';
  let recognitionCalls = 0,
    judgmentCalls = 0,
    hangups = 0,
    liveCreates = 0;
  const relayConfig: RelayConfig = {
    ...loadRelayConfig({ FOUNDATION_DEMO: '1' }),
    mode: 'live',
    passphrase,
    apiKey,
    authGlobalMaxAttempts: 100,
    live: {
      liveModels: ['gpt-live-1'],
      responseModels: ['integration-vision'],
      tokenLiveAttempts: 3,
      tokenResponseAttempts: 40,
      globalLiveAttempts: 3,
      globalResponseAttempts: 40,
      globalLiveConcurrent: 1,
      globalResponseConcurrent: 1,
      durationMs: 600000,
      heartbeatMs: 30000,
      outputTokens: 1000,
    },
  };
  const relay = createRelayApp(relayConfig, {
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
  });
  const relayServer = relay.listen(0, '127.0.0.1');
  await once(relayServer, 'listening');
  const localConfig = loadLocalConfig({ FOUNDATION_DEMO: '1' });
  localConfig.relayUrl = 'http://127.0.0.1:' + (relayServer.address() as AddressInfo).port;
  assert.equal(localConfig.scenario.obstacles.length, 3);
  const mobile = createMobileApp(localConfig);
  const localServer = mobile.app.listen(0, '127.0.0.1');
  await once(localServer, 'listening');
  const origin = 'http://127.0.0.1:' + (localServer.address() as AddressInfo).port;
  localConfig.allowedHosts.add(new URL(origin).host);
  localConfig.allowedOrigins.add(origin);
  mobile.access.setOrigin(origin);
  t.after(async () => {
    await mobile.dispose();
    await relay.locals.relayShutdown();
    localServer.closeAllConnections();
    relayServer.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => localServer.close(() => resolve())),
      new Promise<void>((resolve) => relayServer.close(() => resolve())),
    ]);
  });
  let owner = '';
  async function request(path: string, body?: unknown, method = 'POST', authenticated = true) {
    const response = await fetch(origin + path, {
      method,
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        ...(authenticated && owner ? { Cookie: owner } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    assert.ok(!raw.includes(passphrase) && !raw.includes(apiKey));
    assert.doesNotMatch(raw, /Bearer |"token"|live_integration|data:image/);
    return { response, data: JSON.parse(raw), raw };
  }
  const bootstrap = await request('/api/bootstrap', undefined, 'GET');
  assert.equal(bootstrap.data.relay.mode, 'live');
  assert.equal((await request('/api/play/state', undefined, 'GET')).response.status, 401);
  const invite = new URL(mobile.access.issue()!.url).hash.slice('#invite='.length);
  const claim = await request('/api/play/claim', { invite });
  assert.equal(claim.response.status, 200);
  const cookie = claim.response.headers.get('set-cookie')!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  owner = cookie.split(';')[0]!;
  assert.equal((await request('/api/play/claim', { invite }, 'POST', false)).response.status, 409);
  const live = await request('/api/play/live', { sdp: 'integration-offer', passphrase });
  assert.equal(live.response.status, 201, live.raw);
  assert.equal(live.data.sdp, 'integration-answer');
  const generation = live.data.generation as number;
  assert.equal(
    (await request('/api/play/heartbeat', { generation, voiceState: 'connected' })).response.status,
    200,
  );
  assert.equal((await request('/api/play/start', {})).data.status, 'playing');
  const photo = (
    await sharp({ create: { width: 32, height: 32, channels: 3, background: '#aaaaaa' } })
      .png()
      .toBuffer()
  ).toString('base64');
  let final: PublicGameState | undefined;
  for (let obstacle = 0; obstacle < 3; obstacle++) {
    const uploaded = await request('/api/play/photos', { images: [photo] }, 'PUT');
    assert.equal(uploaded.response.status, 200, uploaded.raw);
    assert.equal(uploaded.data.photoCount, 1);
    assert.equal(uploaded.data.proposal.usage, '');
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
    assert.equal(final.actionsRemaining, 3 - obstacle);
    assert.equal(final.inventory.length, obstacle + 1);
    const duplicate = await request('/api/play/actions', action);
    assert.equal(duplicate.response.status, 200, duplicate.raw);
    assert.equal(duplicate.data.state.actionsRemaining, final.actionsRemaining);
  }
  assert.equal(final!.status, 'won');
  assert.equal(judgmentCalls, 3);
  assert.equal(recognitionCalls, 6);
  assert.equal(liveCreates, 1);
  assert.equal((await request('/api/play/end', {})).response.status, 200);
  assert.equal(hangups, 1);
});
