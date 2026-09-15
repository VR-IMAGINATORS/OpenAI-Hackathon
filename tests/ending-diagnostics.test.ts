import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import { EndingJobs } from '../apps/server/ending-jobs.js';
import { endingFailureCode, endingValidationFields } from '../apps/server/ending-failure.js';
import { operationalLog } from '../apps/server/logging.js';
import { ResultStore } from '../apps/server/result-store.js';
import { ScenarioCatalog } from '../apps/server/scenario-catalog.js';
import {
  responseObject,
  responseBody,
  type EndingDesign,
  type EndingNarrative,
} from '../apps/local-server/ending-ai.js';
import type { EndingPacket } from '../apps/local-server/ending.js';
import { endingErrorText } from '../apps/web/src/ending-error.js';
import { AiService, AiServiceError } from '../packages/server/ai-service.js';
import { loadAiConfig } from '../packages/server/ai-config.js';
import { endingStartupSummary, loadEndingConfig } from '../packages/server/ending-config.js';
import {
  createOpenAITransport,
  UpstreamError,
  type ImageEditRequest,
} from '../packages/server/openai.js';
import { FalSubmitError } from '../packages/server/fal.js';
import { localizeScenario } from '../packages/shared/scenario.js';
import { syntheticEndingMp4 } from './helpers/ending-mp4.js';
import {
  parseEndingResponseRequest,
  EndingRequestError,
} from '../packages/server/ending-ai-request.js';

const response = (value: unknown) => ({
  output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
});

test('oversized outgoing schema is diagnosed as a request error, never an invalid AI response', async () => {
  const config = loadAiConfig({ AI_MODE: 'mock' });
  let calls = 0;
  const ai = new AiService(
    config,
    {
      async createLiveSession() {
        throw new Error('unexpected');
      },
      async createResponse() {
        calls++;
        return {};
      },
      async hangup() {},
    },
    () => 0,
  );
  ai.register('play', 600000);
  ai.registerEnding('play', 'ending', 60000);
  const body = responseBody(
    config.responseModel,
    'ending_text',
    z.object({
      source: z.enum(Array.from({ length: 140 }, (_, i) => `PRIVATE_${i}` + 'x'.repeat(120))),
    }),
    'Test',
    {},
    2048,
  );
  assert(Buffer.byteLength(JSON.stringify(body.text.format.schema)) > 16384);
  await assert.rejects(
    ai.endingCall('ending', 0, 'story', body, new AbortController().signal),
    (error) => {
      assert(error instanceof EndingRequestError);
      assert.equal(endingFailureCode(error, 'story'), 'ENDING_STORY_INVALID_REQUEST');
      assert.equal(endingValidationFields(error), 'request_schema');
      assert.doesNotMatch(JSON.stringify(error), /PRIVATE_/);
      return true;
    },
  );
  assert.equal(calls, 0);
  assert.equal(ai.snapshot().responseAttempts, 0);
  const valid = responseBody(
    config.responseModel,
    'ending_text',
    z.object({ text: z.string() }),
    'Test',
    {},
    2048,
  );
  const inputText = valid.input[0].content[0];
  assert('text' in inputText);
  inputText.text = 'x'.repeat(128 * 1024 + 1);
  assert.throws(
    () => parseEndingResponseRequest(valid),
    (error) => {
      assert(error instanceof EndingRequestError);
      assert.equal(endingValidationFields(error), 'request_input');
      return true;
    },
  );
  await ai.shutdown();
});

test('text diagnostics retain numeric play context and schema fields without private validation values', () => {
  const parsed = z
    .object({ story: z.string().max(1), tag: z.object({ id: z.enum(['tools']) }) })
    .safeParse({ story: 'PRIVATE_STORY', tag: { id: 'PRIVATE_TAG' } });
  assert(!parsed.success);
  const fields = endingValidationFields(parsed.error);
  assert.equal(fields, 'story,tag');
  let line = '';
  operationalLog(
    {
      event: 'ending_failed_story',
      correlationId: 'play-id',
      errorCode: endingFailureCode(parsed.error, 'story'),
      clearedCount: 0,
      actionCount: 3,
      failedActionCount: 3,
      validationFields: fields,
    },
    (value) => {
      line = value;
    },
  );
  assert.equal(JSON.parse(line).clearedCount, 0);
  assert.equal(JSON.parse(line).failedActionCount, 3);
  assert.equal(JSON.parse(line).validationFields, 'story,tag');
  assert.doesNotMatch(line, /PRIVATE/);
  const unknown = z.object({ PRIVATE_FIELD: z.number() }).safeParse({ PRIVATE_FIELD: 'secret' });
  assert(!unknown.success);
  assert.equal(endingValidationFields(unknown.error), 'response');
});

test('failure categories identify the stage without disclosing upstream text, URLs, or validation inputs', () => {
  const secret = 'PRIVATE_KEY https://private.invalid/photo data:image/jpeg;base64,PRIVATE_PHOTO';
  assert.equal(endingFailureCode(new Error(secret), 'story'), 'ENDING_STORY_FAILED');
  assert.equal(
    endingFailureCode(new Error('ENDING_INVALID_CONTINUITY'), 'story'),
    'ENDING_STORY_INVALID_CONTINUITY',
  );
  assert.equal(
    endingFailureCode(new UpstreamError(502, 403), 'start_frame'),
    'ENDING_START_FRAME_HTTP_403',
  );
  assert.equal(
    endingFailureCode(new FalSubmitError('rejected', undefined, 401), 'video_submit'),
    'ENDING_VIDEO_SUBMIT_HTTP_401',
  );
  assert.equal(
    endingFailureCode(new FalSubmitError('unknown'), 'video_submit'),
    'ENDING_VIDEO_SUBMIT_UNCONFIRMED',
  );
  assert.equal(
    endingFailureCode(new AiServiceError(429, 'REQUEST_LIMIT', secret), 'end_frame'),
    'ENDING_AI_BUDGET_EXHAUSTED',
  );
  const invalid = z.number().safeParse(secret);
  assert(!invalid.success);
  assert.equal(endingFailureCode(invalid.error, 'story'), 'ENDING_STORY_INVALID_RESPONSE');
  assert.equal(
    endingFailureCode(new Error('ENDING_FRAME_REJECTED'), 'end_inspection'),
    'ENDING_END_INSPECTION_REJECTED',
  );
});

test('incomplete structured output and refusal retain a useful fixed cause', () => {
  const schema = z.object({ title: z.string() });
  assert.throws(
    () =>
      responseObject(
        { status: 'incomplete', output: [{ content: [{ type: 'output_text', text: '{' }] }] },
        schema,
      ),
    /ENDING_RESPONSE_INCOMPLETE/,
  );
  assert.throws(
    () =>
      responseObject(
        { output: [{ content: [{ type: 'refusal', refusal: 'PRIVATE_REASON' }] }] },
        schema,
      ),
    /ENDING_RESPONSE_REFUSED/,
  );
});

test('OpenAI transport retains numeric upstream HTTP status but discards the response body', async () => {
  const transport = createOpenAITransport(
    'PRIVATE_KEY',
    async () => new Response('PRIVATE_ERROR_BODY', { status: 403 }),
  );
  await assert.rejects(transport.createResponse({}), (error: unknown) => {
    assert(error instanceof UpstreamError);
    assert.equal(error.status, 502);
    assert.equal(error.upstreamStatus, 403);
    assert.doesNotMatch(JSON.stringify(error) + String(error), /PRIVATE/);
    return true;
  });
});

test('local startup reports the effective process limit and disabled/mock states without credentials', () => {
  const config = loadEndingConfig({
    ENDING_VIDEO_ENABLED: 'true',
    FAL_KEY: 'PRIVATE_KEY',
    AI_GLOBAL_VIDEO_ATTEMPTS: '100',
  });
  assert.match(endingStartupSummary(config, 'live'), /100/);
  assert.doesNotMatch(endingStartupSummary(config, 'live'), /PRIVATE_KEY/);
  assert.match(endingStartupSummary(config, 'mock'), /mock/);
  assert.match(endingStartupSummary({ ...config, enabled: false }, 'live'), /\.env\.local/);
  assert.match(endingErrorText('ENDING_BUDGET_EXHAUSTED', 'ja')!, /回数上限/);
  assert.match(endingErrorText('ENDING_START_FRAME_HTTP_401', 'ja')!, /認証/);
  assert.match(endingErrorText('ENDING_STORY_INVALID_CONTINUITY', 'en')!, /story/);
  assert.equal(endingErrorText('PRIVATE_ERROR', 'ja'), null);
});

for (const variant of [
  { name: 'completed final scene', ready: [0, 1, 2], finalStatus: 'ready' },
  { name: 'queued final scene at time limit', ready: [0, 1], finalStatus: 'queued' },
  { name: 'failed final scene at time limit', ready: [0, 1], finalStatus: 'failed' },
  { name: 'cancelled final scene at time limit', ready: [0, 1], finalStatus: 'cancelled' },
  { name: 'only opening image at time limit', ready: [0], finalStatus: 'queued' },
  { name: 'images completing after cutoff', ready: [0], finalStatus: 'queued', late: true },
  { name: 'no completed scene at time limit recovers a late image', ready: [], finalStatus: 'queued', late: true },
  { name: 'no completed image before the bounded wait expires', ready: [], finalStatus: 'queued' },
  {
    name: 'direction timeout after text',
    ready: [0, 1, 2],
    finalStatus: 'ready',
    directionFailure: 'timeout',
  },
  {
    name: 'direction API fails after text',
    ready: [0, 1, 2],
    finalStatus: 'ready',
    directionFailure: 'network',
  },
  {
    name: 'invalid film action after text',
    ready: [0, 1, 2],
    finalStatus: 'ready',
    directionFailure: 'sources',
  },
  {
    name: 'incomplete film response after text',
    ready: [0, 1, 2],
    finalStatus: 'ready',
    directionFailure: 'incomplete',
  },
] as const)
  test('default ending producer: ' + variant.name, async (t) => {
    const readyVersions: readonly number[] = variant.ready;
    const latestVersion = readyVersions.at(-1) ?? ('late' in variant ? 2 : undefined);
    const hasLastActionReference = readyVersions.includes(1) && !('directionFailure' in variant);
    const config = loadAiConfig({ AI_MODE: 'mock' });
    config.mode = 'live';
    const source = await sharp({
      create: { width: 1024, height: 1024, channels: 3, background: '#555' },
    })
      .jpeg()
      .toBuffer();
    const edits: ImageEditRequest[] = [];
    let inspectedStart: Buffer | undefined;
    const failures: string[] = [];
    const recoveries: string[] = [];
    let submits = 0;
    const design: EndingDesign & Omit<EndingNarrative, 'presentedEvidence'> = {
      title: 'The last mark',
      tag: {
        id: 'bare_hands',
        evidenceActionIds: ['first'],
        reason: 'The glass was wiped without items.',
      },
      story: 'The mark from the first conversation remained on the glass.',
      evaluation: 'Two restraints were removed.',
      usedEvidenceIds: ['early'],
      usedActionIds: hasLastActionReference ? ['second'] : [],
      candidates: [
        { focus: 'two actions', reason: 'compare' },
        { focus: 'one action', reason: 'clear' },
        { focus: 'aftermath', reason: 'quiet' },
      ],
      selectionReason: 'The last action alone is readable.',
      mode: hasLastActionReference ? 'actions' : 'aftermath',
      startPrompt: 'The restrained person reaches toward the glass.',
      endPrompt: 'The same person pauses by the marked glass.',
      videoPrompt: 'A continuous 15-second scene, ambience only.',
    };
    const ai = new AiService(
      config,
      {
        async createLiveSession() {
          throw Error('NOT_USED');
        },
        async hangup() {},
        async createResponse(body) {
          const request = body as {
            text: { format: { name: string } };
            input: { content: { text?: string; image_url?: string }[] }[];
          };
          if (request.text.format.name === 'ending_text') {
            return response({
              title: design.title,
              story: design.story,
              evaluation: design.evaluation,
              tag: design.tag,
              usedEvidenceIds: design.usedEvidenceIds,
            });
          }
          if (request.text.format.name === 'ending_design') {
            assert.equal(results.ending('owner', playId).storyStatus, 'ready');
            assert.equal(results.ending('owner', playId).story!.tagId, 'bare_hands');
            const input = JSON.parse(request.input[0].content[0].text!);
            assert.deepEqual(
              input.availableBeforeReferences.map((r: { gameVersion: number }) => r.gameVersion),
              readyVersions.filter((v) => v < 2),
            );
            assert.equal(input.confirmedGameVersion, 2);
            assert.equal(input.references[0].gameVersion, latestVersion);
            assert.equal(input.facts.values.glass, 'clear');
            assert.equal(input.actions.length, 2);
            assert.equal(input.outcome, 'normal');
            if (latestVersion! < 2) assert.match(input.references[0].role, /earlier/);
            if ('directionFailure' in variant) {
              if (variant.directionFailure === 'timeout')
                throw new AiServiceError(504, 'ENDING_CALL_TIMEOUT', 'timed out');
              if (variant.directionFailure === 'network')
                throw new Error('simulated connection failure');
              if (variant.directionFailure === 'incomplete')
                return { status: 'incomplete', output: [] };
            }
            const { title, story, evaluation, tag, ...film } = design;
            return response(
              'directionFailure' in variant ? { ...film, usedActionIds: ['missing'] } : film,
            );
          }
          if (request.text.format.name === 'ending_frame_inspection') {
            const input = JSON.parse(request.input[0].content[0].text!);
            if (input.slot === 'start')
              inspectedStart = Buffer.from(
                request.input[0].content[1].image_url!.split(',')[1],
                'base64',
              );
          }
          return response({ verdict: 'pass', problems: [] });
        },
        async createImageEdit(body) {
          assert.equal(
            results.ending('owner', playId).storyStatus,
            'ready',
            'text must be public before the first image call',
          );
          assert.equal(results.ending('owner', playId).story!.text, design.story);
          edits.push(body);
          return { data: [{ b64_json: source.toString('base64') }] };
        },
      },
      () => 0,
    );
    const playId = randomUUID();
    ai.register(playId, 600_000);
    const results = new ResultStore({ now: () => 1000, maxEntryBytes: 32 * 1024 * 1024 });
    results.create({ playId, ownerDigest: 'owner', locale: 'en' });
    const sceneIds = [randomUUID(), randomUUID(), randomUUID()];
    const assetIds: string[] = [];
    for (const version of [0, 1, 2]) {
      const bytes = await sharp({
        create: {
          width: 1024,
          height: 1024,
          channels: 3,
          background: version === 1 ? '#888' : '#333',
        },
      })
        .jpeg()
        .toBuffer();
      const assetId = await results.putAsset(playId, { bytes, kind: 'scene', mime: 'image/jpeg' });
      assetIds[version] = assetId;
      results.appendMessage(playId, {
        id: sceneIds[version],
        side: 'assistant',
        kind: 'result',
        text: 'Confirmed scene',
        imageSlot: {
          status: readyVersions.includes(version)
            ? 'ready'
            : version === 2
              ? variant.finalStatus
              : 'queued',
          assetId: readyVersions.includes(version) ? assetId : null,
          errorCode: null,
          deadline: new Date(600000).toISOString(),
        },
      });
      results.bindScene(playId, sceneIds[version], version);
    }
    const snapshot = new ScenarioCatalog({
      scenarioPath: 'scenarios/mobile-playtest.json',
      coreConfigPath: 'config/game-core.json',
    }).current('en');
    const packet: EndingPacket = {
      playId,
      snapshot,
      scenario: localizeScenario(snapshot.scenarioV2, 'en'),
      locale: 'en',
      outcome: 'normal',
      endReason: 'time_limit',
      clearedIds: ['one', 'two'],
      remainingObstacles: [],
      facts: { obstacleId: 'last', values: { glass: 'clear' } },
      inventory: [],
      endedAt: 0,
      gameVersion: 2,
      finalMessageId: sceneIds[2],
      evidence: {
        records: [
          {
            sourceId: 'early',
            kind: 'briefing',
            order: 1,
            generation: 1,
            gameVersion: 0,
            text: 'The mark on the glass is visible.',
          },
        ],
        truncated: false,
      },
      actions: ['first', 'second'].map((actionId, i) => ({
        actionId,
        order: i + 1,
        obstacleId: 'last',
        usage: 'Wipe the glass',
        items: [],
        beforeVersion: i,
        afterVersion: i + 1,
        beforeFacts: { obstacleId: 'last', values: { glass: 'fogged' } },
        afterFacts: { obstacleId: 'last', values: { glass: 'clear' } },
        success: true,
        cleared: true,
        narrative: 'The glass is clear.',
      })),
      recentActionScenes: ['first', 'second'].map((actionId, i) => ({
        actionId,
        before: { messageId: sceneIds[i], gameVersion: i },
        after: { messageId: sceneIds[i + 1], gameVersion: i + 1 },
      })),
    };
    const jobs = new EndingJobs(
      ai,
      { enabled: true, apiKey: 'fake', globalAttempts: 100, timeoutMs: 60000, concurrent: 2 },
      results,
      {
        now: () => 0,
        graceMs: 20,
        referenceWaitMs: 100,
        onFailure: (_id, _stage, code) => failures.push(code),
        onRecovery: (_id, _stage, code) => recoveries.push(code),
        fal: {
          async submit() {
            submits++;
            return { requestId: 'fake', statusUrl: 'fake', resultUrl: 'fake', cancelUrl: 'fake' };
          },
          async status() {
            return 'COMPLETED';
          },
          async result() {
            return { videoUrl: 'fake' };
          },
          async downloadVideo() {
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
    jobs.enqueue(packet, () => packet);
    results.end(playId, { status: 'lost' });
    if ('late' in variant && variant.late) {
      // Late images stay excluded if a completed reference existed at the cutoff.
      for (const version of [1, 2])
        results.updateMessage(playId, sceneIds[version], {
          imageSlot: {
            status: 'ready',
            assetId: assetIds[version],
            errorCode: null,
            deadline: new Date(600000).toISOString(),
          },
        });
    }
    for (
      let i = 0;
      i < 300 && !['ready', 'failed'].includes(results.ending('owner', playId).status);
      i++
    )
      await new Promise((r) => setTimeout(r, 5));
    if ('directionFailure' in variant) {
      const view = results.ending('owner', playId);
      assert.equal(view.status, 'ready');
      assert.equal(view.storyStatus, 'ready');
      assert.equal(view.story!.tagId, 'bare_hands');
      assert.equal(view.story!.text, design.story);
      assert.equal(view.errorCode, null);
      assert.match(recoveries[0], /^ENDING_DIRECTION_/);
      assert.match(edits[0].prompt, /"mode":"aftermath"/);
      assert.match(edits[0].prompt, /"targetGameVersion":2/);
    }
    if (latestVersion === undefined) {
      assert.equal(results.ending('owner', playId).status, 'failed');
      assert.deepEqual(failures, ['ENDING_REFERENCE_MISSING']);
      assert.equal(submits, 0);
      assert.equal(edits.length, 0);
      assert.equal(results.ending('owner', playId).storyStatus, 'ready');
      assert.equal(results.ending('owner', playId).story!.text, design.story);
      return;
    }
    assert.deepEqual(failures, []);
    assert.equal(results.ending('owner', playId).status, 'ready');
    assert.equal(submits, 1);
    assert.equal(edits.length, 2);
    const startVersion = hasLastActionReference ? 1 : latestVersion;
    assert.deepEqual(
      edits[0].images[0],
      results.sceneReference(playId, sceneIds[startVersion], startVersion)!.jpeg,
    );
    assert.deepEqual(
      edits[1].images[0],
      design.mode === 'aftermath'
        ? inspectedStart
        : results.sceneReference(playId, sceneIds[latestVersion], latestVersion)!.jpeg,
    );
    assert.equal(edits[1].images.length, design.mode === 'aftermath' ? 1 : 2);
    assert.match(edits[1].prompt, /"targetGameVersion":2/);
    assert.match(
      edits[1].prompt,
      new RegExp(
        '"referenceGameVersion":' +
          (design.mode === 'aftermath' ? packet.gameVersion : latestVersion),
      ),
    );
    assert.match(edits[1].prompt, /"glass":"clear"/);
  });
