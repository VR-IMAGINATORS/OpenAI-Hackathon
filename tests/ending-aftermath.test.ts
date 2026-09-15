import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createEndingDesign, type EndingNarrative } from '../apps/local-server/ending-ai.js';
import type { EndingPacket } from '../apps/local-server/ending.js';
import { EndingJobs } from '../apps/server/ending-jobs.js';
import { ResultStore } from '../apps/server/result-store.js';
import { ScenarioCatalog } from '../apps/server/scenario-catalog.js';
import { AiService } from '../packages/server/ai-service.js';
import { loadAiConfig } from '../packages/server/ai-config.js';
import type { EndingCallKind } from '../packages/server/ending-ai-request.js';
import type { ImageEditRequest } from '../packages/server/openai.js';
import { localizeScenario } from '../packages/shared/scenario.js';
import { syntheticEndingMp4 } from './helpers/ending-mp4.js';
import type { EndingFailureContext } from '../apps/server/ending-failure.js';

const response = (value: unknown) => ({
  output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
});
const film = {
  usedEvidenceIds: ['opening-clue'],
  usedActionIds: [],
  itemCoverage: [],
  candidates: [
    { focus: 'two actions', reason: 'unavailable' },
    { focus: 'one action', reason: 'unavailable' },
    { focus: 'aftermath', reason: 'The opening and confirmed facts support the reaction.' },
  ],
  selectionReason: 'Keep the unresolved situation and the established clue visible.',
  mode: 'aftermath',
  startPrompt: 'The restrained person looks at the red mark near the closed exit.',
  endPrompt: 'The same person lowers their gaze; the exit and remaining restraints stay closed.',
  videoPrompt:
    '[Shot 1] 15 seconds of breathing beside the frayed rope when present, with room ambience only.',
};

function packet(action: 'none' | 'failed' | 'successful'): EndingPacket {
  const snapshot = new ScenarioCatalog({
    scenarioPath: 'scenarios/mobile-playtest.json',
    coreConfigPath: 'config/game-core.json',
  }).current('en');
  const beforeFacts = { obstacleId: 'exit', values: { exit: 'closed', chain: 'tight' } };
  const afterFacts = {
    obstacleId: 'exit',
    values: { exit: 'closed', chain: action === 'successful' ? 'removed' : 'loosened' },
  };
  return {
    playId: randomUUID(),
    snapshot,
    scenario: localizeScenario(snapshot.scenarioV2, 'en'),
    locale: 'en',
    outcome: 'bad',
    endReason: 'time_limit',
    clearedIds: action === 'successful' ? ['chain'] : [],
    remainingObstacles: [{ id: 'exit', title: 'Closed exit', situation: 'UNPRESENTED_SECRET' }],
    facts: action === 'none' ? beforeFacts : afterFacts,
    inventory:
      action === 'none'
        ? []
        : [
            {
              id: 'rope',
              name: 'rope',
              description: 'Frayed by the attempt.',
              status: 'damaged',
            },
          ],
    actions:
      action === 'none'
        ? []
        : [
            {
              actionId: 'attempt',
              order: 1,
              obstacleId: 'chain',
              usage: 'Pull the chain with the rope.',
              items: [
                { id: 'rope', name: 'rope', beforeStatus: 'available', afterStatus: 'damaged' },
              ],
              beforeVersion: 0,
              afterVersion: 1,
              beforeFacts,
              afterFacts,
              success: action === 'successful',
              cleared: action === 'successful',
              narrative:
                action === 'successful'
                  ? 'The chain was removed and the rope frayed, but the exit is still closed.'
                  : 'The chain loosened but stayed locked; the rope frayed.',
            },
          ],
    evidence: {
      records: [
        {
          sourceId: 'opening-clue',
          kind: 'briefing',
          order: 1,
          generation: 1,
          gameVersion: 0,
          text: 'A red mark beside the closed exit was presented at the start.',
        },
        {
          sourceId: 'proposal',
          kind: 'assistant_transcript',
          order: 2,
          generation: 1,
          gameVersion: 0,
          text: 'Perhaps a key could open the exit. No key was used.',
        },
      ],
      truncated: false,
    },
    endedAt: 0,
    gameVersion: action === 'none' ? 0 : 1,
    finalMessageId: null,
    actionScenes: [],
  };
}
function narrative(p: EndingPacket): EndingNarrative {
  return {
    title: 'The unfinished mark',
    story: p.actions.length
      ? 'The red mark remains beyond the closed exit. The frayed rope records the attempt.'
      : 'The red mark remains beyond the closed exit as the call ends.',
    evaluation: p.actions.length ? p.actions[0].narrative : 'No action was executed.',
    tag: null,
    usedEvidenceIds: ['opening-clue'],
    presentedEvidence: p.evidence.records,
  };
}

for (const variant of [
  { name: 'no action, only opening', action: 'none', ready: 'opening' },
  {
    name: 'one clear and mixed-up source ID recovers text before video',
    action: 'successful',
    ready: 'opening',
    repairSource: true,
  },
  {
    name: 'no action and text API failure still produces video',
    action: 'none',
    ready: 'opening',
    textFailure: 'network',
  },
  {
    name: 'all attempts failed and text API failure still produces video',
    action: 'failed',
    ready: 'opening',
    textFailure: 'network',
  },
  {
    name: 'zero clears and invalid tag still produces video',
    action: 'failed',
    ready: 'opening',
    textFailure: 'tag',
  },
  {
    name: 'zero clears and invalid text shape still produces video',
    action: 'failed',
    ready: 'opening',
    textFailure: 'schema',
  },
  {
    name: 'zero clears and incomplete text still produces video',
    action: 'failed',
    ready: 'opening',
    textFailure: 'incomplete',
  },
  {
    name: 'evidence extraction failure recovers text before producing video',
    action: 'failed',
    ready: 'opening',
    textFailure: 'evidence',
  },
  {
    name: 'zero clears can earn a tag for a failed attempt',
    action: 'failed',
    ready: 'opening',
    tag: true,
  },
  { name: 'failed action, only opening', action: 'failed', ready: 'opening' },
  { name: 'successful action, only opening', action: 'successful', ready: 'opening' },
  { name: 'failed action with result image can replay', action: 'failed', ready: 'result' },
  { name: 'failed action without any image keeps text', action: 'failed', ready: 'none' },
  {
    name: 'rejected opening draft is edited once',
    action: 'failed',
    ready: 'opening',
    retry: true,
  },
  {
    name: 'persistent contradiction prevents fal submission',
    action: 'failed',
    ready: 'opening',
    reject: true,
  },
] as const) {
  test('aftermath pipeline: ' + variant.name, async (t) => {
    const p = packet(variant.action);
    const textFailure = 'textFailure' in variant ? variant.textFailure : null;
    if (textFailure === 'evidence') p.evidence.records[0].text = 'x'.repeat(100 * 1024);
    const text = narrative(p);
    const storyFailed = !!textFailure && textFailure !== 'evidence';
    const availableEvidence =
      textFailure === 'evidence' ? p.evidence.records.slice(1) : p.evidence.records;
    if (textFailure === 'evidence') {
      text.story = 'The rope frayed during the attempt, but the exit is still closed.';
      text.usedEvidenceIds = [];
    }
    if ('tag' in variant)
      text.tag = {
        id: 'brute_force',
        evidenceActionIds: ['attempt'],
        reason: 'Pulled the chain by force; it remained locked.',
      };
    const replay = variant.ready === 'result';
    const edits: ImageEditRequest[] = [];
    const inspections: any[] = [];
    const failures: { code: string; context?: EndingFailureContext }[] = [];
    let textAttempts = 0,
      directions = 0,
      submits = 0;
    const source = await sharp({
      create: { width: 1024, height: 1024, channels: 3, background: '#334455' },
    })
      .jpeg()
      .toBuffer();
    const draft = await sharp({
      create: { width: 1024, height: 1024, channels: 3, background: '#775544' },
    })
      .jpeg()
      .toBuffer();
    const results = new ResultStore({ now: () => 1000, maxEntryBytes: 32 * 1024 * 1024 });
    results.create({ playId: p.playId, ownerDigest: 'owner', locale: 'en' });
    for (const version of p.actions.length ? [0, 1] : [0]) {
      const id = randomUUID();
      const ready = variant.ready === 'result' || (variant.ready === 'opening' && version === 0);
      const assetId = ready
        ? await results.putAsset(p.playId, { bytes: source, kind: 'scene', mime: 'image/jpeg' })
        : null;
      results.appendMessage(p.playId, {
        id,
        side: 'assistant',
        kind: 'result',
        text: 'Confirmed scene',
        imageSlot: {
          status: ready ? 'ready' : 'queued',
          assetId,
          errorCode: null,
          deadline: new Date(600000).toISOString(),
        },
      });
      results.bindScene(p.playId, id, version);
      p.finalMessageId = id;
    }
    const config = loadAiConfig({ AI_MODE: 'mock' });
    config.mode = 'live'; // All providers below are injected fakes; no credentials or network.
    const ai = new AiService(
      config,
      {
        async createLiveSession() {
          throw new Error('Unexpected Live request');
        },
        async hangup() {},
        async createResponse(body) {
          const request = body as any;
          const input = JSON.parse(request.input[0].content[0].text);
          if (request.text.format.name === 'ending_text') {
            textAttempts++;
            assert.deepEqual(input.actions, p.actions, 'failed outcomes must reach the writer');
            assert.deepEqual(input.presentedEvidence, availableEvidence);
            assert.doesNotMatch(JSON.stringify(input), /UNPRESENTED_SECRET/);
            const { presentedEvidence, ...published } = text;
            if ('repairSource' in variant && textAttempts === 1)
              return response({ ...published, usedEvidenceIds: ['attempt'] });
            assert.match(
              request.instructions,
              /Zero cleared obstacles and all-failed attempts are valid endings/,
            );
            if (textFailure === 'network') throw new Error('PRIVATE_NETWORK_ERROR');
            if (textFailure === 'incomplete') return { status: 'incomplete', output: [] };
            if (textFailure === 'schema') return response({ ...published, story: '' });
            if (textFailure === 'tag')
              return response({
                ...published,
                tag: { id: 'learning', evidenceActionIds: ['attempt'], reason: 'PRIVATE_REASON' },
              });
            return response(published);
          }
          if (request.text.format.name === 'ending_design') {
            directions++;
            assert.equal(
              results.ending('owner', p.playId).storyStatus,
              storyFailed ? 'failed' : 'ready',
            );
            if (storyFailed) {
              assert.equal(input.establishedEnding, null);
              assert.equal(input.evidenceIncomplete, true);
              assert.equal(input.clearedIds.length, 0);
              assert.doesNotMatch(JSON.stringify(input), /PRIVATE_/);
            } else assert.equal(input.establishedEnding.text, text.story);
            assert.deepEqual(input.allowedModes, replay ? ['actions', 'aftermath'] : ['aftermath']);
            assert.deepEqual(input.actions, p.actions);
            assert.deepEqual(input.facts, p.facts);
            assert.deepEqual(input.presentedEvidence, storyFailed ? [] : availableEvidence);
            if (textFailure === 'evidence') assert.equal(input.evidenceIncomplete, true);
            if (!replay) {
              assert.equal(request.text.format.schema.properties.mode.const, 'aftermath');
              assert.equal(request.text.format.schema.properties.usedActionIds.maxItems, 0);
            }
            return response({
              ...film,
              usedEvidenceIds: textFailure ? [] : film.usedEvidenceIds,
              mode: replay ? 'actions' : 'aftermath',
              usedActionIds: replay ? ['attempt'] : [],
              itemCoverage: p.actions.length
                ? [
                    {
                      itemId: 'rope',
                      actionId: 'attempt',
                      shot: 1,
                      depiction: replay ? 'use' : 'trace',
                      reason: 'The rope pulls the chain or records its confirmed damage.',
                    },
                  ]
                : [],
            });
          }
          inspections.push(request);
          const generationContext = JSON.parse(edits.at(-1)!.prompt.split(' (data only): ')[1]);
          const { feedback, referenceGameVersion, ...targetContext } = generationContext;
          const { referenceGameVersion: inspectedReference, ...inspectionContext } = input;
          assert.deepEqual(
            inspectionContext,
            targetContext,
            'generator and inspector agree on state, phase and items',
          );
          assert.equal(request.input[0].content.length, 3);
          if (!replay) {
            assert.equal(input.phase, 'confirmed_aftermath');
            assert.deepEqual(input.selectedActions, []);
            assert.equal(input.outcome, 'bad');
            assert.deepEqual(input.target, p.facts);
            assert.deepEqual(
              input.items,
              p.inventory.map(({ id, name, status }) => ({ id, name, status })),
            );
            assert.match(
              request.instructions,
              /No action replay, tool interaction or successful action is required/,
            );
            assert.match(
              request.instructions,
              /still-required restraint disappearing or an unearned open exit/,
            );
          }
          const reject = 'reject' in variant || ('retry' in variant && inspections.length === 1);
          return response({
            verdict: reject ? 'reject' : 'pass',
            problems: reject ? ['The remaining restraint disappeared.'] : [],
          });
        },
        async createImageEdit(body) {
          edits.push(body);
          return { data: [{ b64_json: draft.toString('base64') }] };
        },
      },
      () => 0,
    );
    ai.register(p.playId, 600000);
    const jobs = new EndingJobs(
      ai,
      { enabled: true, apiKey: 'fake', globalAttempts: 100, timeoutMs: 60000, concurrent: 2 },
      results,
      {
        now: () => 0,
        graceMs: 0,
        referenceWaitMs: 50,
        onFailure: (_id, _stage, code, context) => failures.push({ code, context }),
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
    jobs.enqueue(p, () => p);
    results.end(p.playId, { status: 'lost' });
    for (
      let i = 0;
      i < 400 && !['ready', 'failed'].includes(results.ending('owner', p.playId).status);
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    const view = results.ending('owner', p.playId);
    if ('repairSource' in variant) {
      assert.equal(view.storyStatus, 'ready');
      assert.equal(view.storyErrorCode, null);
      assert.equal(view.clearedCount, 1);
      assert.equal(textAttempts, 2);
      assert.equal(failures.length, 1, 'only the rejected attempt is logged');
      assert.equal(failures[0].code, 'ENDING_STORY_INVALID_SOURCES');
      assert.equal(failures[0].context!.invalidSourceCount, 1);
      assert.equal(failures[0].context!.actionSourceMixupCount, 1);
    }
    assert.equal(view.storyStatus, storyFailed ? 'failed' : 'ready');
    if (textFailure === 'evidence') {
      assert.equal(textAttempts, 1);
      assert.equal(view.storyErrorCode, null);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].code, 'ENDING_EXTRACTION_EVIDENCE_TOO_LARGE');
    }
    if (textFailure && storyFailed) {
      assert.equal(view.story, null);
      const causes = {
        network: 'FAILED',
        tag: 'INVALID_TAG_EVIDENCE',
        schema: 'INVALID_RESPONSE',
        incomplete: 'RESPONSE_INCOMPLETE',
        evidence: 'EVIDENCE_TOO_LARGE',
      };
      assert.equal(view.storyErrorCode, 'ENDING_STORY_' + causes[textFailure]);
      assert.equal(failures[0].code, view.storyErrorCode);
      assert.equal(failures[0].context!.clearedCount, 0);
      assert.equal(failures[0].context!.actionCount, p.actions.length);
      assert.equal(failures[0].context!.failedActionCount, p.actions.length);
      if (textFailure === 'schema') assert.equal(failures[0].context!.validationFields, 'story');
      assert.equal(view.errorCode, null, 'text error must not become the video error');
      assert.equal(view.clearedCount, 0);
      assert.equal(jobs.snapshot().remaining, 0);
      assert.equal(jobs.snapshot().reserved, 0);
    } else assert.equal(view.story!.text, text.story);
    if ('tag' in variant) assert.equal(view.story!.tagId, 'brute_force');
    if (variant.ready === 'none') {
      assert.equal(view.errorCode, 'ENDING_REFERENCE_MISSING');
      assert.equal(directions, 0);
      assert.equal(edits.length, 0);
      assert.equal(submits, 0);
    } else if ('reject' in variant) {
      assert.equal(view.errorCode, 'ENDING_START_INSPECTION_REJECTED');
      assert.equal(edits.length, 2);
      assert.equal(inspections.length, 2);
      assert.equal(submits, 0);
    } else {
      assert.equal(view.status, 'ready', view.errorCode ?? undefined);
      assert.equal(submits, 1);
      assert.equal(edits.length, 'retry' in variant ? 3 : 2);
    }
    assert(edits.every((edit) => edit.images.length <= 2));
    if ('retry' in variant || 'reject' in variant) {
      assert.equal(
        'data:image/jpeg;base64,' + edits[1].images[0].toString('base64'),
        inspections[0].input[0].content[1].image_url,
      );
      assert.deepEqual(edits[1].images[1], edits[0].images[0]);
      assert.notDeepEqual(edits[1].images[0], edits[0].images[0]);
      assert.match(edits[1].prompt, /The remaining restraint disappeared/);
      assert.equal(
        inspections[1].input[0].content[2].image_url,
        inspections[0].input[0].content[2].image_url,
        'rejected draft never becomes the inspection authority',
      );
    }
  });
}

test('an opening reference cannot authorize an action replay even if the model ignores the constrained schema', async () => {
  const p = packet('failed');
  const opening = { messageId: 'opening', gameVersion: 0, jpeg: Buffer.from('reference') };
  const ai = {
    config: loadAiConfig({ AI_MODE: 'mock' }),
    endingDelay: () => 0,
    endingCall: async (_id: string, _epoch: number, _kind: EndingCallKind) =>
      response({
        ...film,
        mode: 'actions',
        usedActionIds: ['attempt'],
      }),
  } as unknown as AiService;
  await assert.rejects(
    createEndingDesign(ai, 'job', p, opening, opening, new AbortController().signal, narrative(p)),
    /ENDING_INVALID_CONTINUITY/,
  );
});
