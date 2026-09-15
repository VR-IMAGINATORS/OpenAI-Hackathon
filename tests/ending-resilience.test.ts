import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { AiService, AiServiceError } from '../packages/server/ai-service.js';
import { loadAiConfig } from '../packages/server/ai-config.js';
import { UpstreamError } from '../packages/server/openai.js';
import { FalSubmitError, FalTransportError } from '../packages/server/fal.js';
import { EndingJobs } from '../apps/server/ending-jobs.js';
import { ResultStore } from '../apps/server/result-store.js';
import { ScenarioCatalog } from '../apps/server/scenario-catalog.js';
import { aftermathDirection } from '../apps/local-server/ending-fallback.js';
import { endingDesignSchema } from '../apps/local-server/ending-ai.js';
import type { EndingPacket } from '../apps/local-server/ending.js';
import { localizeScenario } from '../packages/shared/scenario.js';
import { syntheticEndingMp4 } from './helpers/ending-mp4.js';

const response = (value: unknown) => ({
  status: 'completed',
  output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
});
const handle = { requestId: 'existing', statusUrl: 'test', resultUrl: 'test', cancelUrl: 'test' };
async function until(check: () => boolean) {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  assert(check(), 'ending work reached the expected state');
}
async function setup(
  t: TestContext,
  options: {
    ready?: boolean;
    faults?: boolean;
    fatal?:
      | 'direction-auth'
      | 'direction-refusal'
      | 'frame-auth'
      | 'inspection-refusal'
      | 'image-budget';
    waitMs?: number;
  } = {},
) {
  let now = 0;
  const snapshot = new ScenarioCatalog({
    scenarioPath: 'scenarios/mobile-playtest.json',
    coreConfigPath: 'config/game-core.json',
  }).current('en');
  const facts = {
    obstacleId: snapshot.scenarioV2.obstacles[0].id,
    values: Object.fromEntries(
      snapshot.scenarioV2.core.facts.map((fact) => [fact.key, fact.initial]),
    ),
  };
  const playId = randomUUID();
  const packet: EndingPacket = {
    playId,
    snapshot,
    scenario: localizeScenario(snapshot.scenarioV2, 'en'),
    locale: 'en',
    outcome: 'bad',
    endReason: 'time_limit',
    clearedIds: [],
    remainingObstacles: [],
    facts,
    inventory: [{ id: 'rope', name: 'rope', description: 'frayed', status: 'damaged' }],
    actions: [
      {
        actionId: 'attempt',
        order: 1,
        obstacleId: facts.obstacleId,
        usage: 'Pull with the rope',
        items: [{ id: 'rope', name: 'rope', beforeStatus: 'available', afterStatus: 'damaged' }],
        beforeVersion: 0,
        afterVersion: 1,
        beforeFacts: facts,
        afterFacts: facts,
        success: false,
        cleared: false,
        narrative: 'The rope frayed; the obstacle remains locked.',
      },
    ],
    evidence: { records: [], truncated: false },
    endedAt: 0,
    gameVersion: 1,
    finalMessageId: null,
    actionScenes: [],
  };
  const jpeg = await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: '#456' },
  })
    .jpeg()
    .toBuffer();
  const counts = {
    text: 0,
    direction: 0,
    start: 0,
    end: 0,
    startChecks: 0,
    endChecks: 0,
    submit: 0,
    result: 0,
    download: 0,
  };
  const checked: { slot: string; image: string; target: unknown }[] = [];
  const config = loadAiConfig({ AI_MODE: 'mock' });
  config.mode = 'live';
  if (options.fatal === 'image-budget') config.globalImageAttempts = 1;
  const ai = new AiService(
    config,
    {
      async createLiveSession() {
        throw new Error('unused');
      },
      async hangup() {},
      async createResponse(body) {
        const b = body as any;
        const name = b.text.format.name;
        if (name === 'ending_text') {
          counts.text++;
          if (options.faults) throw new UpstreamError(502, 503);
          return response({
            title: 'The locked room',
            story: 'The rope frayed and the room remained locked.',
            evaluation: 'The attempt failed.',
            tag: null,
            usedEvidenceIds: [],
          });
        }
        if (name === 'ending_design') {
          counts.direction++;
          if (options.fatal === 'direction-auth') throw new UpstreamError(502, 401);
          if (options.fatal === 'direction-refusal')
            return { output: [{ content: [{ type: 'refusal' }] }] };
          // The reported failure, injected at the real AiService/producer boundary.
          throw new AiServiceError(504, 'ENDING_CALL_TIMEOUT', 'timed out');
        }
        assert.equal(name, 'ending_frame_inspection');
        const context = JSON.parse(b.input[0].content[0].text);
        assert.equal(context.mode, 'aftermath');
        assert.equal(context.targetGameVersion, 1);
        assert.equal(context.items[0].status, 'damaged');
        checked.push({
          slot: context.slot,
          image: b.input[0].content[1].image_url,
          target: context.target,
        });
        const count = context.slot === 'start' ? ++counts.startChecks : ++counts.endChecks;
        if (options.fatal === 'inspection-refusal')
          return { output: [{ content: [{ type: 'refusal' }] }] };
        if (options.faults) {
          if (context.slot === 'start' && count === 1) throw new UpstreamError(502, 503);
          if (context.slot === 'end' && count === 1)
            return response({ verdict: 'reject', problems: ['Restore the unresolved restraint.'] });
          if (context.slot === 'end' && count === 2) return { status: 'incomplete', output: [] };
        }
        return response({ verdict: 'pass', problems: [] });
      },
      async createImageEdit(body) {
        const slot = body.prompt.includes('"slot":"start"') ? 'start' : 'end';
        counts[slot]++;
        if (options.fatal === 'frame-auth') throw new UpstreamError(502, 401);
        if (
          (options.faults || options.fatal === 'image-budget') &&
          slot === 'start' &&
          counts.start === 1
        )
          throw new UpstreamError(502, 503);
        return { data: [{ b64_json: jpeg.toString('base64') }] };
      },
    },
    () => now,
  );
  ai.register(playId, 60_000);
  const results = new ResultStore({ now: () => 1_000_000 + now, maxEntryBytes: 32 * 1024 * 1024 });
  results.create({ playId, ownerDigest: 'owner', locale: 'en' });
  const assetId = await results.putAsset(playId, {
    kind: 'scene',
    mime: 'image/jpeg',
    bytes: jpeg,
  });
  const messageId = randomUUID();
  const releaseReference = (status: 'ready' | 'failed' = 'ready') =>
    results.updateMessage(playId, messageId, {
      imageSlot: {
        status,
        assetId: status === 'ready' ? assetId : null,
        errorCode: null,
        deadline: new Date(1_030_000).toISOString(),
      },
    });
  results.appendMessage(playId, {
    id: messageId,
    side: 'assistant',
    kind: 'result',
    text: 'Confirmed scene',
    imageSlot: {
      status: 'checking',
      assetId: null,
      errorCode: null,
      deadline: new Date(1_030_000).toISOString(),
    },
  });
  results.bindScene(playId, messageId, 0);
  if (options.ready) releaseReference();
  const recoveries: string[] = [];
  const jobs = new EndingJobs(
    ai,
    {
      enabled: true,
      apiKey: 'fake',
      globalAttempts: 1,
      timeoutMs: 180_000,
      concurrent: 1,
    },
    results,
    {
      now: () => now,
      graceMs: 0,
      retryDelayMs: 1,
      referenceWaitMs: options.waitMs ?? 100,
      onRecovery: (_id, stage, code) => recoveries.push(stage + ':' + code),
      fal: {
        async submit() {
          counts.submit++;
          if (options.faults) throw new FalSubmitError('unknown', handle);
          return handle;
        },
        async status(received) {
          assert.deepEqual(received, handle);
          return 'COMPLETED';
        },
        async result() {
          if (++counts.result === 1 && options.faults) throw new FalTransportError();
          return { videoUrl: 'https://fal.media/test.mp4' };
        },
        async downloadVideo() {
          if (++counts.download === 1 && options.faults)
            throw new FalTransportError('FAL_DOWNLOAD_FAILED');
          return syntheticEndingMp4();
        },
        async cancel() {
          return { stopConfirmed: true };
        },
      },
    },
  );
  t.after(async () => {
    await jobs.drain();
    jobs.dispose();
    await ai.shutdown();
  });
  const start = () => {
    jobs.enqueue(packet, () => packet);
    results.end(playId, { status: 'lost' });
  };
  return {
    ai,
    jobs,
    results,
    packet,
    start,
    releaseReference,
    counts,
    recoveries,
    checked,
    view: () => results.ending('owner', playId),
    setNow: (value: number) => {
      now = value;
    },
  };
}

test('late scene, text failure, direction timeout, image failure, inspection failure and fal read failures still complete one video', async (t) => {
  const f = await setup(t, { faults: true });
  const original = structuredClone(f.packet);
  f.start();
  await f.ai.retire(f.packet.playId);
  await until(() => f.view().status === 'preparing');
  f.releaseReference();
  await until(() => f.view().status === 'ready');
  assert.equal(f.view().storyStatus, 'failed');
  assert.equal(f.view().outcome, 'bad');
  assert.equal(f.view().clearedCount, 0);
  assert.deepEqual(f.counts, {
    text: 1,
    direction: 1,
    start: 2,
    end: 2,
    startChecks: 2,
    endChecks: 3,
    submit: 1,
    result: 2,
    download: 2,
  });
  assert.equal(
    f.checked[0].image,
    f.checked[1].image,
    'inspection retries reuse the same generated image',
  );
  assert.deepEqual(f.packet, original, 'fallback never changes the confirmed play');
  assert.deepEqual(f.results.endingVideo('owner', f.packet.playId), syntheticEndingMp4());
  assert(f.recoveries.includes('direction:ENDING_DIRECTION_TIMEOUT'));
  assert(f.recoveries.includes('start_frame:ENDING_START_FRAME_HTTP_503'));
  assert.equal(f.jobs.snapshot().remaining, 0);
  f.jobs.enqueue(f.packet, () => f.packet);
  assert.equal(f.counts.submit, 1, 'repeated endings do not charge again');
});

for (const fatal of [
  'direction-auth',
  'direction-refusal',
  'frame-auth',
  'inspection-refusal',
  'image-budget',
] as const)
  test(`ending recovery stops on ${fatal} without using unchecked images or changing the story`, async (t) => {
    const f = await setup(t, { ready: true, fatal });
    f.start();
    await until(() => f.view().status === 'failed');
    assert.equal(f.view().storyStatus, 'ready');
    assert.equal(f.counts.submit, 0);
    assert.equal(f.counts.end, 0);
    assert.equal(f.ai.snapshot().imageAttempts, fatal.startsWith('direction') ? 0 : 1);
    assert.equal(f.counts.startChecks, fatal === 'inspection-refusal' ? 1 : 0);
  });

for (const reason of ['cancel', 'expire', 'wait-timeout', 'all-images-failed'] as const)
  test(`reference wait stops on ${reason} and a late image cannot restart the ending`, async (t) => {
    const f = await setup(t, { waitMs: 70 });
    f.start();
    await until(() => f.view().status === 'preparing');
    if (reason === 'cancel') f.jobs.cancelPlay(f.packet.playId, 'ENDING_CANCELLED');
    if (reason === 'expire') {
      f.setNow(180_000);
      f.jobs.tick();
    }
    if (reason === 'all-images-failed') f.releaseReference('failed');
    await until(() => f.jobs.snapshot().remaining === 0);
    assert(['failed', 'expired'].includes(f.view().status));
    f.releaseReference();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(f.counts.direction + f.counts.start + f.counts.submit, 0);
    assert.equal(f.view().storyStatus, 'ready');
  });

test('aftermath fallback uses the supplied outcome, without inventing action/evidence IDs', async (t) => {
  const f = await setup(t);
  for (const outcome of ['happy', 'normal', 'bad'] as const) {
    const design = endingDesignSchema.parse(aftermathDirection({ ...f.packet, outcome }));
    assert.equal(design.mode, 'aftermath');
    assert.deepEqual(design.usedActionIds, []);
    assert.deepEqual(design.usedEvidenceIds, []);
    assert(design.endPrompt.includes(outcome === 'happy' ? 'SUCCESS!!' : 'to be continued...'));
    assert(
      design.videoPrompt.includes(
        outcome === 'happy' ? 'confirmed completed escape' : 'has not escaped',
      ),
    );
  }
});
