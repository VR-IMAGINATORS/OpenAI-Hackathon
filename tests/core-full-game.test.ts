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
test('core voice instructions execute once through HTTP and deliver final-generation commands', async (t) => {
  const passphrase = 'integration-only-passphrase';
  const apiKey = 'integration-only-provider-secret';
  let classificationCalls = 0;
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
        const context: any = JSON.parse(parts.find((p) => p.type === 'input_text')!.text!);
        const picture = parts.find((p) => p.type === 'input_image');
        assert.match(picture!.image_url!, /^data:image\/jpeg;base64,/);
        const metadata = await sharp(
          Buffer.from(picture!.image_url!.split(',')[1]!, 'base64'),
        ).metadata();
        assert.equal(metadata.format, 'jpeg');
        assert.equal(metadata.exif, undefined);
        let result: unknown;
        if (context.conversation) {
          classificationCalls++;
          result = {
            decision: {
              kind: 'execute',
              evidenceSeq: context.conversation.eligibleEvidenceSeq,
              itemRefs: [{ photoId: context.game.photos[0].id }],
              usage: '道具で突破する',
              reason: '実行指示',
            },
          };
        } else if (context.proposal) {
          judgmentCalls++;
          assert.ok(context.inventory.length >= judgmentCalls);
          result = {
            success: true,
            narrative: '工夫した道具で障害を突破した。',
            situation: '先へ進めるようになった。',
            inventoryChanges: [],
            factChanges: [],
            shortReason: '物理的に成立する',
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
  const created = await request('/api/plays', { requestId: randomUUID(), clientId, locale: 'ja' });
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
        start_ms: obstacle * 10000 + 100,
        end_ms: obstacle * 10000 + 800,
      },
    });
    assert.equal(event.response.status, 202, event.raw);
    assert.equal(event.data.accepted, true);
    const recognized = await request('/api/play/events', {
      generation,
      event: {
        type: 'session.delegation.created',
        event_id: randomUUID(),
        offset_ms: obstacle * 10000 + 800,
        delegation: { id: 'delegate_' + obstacle, type: 'delegation', target: 'client' },
      },
    });
    assert.equal(recognized.response.status, 202, recognized.raw);
    for (let attempt = 0; attempt < 100; attempt++) {
      final = (await request('/api/play/state', undefined, 'GET')).data.state;
      if (final!.actionsUsed === obstacle + 1) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(final!.photoSendsRemaining, 3 - obstacle, JSON.stringify(final));
    assert.equal(final!.inventory.length, obstacle + 1);
    const duplicate = await request('/api/play/events', {
      generation,
      event: {
        type: 'session.delegation.created',
        event_id: randomUUID(),
        offset_ms: obstacle * 10000 + 800,
        delegation: { id: 'delegate_' + obstacle, type: 'delegation', target: 'client' },
      },
    });
    assert.equal(duplicate.response.status, 202);
    assert.equal(
      (await request('/api/play/state', undefined, 'GET')).data.state.photoSendsRemaining,
      final!.photoSendsRemaining,
    );
  }
  assert.equal(final!.status, 'won');
  assert.equal(judgmentCalls, 3);
  assert.equal(recognitionCalls, 3);
  assert.equal(classificationCalls, 3);
  assert.equal(final!.generation, generation);
  const batch = await request('/api/play/commands/poll', { generation, ackThrough: 0 });
  assert.equal(batch.response.status, 200, batch.raw);
  assert.ok(batch.data.commands.some((c: any) => c.messageId));
  const replay = await request('/api/play/commands/poll', { generation, ackThrough: 0 });
  assert.deepEqual(replay.data, batch.data);
  assert.equal(
    (await request('/api/play/actions', { actionId: randomUUID(), proposalRevision: 0 })).data.error
      .code,
    'LEGACY_ACTION_DISABLED',
  );
  assert.equal(liveCreates, 1);
  assert.equal((await request('/api/play/end', {})).response.status, 200);
  assert.equal(hangups, 1);
});
