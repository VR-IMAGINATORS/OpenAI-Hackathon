import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { createHostedApp } from '../apps/server/app.js';
import { loadHostedConfig } from '../apps/server/config.js';
import { ScenarioCatalog } from '../apps/server/scenario-catalog.js';
import { parseScenarioV2 } from '../packages/shared/scenario.js';

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate(), 'background photo or conversation processing did not finish');
}

async function setup(t: TestContext) {
  const config = loadHostedConfig({
    HOSTED_NO_ENV_FILE: '1',
    APP_PASSPHRASE: 'send-limit-test',
    AI_MODE: 'mock',
  });
  let recognitions = 0;
  let recognitionFailure = false;
  let photoGate: Promise<void> | undefined;
  const hosted = createHostedApp(config, {
    log: () => {},
    transport: {
      async createLiveSession() {
        throw new Error('Not used');
      },
      async hangup() {},
      async createResponse(body) {
        const context = JSON.parse((body as any).input[0].content[0].text);
        const schemaName = (body as any).text.format.name;
        let result: unknown;
        if (schemaName === 'harness_photo') {
          await photoGate;
          result = {
            decision: 'clarify',
            usage: '',
            itemRefs: [],
            message: 'How should I use this tool?',
            reason: 'Use is unclear',
          };
        } else if (schemaName === 'knowledge_selection') result = { ids: [] };
        else if (schemaName === 'investigation_reply')
          result = { answer: 'I am still here.', inferences: [] };
        else if (schemaName === 'core_intent')
          result = {
            decision: {
              kind: 'consult',
              evidenceSeq: context.conversation.eligibleEvidenceSeq,
              answer: 'I am still here.',
              reason: 'The player asked a question',
            },
          };
        else {
          recognitions++;
          if (recognitionFailure) {
            recognitionFailure = false;
            throw new Error('Synthetic recognition failure');
          }
          result = {
            items: context.photos.map((p: any) => ({
              photoId: p.id,
              inventoryId: null,
              name: 'Tool',
            })),
            usage: '',
            summary: 'Tools received',
          };
        }
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
  assert.equal(created.state.creditsRemaining, 400);
  assert.equal(created.state.initialCredits, 400);
  const runtime = hosted.registry.plays.get(playId)!.runtime!;
  runtime.game.heartbeat('connected');
  runtime.game.start();
  const png = (
    await sharp({ create: { width: 4, height: 4, channels: 3, background: '#235678' } })
      .png()
      .toBuffer()
  ).toString('base64');
  let audioOffset = 1;
  return {
    runtime,
    request,
    png,
    recognitions: () => recognitions,
    failRecognition() {
      recognitionFailure = true;
    },
    holdPhoto(gate: Promise<void>) {
      photoGate = gate;
    },
    async takeover() {
      clientId = randomUUID();
      const control = await request('/api/play/control', { clientId, takeover: true });
      assert.equal(control.status, 200);
      epoch = (await control.json()).controlEpoch;
      runtime.game.heartbeat('connected');
    },
    async upload(images: string[]) {
      const previous = runtime.state().lastCreditCharge?.sequence ?? 0;
      const body = { requestId: randomUUID(), images };
      const response = await request('/api/play/photos', body, 'PUT');
      assert.equal(response.status, 200);
      await until(() => (runtime.state().lastCreditCharge?.sequence ?? 0) > previous);
      return body;
    },
    async converse() {
      const before = runtime.state().creditsRemaining;
      const generation = runtime.game.generation;
      assert.equal(
        (
          await request('/api/play/events', {
            generation,
            event: {
              type: 'session.input_transcript.delta',
              event_id: randomUUID(),
              delta: 'Are you still there?',
              start_ms: audioOffset++,
              end_ms: audioOffset++,
            },
          })
        ).status,
        202,
      );
      assert.equal(
        (
          await request('/api/play/events', {
            generation,
            event: {
              type: 'session.delegation.created',
              event_id: randomUUID(),
              offset_ms: audioOffset,
              delegation: { id: randomUUID(), type: 'delegation', target: 'client' },
            },
          })
        ).status,
        202,
      );
      await until(() => runtime.state().creditsRemaining === before - 20);
    },
  };
}

test('HELL HTTP charges each photo, keeps retries free and preserves insufficient-photo credits for conversation', async (t) => {
  const h = await setup(t);
  const { runtime, request, png } = h;
  assert.equal(
    (await request('/api/play/photos', { requestId: randomUUID(), images: ['invalid'] }, 'PUT'))
      .status,
    422,
  );
  assert.equal(runtime.state().creditsRemaining, 400);
  const clear = await request('/api/play/photos', { requestId: randomUUID(), images: [] }, 'PUT');
  assert.equal(clear.status, 200);
  assert.equal(runtime.state().creditsRemaining, 400);
  h.failRecognition();
  await request('/api/play/photos', { requestId: randomUUID(), images: [png] }, 'PUT');
  assert.equal(
    runtime.state().creditsRemaining,
    400,
    'recognition failure refunds its reservation',
  );
  await h.upload([png, png]);
  const firstState = runtime.state();
  assert.equal(firstState.creditsRemaining, 200, 'two photos cost 200 even in one batch');
  assert.equal(firstState.photoCount, 2);
  assert.equal(firstState.actionsUsed, 0);
  const second = await h.upload([png]);
  const calls = h.recognitions();
  const duplicate = await request('/api/play/photos', second, 'PUT');
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).state.creditsRemaining, 100);
  assert.equal(h.recognitions(), calls);
  await h.converse();
  assert.equal(runtime.state().creditsRemaining, 80);
  const rejected = await request(
    '/api/play/photos',
    { requestId: randomUUID(), images: [png] },
    'PUT',
  );
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).error.code, 'INSUFFICIENT_CREDITS');
  assert.equal(h.recognitions(), calls, 'unaffordable photos never reach AI');
  await h.takeover();
  const restored = await (await request('/api/play/state', undefined, 'GET')).json();
  assert.equal(restored.state.creditsRemaining, 80);
  assert.equal(restored.state.status, 'playing');
  assert.equal(restored.state.endReason, null);
  assert.ok(restored.state.remainingMs > 0);
  for (let turn = 0; turn < 4; turn++) await h.converse();
  await until(() => runtime.state().status === 'lost');
  assert.equal(runtime.state().creditsRemaining, 0);
  assert.equal(runtime.state().endReason, 'credits_exhausted');
  assert.equal(
    (await request('/api/play/photos', { requestId: randomUUID(), images: [png] }, 'PUT')).status,
    410,
  );
});

test('last photo spends the remaining credits once and finishes its explanation before ending', async (t) => {
  const h = await setup(t);
  await h.upload([h.png, h.png]);
  await h.upload([h.png]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  h.holdPhoto(gate);
  const last = { requestId: randomUUID(), images: [h.png] };
  assert.equal((await h.request('/api/play/photos', last, 'PUT')).status, 200);
  assert.equal(h.runtime.state().creditsRemaining, 0);
  assert.equal(h.runtime.state().status, 'playing');
  const calls = h.recognitions();
  assert.equal((await h.request('/api/play/photos', last, 'PUT')).status, 200);
  assert.equal(h.recognitions(), calls);
  release();
  await until(() => h.runtime.state().status === 'lost');
  assert.equal(h.runtime.state().endReason, 'credits_exhausted');
  const commands = h.runtime.pollCommands(h.runtime.game.generation, 0).commands;
  assert.ok(commands.some((command) => command.content.includes('How should I use this tool?')));
});

test('credit budgets are valid for three obstacles and obsolete limits are rejected', () => {
  const snapshot = new ScenarioCatalog({
    scenarioPath: 'scenarios/story-catalog.json',
    coreConfigPath: 'config/game-core.json',
  }).current('en', 'nightmare');
  assert.equal(parseScenarioV2(snapshot.scenarioV2).rules.initialCredits, 400);
  assert.equal(snapshot.scenarioV2.obstacles.length, 3);
  const legacy = structuredClone(snapshot.scenarioV2) as any;
  for (const field of ['maxActions', 'maxPhotoSends']) {
    legacy.rules[field] = 4;
    assert.throws(() => parseScenarioV2(legacy));
    delete legacy.rules[field];
  }
});
