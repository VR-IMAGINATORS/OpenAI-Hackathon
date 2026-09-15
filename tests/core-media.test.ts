import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { AiService } from '../packages/server/ai-service.js';
import { loadAiConfig } from '../packages/server/ai-config.js';
import {
  createOpenAITransport,
  UpstreamError,
  type OpenAITransport,
} from '../packages/server/openai.js';
import { normalizeGeneratedImage, type SceneInput } from '../packages/server/image-service.js';
import { SceneJobs } from '../apps/server/scene-jobs.js';
import { parseScenarioV2 } from '../packages/shared/scenario.js';
import { parseCoreConfig } from '../packages/shared/core-config.js';
const imageBody = {
  model: 'gpt-image-2.5-flare',
  prompt: 'test',
  n: 1,
  size: '1024x1024',
  quality: 'low',
  output_format: 'jpeg',
};
function fake(overrides: Partial<OpenAITransport> = {}): OpenAITransport {
  return {
    createLiveSession: async () => {
      throw new Error('unused');
    },
    createResponse: async () => ({
      output: [
        {
          content: [
            { type: 'output_text', text: JSON.stringify({ verdict: 'pass', contradictions: [] }) },
          ],
        },
      ],
    }),
    hangup: async () => {},
    ...overrides,
  };
}
const snapshot = {
  digest: 'test',
  locale: 'ja' as const,
  createdAt: 0,
  scenarioV2: parseScenarioV2(JSON.parse(readFileSync('scenarios/mobile-playtest.json', 'utf8'))),
  coreConfig: parseCoreConfig(JSON.parse(readFileSync('config/game-core.json', 'utf8'))),
};
function input(playId = 'one', messageId = 'first'): SceneInput {
  return {
    playId,
    messageId,
    snapshot,
    situation: '閉じ込められている',
    facts: {
      obstacleId: snapshot.scenarioV2.obstacles[0]!.id,
      values: Object.fromEntries(snapshot.scenarioV2.core.facts.map((f) => [f.key, f.initial])),
    },
  };
}
const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#222' } })
  .jpeg()
  .toBuffer();
const generated = { data: [{ b64_json: jpeg.toString('base64') }] };
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(check(), 'condition reached');
}

test('media permits survive retire, reject new permits, and retain independent budgets', async () => {
  const ai = new AiService(
    loadAiConfig({ AI_MODE: 'mock' }),
    fake({ createImage: async () => generated }),
    () => 0,
  );
  ai.register('one', 1000);
  ai.registerMedia('one', 'job', 1000, 4);
  await ai.retire('one');
  assert.throws(() => ai.registerMedia('one', 'late', 1000, 4));
  assert.equal(ai.forget('one'), false);
  await ai.mediaCall('job', 0, 'generation', imageBody, 1000);
  assert.equal(ai.snapshot().responseAttempts, 0);
  assert.equal(ai.snapshot().imageAttempts, 1);
  ai.releaseMedia('job');
  assert.equal(ai.forget('one'), true);
});

test('media timeout/drain keep real busy until aborted transport settles', async () => {
  const pending = deferred<unknown>();
  let signal: AbortSignal | undefined;
  const ai = new AiService(
    loadAiConfig({ AI_MODE: 'mock' }),
    fake({
      createImage: async (_b, s) => {
        signal = s;
        return pending.promise;
      },
    }),
    () => 0,
  );
  ai.register('one', 1000);
  ai.registerMedia('one', 'job', 1000, 4);
  const request = ai.mediaCall('job', 0, 'generation', imageBody, 1);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(signal?.aborted, true);
  assert.equal(ai.snapshot().mediaBusy, 1);
  assert.equal(await ai.shutdown(), false);
  assert.equal(ai.resume(), false);
  pending.resolve(generated);
  await assert.rejects(request);
  assert.equal(ai.snapshot().mediaBusy, 0);
  assert.equal(ai.resume(), true);
});

test('media checks cancellation, model, rate and started attempts before each call', async () => {
  let now = 0;
  const config = loadAiConfig({ AI_MODE: 'mock', IMAGE_REQUESTS_PER_MINUTE: '1' });
  const ai = new AiService(
    config,
    fake({
      createImage: async () => {
        throw new Error('429');
      },
    }),
    () => now,
  );
  ai.register('one', 100000);
  ai.registerMedia('one', 'job', 100000, 4);
  await assert.rejects(ai.mediaCall('job', 0, 'generation', { ...imageBody, model: 'wrong' }, 100));
  assert.equal(ai.snapshot().imageAttempts, 0);
  await assert.rejects(ai.mediaCall('job', 0, 'generation', imageBody, 100));
  assert.equal(ai.snapshot().imageAttempts, 1);
  await assert.rejects(ai.mediaCall('job', 0, 'generation', imageBody, 100));
  assert.equal(ai.snapshot().imageAttempts, 1);
  now = 60000;
  await assert.rejects(ai.mediaCall('job', 0, 'generation', imageBody, 100));
  assert.equal(ai.snapshot().imageAttempts, 2);
  ai.cancelMedia('job');
  await assert.rejects(ai.mediaCall('job', 0, 'generation', imageBody, 100));
  assert.equal(ai.snapshot().imageAttempts, 2);
});

test('scene only publishes after inspection; rejection regenerates once', async () => {
  let generates = 0,
    checks = 0,
    ready = 0;
  const stages: string[] = [];
  const ai = new AiService(
    loadAiConfig({ AI_MODE: 'mock' }),
    fake({
      createImage: async () => {
        generates++;
        return generated;
      },
      createResponse: async () => ({
        output: [
          {
            content: [
              {
                type: 'output_text',
                text: JSON.stringify(
                  ++checks === 1
                    ? {
                        verdict: 'reject',
                        contradictions: [{ ruleId: 'fact:door', reason: 'opened' }],
                      }
                    : { verdict: 'pass', contradictions: [] },
                ),
              },
            ],
          },
        ],
      }),
    }),
  );
  ai.register('one', performance.now() + 100000);
  const jobs = new SceneJobs(ai);
  jobs.enqueue(input(), {
    ready: (b) => {
      ready++;
      assert.ok(b.length <= 256 * 1024);
      assert.equal(checks, 2);
    },
    failed: () => assert.fail('unexpected failure'),
    stage: (s) => stages.push(s),
  });
  await until(() => ready === 1);
  assert.equal(generates, 2);
  assert.deepEqual(stages, [
    'queued',
    'generating',
    'checking',
    'retrying',
    'retrying',
    'checking',
    'ready',
  ]);
  jobs.cancelAll();
});

for (const investigation of [false, true])
  for (const persistent of [false, true])
    test(`scene collage rejection uses the bounded retry and never publishes a rejected image (investigation: ${investigation}, persistent: ${persistent})`, async (t) => {
      const scene = structuredClone(input());
      if (investigation)
        scene.snapshot.scenarioV2.investigation = {
          initialOverview: { ja: 'The confirmed room.', en: 'The confirmed room.' },
          knowledgeMetadata: [],
          ambienceSlots: [],
          publicVisuals: [],
          sourceRef: { sourceDigest: 'a'.repeat(64), candidateId: 'single-view', revision: 1 },
        };
      let generates = 0,
        checks = 0,
        ready = 0,
        failed = 0;
      const ai = new AiService(
        loadAiConfig({ AI_MODE: 'mock' }),
        fake({
          createImage: async (body: any) => {
            generates++;
            assert.match(body.prompt, /One full-frame camera view of one place at one instant/);
            assert.match(body.prompt, /No collage, montage, storyboard, split screen/);
            assert.equal(body.n, 1);
            return generated;
          },
          createResponse: async (body: any) => {
            checks++;
            assert.match(
              body.instructions,
              /multi-scene or multi-time layout is a major contradiction/,
            );
            assert.match(body.instructions, /Natural doors, windows, mirrors and screens/);
            const data = JSON.parse(body.input[0].content[0].text);
            assert.ok(data.rules.some((rule: any) => rule.ruleId === 'composition:single_moment'));
            const result =
              persistent || checks === 1
                ? {
                    verdict: 'reject',
                    contradictions: [
                      {
                        ruleId: 'composition:single_moment',
                        reason: 'Multiple moments appear in separate panels.',
                      },
                    ],
                  }
                : { verdict: 'pass', contradictions: [] };
            return {
              output: [{ content: [{ type: 'output_text', text: JSON.stringify(result) }] }],
            };
          },
        }),
      );
      ai.register('one', performance.now() + 100000);
      const jobs = new SceneJobs(ai, { retryDelayMs: 1 });
      t.after(async () => {
        jobs.cancelAll();
        await ai.shutdown();
      });
      jobs.enqueue(scene, {
        ready: () => {
          ready++;
          assert.equal(checks, 2);
        },
        failed: () => {
          failed++;
        },
      });
      await until(() => ready + failed === 1);
      assert.equal(ready, persistent ? 0 : 1);
      assert.equal(failed, persistent ? 1 : 0);
      assert.equal(generates, 2);
      assert.equal(
        checks,
        2,
        'layout rejection is handled as a known rule, not an unknown inspection',
      );
    });

test('unknown, refusal and undeclared inspection rule never publish', async () => {
  for (const result of [
    { verdict: 'unknown', contradictions: [] },
    { verdict: 'reject', contradictions: [{ ruleId: 'unknown', reason: 'x' }] },
    null,
  ]) {
    let failed = 0,
      ready = 0;
    const ai = new AiService(
      loadAiConfig({ AI_MODE: 'mock' }),
      fake({
        createImage: async () => generated,
        createResponse: async () => ({
          output: [
            {
              content: [
                result
                  ? { type: 'output_text', text: JSON.stringify(result) }
                  : { type: 'refusal', refusal: 'no' },
              ],
            },
          ],
        }),
      }),
    );
    ai.register('one', performance.now() + 100000);
    const jobs = new SceneJobs(ai);
    jobs.enqueue(input(), { ready: () => ready++, failed: () => failed++ });
    await until(() => failed === 1);
    assert.equal(ready, 0);
    assert.equal(ai.snapshot().imageAttempts, result === null ? 1 : 2);
    assert.equal(ai.snapshot().inspectionAttempts, result === null ? 1 : 4);
    jobs.cancelAll();
  }
});

test('queue is per-play sequential with cross-play round-robin and separate inspection slots', async () => {
  const first = deferred<unknown>();
  const starts: string[] = [];
  const ai = new AiService(
    loadAiConfig({ AI_MODE: 'mock', IMAGE_CONCURRENT: '1' }),
    fake({
      createImage: async (body) => {
        const prompt = (body as { prompt: string }).prompt;
        starts.push(prompt.includes('second-play') ? 'two' : 'one');
        return starts.length === 1 ? first.promise : generated;
      },
    }),
  );
  for (const p of ['one', 'two']) ai.register(p, performance.now() + 100000);
  const jobs = new SceneJobs(ai);
  let ready = 0;
  const cb = { ready: () => ready++, failed: () => assert.fail('unexpected') };
  jobs.enqueue(input(), cb);
  await until(() => starts.length === 1);
  jobs.enqueue(input('one', 'second'), cb);
  jobs.enqueue({ ...input('two'), situation: 'second-play' }, cb);
  first.resolve(generated);
  await until(() => ready === 3);
  assert.deepEqual(starts, ['one', 'two', 'one']);
  jobs.cancelAll();
});

test('queue expiry and queued-only cancel do not begin new paid work', async () => {
  let now = 0;
  const ai = new AiService(
    loadAiConfig({ AI_MODE: 'mock' }),
    fake({ createImage: async () => generated }),
    () => now,
  );
  ai.register('one', 1000000);
  const jobs = new SceneJobs(ai, { now: () => now });
  let failed = 0;
  jobs.enqueue(input(), { ready: () => assert.fail(), failed: () => failed++ });
  now = 200000;
  await until(() => failed === 1);
  assert.equal(ai.snapshot().imageAttempts, 0);
  jobs.cancelAll();
});

test('normalizer rejects URL-only, SVG, oversized JPEG pixels and strips metadata', async () => {
  await assert.rejects(normalizeGeneratedImage({ data: [{ url: 'https://example.com/image' }] }));
  await assert.rejects(
    normalizeGeneratedImage({ data: [{ b64_json: Buffer.from('<svg/>').toString('base64') }] }),
  );
  const huge = await sharp({
    create: { width: 2048, height: 1024, channels: 3, background: '#222' },
  })
    .jpeg()
    .toBuffer();
  await assert.rejects(normalizeGeneratedImage({ data: [{ b64_json: huge.toString('base64') }] }));
  const normalized = await normalizeGeneratedImage(generated);
  const meta = await sharp(normalized.public).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.exif, undefined);
});

test('image transport has bounded dedicated reader and caller abort signal', async () => {
  const transport = createOpenAITransport('test-only', async (_url, options) => {
    assert.ok(options?.signal);
    return new Response(JSON.stringify({ data: [{ b64_json: 'a'.repeat(300000) }] }), {
      status: 200,
    });
  });
  assert.ok(await transport.createImage!({}, new AbortController().signal));
  const huge = createOpenAITransport(
    'test-only',
    async () => new Response('a'.repeat(8 * 1024 * 1024 + 1)),
  );
  await assert.rejects(huge.createImage!({}));
});

test('queued-only cancellation keeps started image and its inspection alive', async () => {
  const pending = deferred<unknown>();
  let calls = 0,
    ready = 0,
    failed = 0;
  const ai = new AiService(
    loadAiConfig({ AI_MODE: 'mock' }),
    fake({
      createImage: async () => {
        calls++;
        return pending.promise;
      },
    }),
  );
  ai.register('one', performance.now() + 100000);
  const jobs = new SceneJobs(ai);
  const callbacks = { ready: () => ready++, failed: () => failed++ };
  jobs.enqueue(input(), callbacks);
  await until(() => calls === 1);
  jobs.enqueue(input('one', 'queued'), callbacks);
  jobs.cancelPlay('one', true);
  await ai.retire('one');
  pending.resolve(generated);
  await until(() => ready === 1);
  assert.equal(failed, 1);
  assert.equal(calls, 1);
  assert.equal(ai.snapshot().inspectionAttempts, 1);
  jobs.cancelAll();
});

test('eviction aborts running image, never starts inspection and retains busy accounting', async () => {
  const pending = deferred<unknown>();
  let ready = 0,
    failed = 0;
  const ai = new AiService(
    loadAiConfig({ AI_MODE: 'mock' }),
    fake({ createImage: async () => pending.promise }),
  );
  ai.register('one', performance.now() + 100000);
  const jobs = new SceneJobs(ai);
  jobs.enqueue(input(), { ready: () => ready++, failed: () => failed++ });
  await until(() => ai.snapshot().imageBusy === 1);
  jobs.forgetPlay('one');
  assert.equal(ai.snapshot().mediaBusy, 1);
  pending.resolve(generated);
  await until(() => ai.snapshot().mediaBusy === 0);
  assert.equal(ready, 0);
  assert.equal(failed, 1);
  assert.equal(ai.snapshot().inspectionAttempts, 0);
  jobs.cancelAll();
});

test('completed message cannot be charged twice and global generation ceiling counts failures', async () => {
  let ready = 0,
    failed = 0;
  const ai = new AiService(
    loadAiConfig({ AI_MODE: 'mock', AI_GLOBAL_IMAGE_ATTEMPTS: '1' }),
    fake({ createImage: async () => generated }),
  );
  ai.register('one', performance.now() + 100000);
  const jobs = new SceneJobs(ai);
  const callbacks = { ready: () => ready++, failed: () => failed++ };
  const original = jobs.enqueue(input(), callbacks);
  await until(() => ready === 1);
  assert.equal(jobs.enqueue(input(), callbacks).id, original.id);
  jobs.enqueue(input('one', 'new'), callbacks);
  await until(() => failed === 1);
  assert.equal(ai.snapshot().imageAttempts, 1);
  assert.equal(ready, 1);
  jobs.cancelAll();
});

test('queue refuses job 31 without registering another permit or paid call', () => {
  const ai = new AiService(
    loadAiConfig({ AI_MODE: 'mock' }),
    fake({ createImage: async () => generated }),
  );
  ai.register('one', performance.now() + 100000);
  const jobs = new SceneJobs(ai);
  let failed = 0;
  for (let i = 0; i < 31; i++)
    jobs.enqueue(input('one', String(i)), { ready: () => {}, failed: () => failed++ });
  assert.equal(jobs.snapshot().queued, 30);
  assert.equal(failed, 1);
  assert.equal(ai.snapshot().imageAttempts, 0);
  jobs.cancelAll();
});

test('inspection global ceiling is independent and schema errors stay private', async () => {
  let failed = 0,
    ready = 0;
  const ai = new AiService(
    loadAiConfig({ AI_MODE: 'mock', AI_GLOBAL_INSPECTION_ATTEMPTS: '1' }),
    fake({
      createImage: async () => generated,
      createResponse: async () => ({
        output: [
          { content: [{ type: 'output_text', text: '{"verdict":"pass","unexpected":true}' }] },
        ],
      }),
    }),
  );
  ai.register('one', performance.now() + 100000);
  const jobs = new SceneJobs(ai);
  jobs.enqueue(input(), { ready: () => ready++, failed: () => failed++ });
  await until(() => failed === 1);
  assert.equal(ready, 0);
  assert.equal(ai.snapshot().imageAttempts, 1);
  assert.equal(ai.snapshot().inspectionAttempts, 1);
  assert.equal(ai.snapshot().responseAttempts, 0);
  jobs.cancelAll();
});

test('media configuration rejects unsupported models, too-short deadlines and missing production ceilings', () => {
  assert.throws(() => loadAiConfig({ AI_MODE: 'mock', IMAGE_MODEL: 'other' }));
  assert.throws(() => loadAiConfig({ AI_MODE: 'mock', IMAGE_JOB_TIMEOUT_SECONDS: '29' }));
  assert.throws(
    () =>
      loadAiConfig({
        AI_MODE: 'live',
        NODE_ENV: 'production',
        OPENAI_API_KEY: 'test-only',
        AI_GLOBAL_LIVE_ATTEMPTS: '1',
        AI_GLOBAL_RESPONSE_ATTEMPTS: '1',
      }),
    /AI_GLOBAL_IMAGE_ATTEMPTS required/,
  );
});

test('scene failures retain a safe cause and cancellation remains distinct from failure', async () => {
  const reports: { playId: string; stage: string; code: string }[] = [];
  const ai = new AiService(
    loadAiConfig({ AI_MODE: 'mock' }),
    fake({
      createImage: async () => {
        throw new Error('PRIVATE_PROMPT_AND_PHOTO');
      },
    }),
  );
  ai.register('one', performance.now() + 100000);
  const jobs = new SceneJobs(ai, {
    onFailure: (playId, stage, code) => reports.push({ playId, stage, code }),
  });
  let failure: string | undefined;
  jobs.enqueue(input(), {
    ready: () => assert.fail('unverified image'),
    failed: (code) => {
      failure = code;
    },
  });
  await until(() => !!failure);
  assert.equal(failure, 'SCENE_RECEIVE_FAILED');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].playId, 'one');
  assert.doesNotMatch(JSON.stringify(reports), /PRIVATE/);
  let cancelled: string | undefined;
  jobs.enqueue(input('one', 'cancelled-scene'), {
    ready: () => assert.fail('cancelled image'),
    failed: (_code, status) => {
      cancelled = status;
    },
  });
  jobs.cancelAll();
  assert.equal(cancelled, 'cancelled');
});

test('scene inspection outage rechecks the same image, including after the last generation attempt', async () => {
  let generates = 0,
    inspections = 0,
    ready = false;
  const inspectedImages: string[] = [];
  const ai = new AiService(
    loadAiConfig({ AI_MODE: 'mock' }),
    fake({
      createImage: async () => {
        if (++generates === 1) throw new UpstreamError(502, 503);
        return generated;
      },
      createResponse: async (body) => {
        inspectedImages.push((body as any).input[0].content[1].image_url);
        if (++inspections === 1) throw new UpstreamError(502, 503);
        return {
          output: [
            { content: [{ type: 'output_text', text: '{"verdict":"pass","contradictions":[]}' }] },
          ],
        };
      },
    }),
  );
  ai.register('one', performance.now() + 100000);
  const jobs = new SceneJobs(ai, { retryDelayMs: 1 });
  jobs.enqueue(input(), {
    ready: () => {
      ready = true;
    },
    failed: () => assert.fail('image should recover'),
  });
  await until(() => ready);
  assert.equal(generates, 2);
  assert.equal(inspections, 2);
  assert.equal(inspectedImages[0], inspectedImages[1]);
  assert.equal(ai.snapshot().imageAttempts, 2);
  jobs.cancelAll();
});

test('scene auth failures stop immediately, and incomplete pass responses cannot publish an image', async () => {
  for (const failure of ['auth', 'incomplete']) {
    let failed = false,
      ready = false;
    const ai = new AiService(
      loadAiConfig({ AI_MODE: 'mock' }),
      fake({
        createImage: async () => {
          if (failure === 'auth') throw new UpstreamError(502, 401);
          return generated;
        },
        createResponse: async () => ({
          status: 'incomplete',
          output: [
            { content: [{ type: 'output_text', text: '{"verdict":"pass","contradictions":[]}' }] },
          ],
        }),
      }),
    );
    ai.register('one', performance.now() + 100000);
    const jobs = new SceneJobs(ai, { retryDelayMs: 1 });
    jobs.enqueue(input(), {
      ready: () => {
        ready = true;
      },
      failed: () => {
        failed = true;
      },
    });
    await until(() => failed);
    assert.equal(ready, false);
    assert.equal(ai.snapshot().imageAttempts, failure === 'auth' ? 1 : 2);
    assert.equal(ai.snapshot().inspectionAttempts, failure === 'auth' ? 0 : 4);
    jobs.cancelAll();
  }
});
