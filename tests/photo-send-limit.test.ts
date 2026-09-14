import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { createHostedApp } from '../apps/server/app.js';
import { loadHostedConfig } from '../apps/server/config.js';
import { ScenarioCatalog } from '../apps/server/scenario-catalog.js';
import { parseScenarioV2 } from '../packages/shared/scenario.js';

test('HELL HTTP accepts two photo batches, deduplicates the final send, rejects further photos and restores zero', async (t) => {
  const config = loadHostedConfig({
    HOSTED_NO_ENV_FILE: '1',
    APP_PASSPHRASE: 'send-limit-test',
    AI_MODE: 'mock',
  });
  let recognitions = 0;
  const hosted = createHostedApp(config, {
    log: () => {},
    transport: {
      async createLiveSession() {
        throw new Error('Not used');
      },
      async hangup() {},
      async createResponse(body) {
        recognitions++;
        const context = JSON.parse((body as any).input[0].content[0].text);
        const result = {
          items: context.photos.map((p: any) => ({
            photoId: p.id,
            inventoryId: null,
            name: 'Tool',
          })),
          usage: '',
          summary: 'Tools received',
        };
        return {
          output: [
            { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] },
          ],
        };
      },
    },
  });
  const server = hosted.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  config.allowedHosts.add(new URL(origin).host);
  config.allowedOrigins.add(origin);
  t.after(async () => {
    await hosted.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  let cookie = '',
    playId = '',
    epoch = 1;
  let clientId = randomUUID();
  async function request(path: string, body?: unknown, method = 'POST') {
    return fetch(origin + path, {
      method,
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-Play-Id': playId,
        'X-Client-Id': clientId,
        'X-Control-Epoch': String(epoch),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  cookie = (await request('/api/auth', { passphrase: 'send-limit-test' })).headers
    .get('set-cookie')!
    .split(';')[0];
  const created = await (
    await request('/api/plays', {
      requestId: randomUUID(),
      clientId,
      locale: 'en',
      difficulty: 'nightmare',
    })
  ).json();
  playId = created.playId;
  assert.equal(created.state.photoSendsRemaining, 2);
  const runtime = hosted.registry.plays.get(playId)!.runtime!;
  runtime.game.heartbeat('connected');
  runtime.game.start();
  const png = (
    await sharp({ create: { width: 4, height: 4, channels: 3, background: '#235678' } })
      .png()
      .toBuffer()
  ).toString('base64');
  assert.equal(
    (await request('/api/play/photos', { requestId: randomUUID(), images: ['invalid'] }, 'PUT'))
      .status,
    422,
  );
  assert.equal(runtime.state().photoSendsRemaining, 2);
  const clear = await request('/api/play/photos', { requestId: randomUUID(), images: [] }, 'PUT');
  assert.equal(clear.status, 200);
  assert.equal(runtime.state().photoSendsRemaining, 2);
  const first = await request(
    '/api/play/photos',
    { requestId: randomUUID(), images: [png, png] },
    'PUT',
  );
  assert.equal(first.status, 200);
  const firstState = (await first.json()).state;
  assert.equal(firstState.photoSendsRemaining, 1, 'two images in one batch consume one send');
  assert.equal(firstState.photoCount, 2);
  assert.equal(firstState.actionsUsed, 0);
  const last = { requestId: randomUUID(), images: [png] };
  assert.equal((await request('/api/play/photos', last, 'PUT')).status, 200);
  const calls = recognitions;
  const duplicate = await request('/api/play/photos', last, 'PUT');
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).state.photoSendsRemaining, 0);
  assert.equal(recognitions, calls);
  const rejected = await request(
    '/api/play/photos',
    { requestId: randomUUID(), images: [png] },
    'PUT',
  );
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).error.code, 'PHOTO_SEND_LIMIT');
  assert.equal(recognitions, calls, 'over-limit photos never reach AI');
  clientId = randomUUID();
  const control = await request('/api/play/control', { clientId, takeover: true });
  assert.equal(control.status, 200);
  epoch = (await control.json()).controlEpoch;
  const restored = await (await request('/api/play/state', undefined, 'GET')).json();
  assert.equal(restored.state.photoSendsRemaining, 0);
  assert.equal(restored.state.status, 'playing');
  assert.equal(restored.state.endReason, null);
  assert.ok(restored.state.remainingMs > 0);
});

test('two sends are valid for three obstacles; obsolete action-limit configuration is rejected', () => {
  const snapshot = new ScenarioCatalog({
    scenarioPath: 'scenarios/story-catalog.json',
    coreConfigPath: 'config/game-core.json',
  }).current('en', 'nightmare');
  assert.equal(parseScenarioV2(snapshot.scenarioV2).rules.maxPhotoSends, 2);
  assert.equal(snapshot.scenarioV2.obstacles.length, 3);
  const legacy = structuredClone(snapshot.scenarioV2) as any;
  legacy.rules.maxActions = 4;
  delete legacy.rules.maxPhotoSends;
  assert.throws(() => parseScenarioV2(legacy));
});
