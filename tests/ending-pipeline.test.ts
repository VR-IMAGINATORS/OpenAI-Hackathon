import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {
  createEndingDesign,
  createEndingText,
  endingClues,
  type EndingDesign,
  type EndingReference,
} from '../apps/local-server/ending-ai.js';
import type { EndingPacket } from '../apps/local-server/ending.js';
import { ScenarioCatalog } from '../apps/server/scenario-catalog.js';
import { createEndingFrames } from '../packages/server/ending-image-service.js';
import { loadAiConfig } from '../packages/server/ai-config.js';
import type { AiService } from '../packages/server/ai-service.js';
import type { EndingCallKind } from '../packages/server/ending-ai-request.js';
import { localizeScenario } from '../packages/shared/scenario.js';

const signal = () => new AbortController().signal;
const response = (value: unknown) => ({
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
});
interface RecordedCall {
  kind: EndingCallKind;
  body: any;
  frame?: 'start' | 'end';
}
function fakeAi(run: (call: RecordedCall) => unknown | Promise<unknown>) {
  const calls: RecordedCall[] = [];
  const ai = {
    config: loadAiConfig({ AI_MODE: 'mock' }),
    endingDelay: () => 0,
    endingCall: async (
      _jobId: string,
      _epoch: number,
      kind: EndingCallKind,
      body: unknown,
      _signal: AbortSignal,
      frame?: 'start' | 'end',
    ) => {
      const call = { kind, body, frame };
      calls.push(call);
      return run(call);
    },
  } as unknown as AiService;
  return { ai, calls };
}
function packet(clue = 'The red mark was a signal left by the player.'): EndingPacket {
  const snapshot = structuredClone(
    new ScenarioCatalog({
      scenarioPath: 'scenarios/mobile-playtest.json',
      coreConfigPath: 'config/game-core.json',
    }).current('en'),
  );
  snapshot.scenarioV2.obstacles[2].situation = 'UNPRESENTED_SECRET_SITUATION';
  const actions = Array.from({ length: 4 }, (_, index) => ({
    actionId: `action-${index + 1}`,
    order: index + 1,
    obstacleId: `obstacle-${index + 1}`,
    usage: `Use the confirmed rope ${index + 1}`,
    items: [
      {
        id: 'rope',
        name: 'rope',
        beforeStatus: 'available' as const,
        afterStatus: 'damaged' as const,
      },
    ],
    beforeVersion: index,
    afterVersion: index + 1,
    beforeFacts: { obstacleId: 'last', values: { door: 'closed', progress: String(index) } },
    afterFacts: { obstacleId: 'last', values: { door: 'closed', progress: String(index + 1) } },
    success: index === 0 || index === 2,
    narrative: `Confirmed result ${index + 1}`,
    cleared: index === 0 || index === 2,
  }));
  return {
    playId: 'test-play',
    snapshot,
    scenario: localizeScenario(snapshot.scenarioV2, 'en'),
    locale: 'en',
    outcome: 'normal',
    endReason: 'action_limit',
    clearedIds: ['first', 'second'],
    remainingObstacles: [
      { id: 'last', title: 'Locked door', situation: 'UNPRESENTED_SECRET_SITUATION' },
    ],
    facts: actions[3].afterFacts,
    inventory: [
      {
        id: 'rope',
        name: 'rope',
        description: 'Frayed by the confirmed attempts',
        status: 'damaged',
      },
    ],
    actions,
    evidence: {
      records: [
        {
          sourceId: 'early-clue',
          kind: 'assistant_transcript',
          order: 1,
          generation: 1,
          gameVersion: 0,
          text: clue,
        },
        {
          sourceId: 'late-clue',
          kind: 'situation',
          order: 2,
          generation: 2,
          gameVersion: 4,
          text: 'The same mark is visible by the locked door.',
        },
      ],
      truncated: false,
    },
    endedAt: 1000,
    gameVersion: 4,
    finalMessageId: 'final-scene',
    recentActionScenes: [],
  };
}
function design(overrides: Partial<EndingDesign> = {}): EndingDesign {
  return {
    title: 'The unfinished signal',
    tag: null,
    story: 'The damaged rope rests beneath the mark. The last door remains closed.',
    evaluation: 'Your rope loosened two restraints; the final lock remained.',
    usedEvidenceIds: ['early-clue'],
    usedActionIds: ['action-3', 'action-4'],
    candidates: [
      { focus: 'two actions', reason: 'one location' },
      { focus: 'one action', reason: 'clear contact' },
      { focus: 'aftermath', reason: 'preserve known state' },
    ],
    selectionReason: 'The established clue shapes the reaction.',
    mode: 'actions',
    startPrompt: 'A restrained person examines the known frayed rope in the same room.',
    endPrompt: 'The person pauses by the closed door and the established red mark.',
    videoPrompt: 'A 15-second aftermath with environmental sounds, no speech or music.',
    ...overrides,
  };
}
const final: EndingReference = {
  messageId: 'final-scene',
  gameVersion: 4,
  jpeg: Buffer.from('final-reference'),
};
const before: EndingReference = {
  messageId: 'before-scene',
  gameVersion: 2,
  jpeg: Buffer.from('before-reference'),
};
const payloadOf = (call: RecordedCall) => JSON.parse(call.body.input[0].content[0].text);

test('ending writer receives early clues and every confirmed action, distinct per play without secret situations', async () => {
  const first = packet('The red mark meant a promise to return.');
  const second = packet('The blue stripe marks the players earlier warning.');
  second.playId = 'second-play';
  second.actions[0].narrative = 'A different confirmed first action changed this play.';
  const f = fakeAi(() => response(design()));
  await createEndingDesign(f.ai, 'job-first', first, final, before, signal());
  await createEndingDesign(f.ai, 'job-second', second, final, before, signal());
  assert.deepEqual(
    f.calls.map((call) => call.kind),
    ['story', 'story'],
  );
  const [a, b] = f.calls.map(payloadOf);
  assert.deepEqual(a.actions, first.actions);
  assert.equal(a.tagCatalog.length, 40);
  assert.deepEqual(a.recentActionIds, ['action-3', 'action-4']);
  assert.equal(a.presentedEvidence[0].text, first.evidence.records[0].text);
  assert.equal(b.presentedEvidence[0].text, second.evidence.records[0].text);
  assert.notEqual(a.actions[0].narrative, b.actions[0].narrative);
  assert(!JSON.stringify(a).includes(second.evidence.records[0].text));
  assert(!JSON.stringify(b).includes(first.evidence.records[0].text));
  assert(!JSON.stringify(a).includes('UNPRESENTED_SECRET_SITUATION'));
  assert.deepEqual(a.endingTitle, { text: 'to be continued', position: 'lower right' });
  assert.equal(a.outcome, 'normal');
  assert.deepEqual(a.facts, first.facts);
  assert.equal(f.calls[0].body.max_output_tokens, 4096);
  assert.equal(f.calls[0].body.input[0].content.length, 3);
  assert.match(f.calls[0].body.instructions, /confirmed outcome and facts override/);
  assert.match(f.calls[0].body.instructions, /Normal\/bad means not escaped/);
  assert.match(f.calls[0].body.instructions, /No speech, narration, singing or music/);
});

test('tag evidence can use an early action outside the two film actions and text-only uses the same catalog', async () => {
  const chosen = {
    id: 'unexpected_use' as const,
    evidenceActionIds: ['action-1'],
    reason: 'An early improvised use.',
  };
  const f = fakeAi(() => response(design({ tag: chosen })));
  const result = await createEndingDesign(f.ai, 'job', packet(), final, before, signal());
  assert.deepEqual(result.tag, chosen);
  const textAi = fakeAi(() =>
    response({
      title: result.title,
      story: result.story,
      evaluation: result.evaluation,
      usedEvidenceIds: result.usedEvidenceIds,
      tag: chosen,
    }),
  );
  const textResult = await createEndingText(textAi.ai, 'text-job', packet(), signal());
  assert.deepEqual(textResult.tag, chosen);
  assert.equal(textAi.calls.length, 1);
  assert.equal(textAi.calls[0].body.input[0].content.length, 1);
  assert.deepEqual(payloadOf(textAi.calls[0]).actions, packet().actions);
  assert.deepEqual(payloadOf(textAi.calls[0]).tagCatalog, payloadOf(f.calls[0]).tagCatalog);
});

test('writer rejects unknown tags, invented or duplicate tag evidence and overlong summaries', async () => {
  for (const patch of [
    { tag: { id: 'invented', evidenceActionIds: ['action-1'], reason: 'unknown' } },
    { tag: { id: 'tools', evidenceActionIds: ['missing'], reason: 'unknown' } },
    { tag: { id: 'tools', evidenceActionIds: ['action-1', 'action-1'], reason: 'duplicate' } },
    { story: 'x'.repeat(241) },
  ]) {
    const f = fakeAi(() => response({ ...design(), ...patch }));
    await assert.rejects(createEndingDesign(f.ai, 'job', packet(), final, before, signal()));
    assert.equal(f.calls.length, 1);
  }
});

test('ending writer rejects invented sources and non-recent, duplicate or reversed action selections', async () => {
  for (const invalid of [
    { usedEvidenceIds: ['fabricated-clue'] },
    { usedActionIds: ['action-1'] },
    { usedActionIds: ['action-3', 'action-3'] },
    { usedActionIds: ['action-4', 'action-3'] },
    { usedActionIds: ['action-2', 'action-3', 'action-4'] },
  ]) {
    const f = fakeAi(() => response(design(invalid)));
    await assert.rejects(createEndingDesign(f.ai, 'job', packet(), final, before, signal()));
    assert.equal(f.calls.length, 1);
  }
});

test('missing or wrong before-action references force aftermath; no-action endings invent no attempt', async () => {
  const f = fakeAi(() => response(design()));
  await assert.rejects(
    createEndingDesign(f.ai, 'job', packet(), final, undefined, signal()),
    /ENDING_INVALID_CONTINUITY/,
  );
  await assert.rejects(
    createEndingDesign(f.ai, 'job', packet(), final, { ...before, gameVersion: 1 }, signal()),
    /ENDING_INVALID_CONTINUITY/,
  );
  const aftermath = fakeAi(() => response(design({ mode: 'aftermath', usedActionIds: [] })));
  const empty = packet();
  empty.actions = [];
  empty.outcome = 'bad';
  empty.clearedIds = [];
  empty.endReason = 'time_limit';
  const result = await createEndingDesign(aftermath.ai, 'job', empty, final, undefined, signal());
  assert.equal(result.mode, 'aftermath');
  const input = payloadOf(aftermath.calls[0]);
  assert.deepEqual(input.actions, []);
  assert.deepEqual(input.recentActionIds, []);
  assert.deepEqual(input.references, [
    { role: 'confirmed final state', messageId: final.messageId, gameVersion: 4 },
  ]);
  assert.match(aftermath.calls[0].body.instructions, /For no actions use initial constraints/);
});

test('long evidence is extracted across bounded chunks retaining both early and final sources', async () => {
  const long = packet();
  long.evidence.records = Array.from({ length: 20 }, (_, index) => ({
    sourceId: `source-${index}`,
    kind: 'situation' as const,
    order: index,
    generation: 1,
    gameVersion: 0,
    text: `Unique clue ${index}: ` + 'known observation '.repeat(500),
  }));
  const f = fakeAi((call) => {
    const part = payloadOf(call) as EndingPacket['evidence']['records'];
    return response({
      clues: part.map((record) => ({ sourceId: record.sourceId, quote: record.text.slice(0, 30) })),
    });
  });
  const clues = await endingClues(f.ai, 'job', long, signal());
  assert(f.calls.length >= 2 && f.calls.length <= 6);
  assert(
    f.calls.every((call) => call.kind === 'extraction' && call.body.max_output_tokens === 2048),
  );
  const seen = f.calls.flatMap((call) =>
    payloadOf(call).map((record: { sourceId: string }) => record.sourceId),
  );
  assert.deepEqual(
    seen,
    long.evidence.records.map((record) => record.sourceId),
  );
  assert(
    f.calls.every((call) => Buffer.byteLength(call.body.input[0].content[0].text) <= 96 * 1024),
  );
  assert.equal(clues[0].sourceId, 'source-0');
  assert.equal(clues.at(-1)!.sourceId, 'source-19');
});

test('evidence extraction rejects fabricated source IDs, inaccurate quotations and oversized records without retry', async () => {
  const long = packet();
  long.evidence.records[0].text = 'Known red mark. '.repeat(4000);
  for (const clue of [
    { sourceId: 'fabricated', quote: 'Known red mark.' },
    { sourceId: 'early-clue', quote: 'The red mark guarantees a rescue.' },
  ]) {
    const f = fakeAi(() => response({ clues: [clue] }));
    await assert.rejects(endingClues(f.ai, 'job', long, signal()), /ENDING_INVALID_EVIDENCE/);
    assert.equal(f.calls.length, 1);
  }
  const oversized = packet();
  oversized.evidence.records[1].text = 'x'.repeat(100 * 1024);
  const f = fakeAi(() => response({ clues: [] }));
  await assert.rejects(endingClues(f.ai, 'job', oversized, signal()), /ENDING_EVIDENCE_TOO_LARGE/);
  assert.equal(f.calls.length, 0);
});

async function generatedJpeg(size = 1024) {
  return sharp({ create: { width: size, height: size, channels: 3, background: '#884422' } })
    .jpeg()
    .toBuffer();
}
function imageResponse(bytes: Buffer) {
  return { data: [{ b64_json: bytes.toString('base64') }] };
}

test('frames retry only an explicit rejection once per frame and pass the accepted start to the end inspection', async () => {
  const jpeg = await generatedJpeg();
  const checks = ['reject', 'pass', 'reject', 'pass'];
  const f = fakeAi((call) =>
    call.kind === 'frame'
      ? imageResponse(jpeg)
      : response({
          verdict: checks.shift(),
          problems: checks.length % 2 === 1 ? ['Correct the rope contact.'] : [],
        }),
  );
  const frames = await createEndingFrames(f.ai, 'job', packet(), design(), final, before, signal());
  assert.equal((await sharp(frames.start).metadata()).width, 1024);
  assert.equal((await sharp(frames.end).metadata()).height, 1024);
  const generations = f.calls.filter((call) => call.kind === 'frame');
  assert.deepEqual(
    generations.map((call) => call.frame),
    ['start', 'start', 'end', 'end'],
  );
  assert(
    generations.every(
      (call) =>
        call.body.n === 1 &&
        call.body.size === '1024x1024' &&
        call.body.quality === 'low' &&
        call.body.output_format === 'jpeg',
    ),
  );
  assert.deepEqual(generations[0].body.images, [before.jpeg]);
  assert.deepEqual(generations[2].body.images, [final.jpeg, frames.start]);
  assert.match(generations[1].body.prompt, /Correct the rope contact/);
  assert.match(generations[2].body.prompt, /arrow artwork will be composited separately/);
  const endInspection = f.calls.filter((call) => call.kind === 'inspection').at(-1)!;
  assert.equal(
    endInspection.body.input[0].content[1].image_url,
    'data:image/jpeg;base64,' + frames.end.toString('base64'),
  );
  assert.notDeepEqual(frames.end, frames.start, 'the actual arrow is composited before inspection');
  assert.equal(
    endInspection.body.input[0].content[2].image_url,
    'data:image/jpeg;base64,' + frames.start.toString('base64'),
  );
  assert.deepEqual(payloadOf(endInspection).target, packet().facts);
});

test('normal and bad endings use the arrow while happy endings keep their generated SUCCESS title', async () => {
  const jpeg = await generatedJpeg();
  for (const outcome of ['normal', 'bad', 'happy'] as const) {
    const ending = packet();
    ending.outcome = outcome;
    const f = fakeAi((call) =>
      call.kind === 'frame' ? imageResponse(jpeg) : response({ verdict: 'pass', problems: [] }),
    );
    const frames = await createEndingFrames(f.ai, 'job', ending, design(), final, before, signal());
    const endPrompt = f.calls.filter((call) => call.kind === 'frame').at(-1)!.body.prompt;
    if (outcome === 'happy') {
      assert.deepEqual(frames.end, frames.start);
      assert.match(endPrompt, /SUCCESS!!/);
    } else {
      assert.match(endPrompt, /Do not draw any title/);
      const region = await sharp(frames.end)
        .extract({ left: 382, top: 802, width: 560, height: 140 })
        .stats();
      assert(region.channels.every((channel) => channel.max > 240 && channel.min < 15));
      const scene = await sharp(frames.end)
        .extract({ left: 100, top: 100, width: 100, height: 100 })
        .stats();
      assert(Math.abs(scene.channels[0].mean - 136) < 5, 'the scene remains visible');
    }
  }
});

test('persistent frame rejection stops after two submissions without generating the other frame', async () => {
  const jpeg = await generatedJpeg();
  const f = fakeAi((call) =>
    call.kind === 'frame'
      ? imageResponse(jpeg)
      : response({ verdict: 'reject', problems: ['The restraint disappeared.'] }),
  );
  await assert.rejects(
    createEndingFrames(f.ai, 'job', packet(), design(), final, before, signal()),
    /ENDING_FRAME_REJECTED/,
  );
  assert.deepEqual(
    f.calls.filter((call) => call.kind === 'frame').map((call) => call.frame),
    ['start', 'start'],
  );
});

test('unknown inspection, inconsistent pass and network failure never trigger frame regeneration', async () => {
  const jpeg = await generatedJpeg();
  for (const failure of ['unknown', 'pass-with-problem', 'inspection-network', 'frame-network']) {
    const f = fakeAi((call) => {
      if (call.kind === 'frame') {
        if (failure === 'frame-network') throw new Error('ambiguous transport error');
        return imageResponse(jpeg);
      }
      if (failure === 'inspection-network') throw new Error('inspection connection lost');
      return response({
        verdict: failure === 'unknown' ? 'unknown' : 'pass',
        problems: failure === 'pass-with-problem' ? ['Unresolved contradiction'] : [],
      });
    });
    await assert.rejects(
      createEndingFrames(f.ai, 'job', packet(), design(), final, before, signal()),
    );
    assert.equal(f.calls.filter((call) => call.kind === 'frame').length, 1);
    assert.equal(
      f.calls.filter((call) => call.kind === 'inspection').length,
      failure === 'frame-network' ? 0 : 1,
    );
  }
});

test('frame validation rejects undersized square output before inspection or fal submission', async () => {
  const jpeg = await generatedJpeg(32);
  const f = fakeAi((call) =>
    call.kind === 'frame' ? imageResponse(jpeg) : response({ verdict: 'pass', problems: [] }),
  );
  await assert.rejects(
    createEndingFrames(f.ai, 'job', packet(), design(), final, before, signal()),
    /ENDING_FRAME_DIMENSIONS/,
  );
  assert.equal(f.calls.length, 1);
});
