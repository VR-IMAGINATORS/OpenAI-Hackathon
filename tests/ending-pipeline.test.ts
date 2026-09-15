import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {
  createEndingDesign,
  createEndingText,
  endingClues,
  EndingSourceError,
  type EndingDesign,
  type EndingNarrative,
  type EndingReference,
} from '../apps/local-server/ending-ai.js';
import type { EndingPacket } from '../apps/local-server/ending.js';
import { ScenarioCatalog } from '../apps/server/scenario-catalog.js';
import { createEndingFrames } from '../packages/server/ending-image-service.js';
import { loadAiConfig } from '../packages/server/ai-config.js';
import type { AiService } from '../packages/server/ai-service.js';
import type { EndingCallKind } from '../packages/server/ending-ai-request.js';
import { parseEndingResponseRequest } from '../packages/server/ending-ai-request.js';
import { localizeScenario } from '../packages/shared/scenario.js';

const signal = () => new AbortController().signal;
const response = (value: unknown) => {
  // Film API returns only film fields; the published narrative is supplied separately.
  if (value && typeof value === 'object' && 'videoPrompt' in value) {
    const { title, story, evaluation, tag, ...film } = value as EndingDesign & EndingNarrative;
    value = film;
  }
  return {
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
  };
};
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
    endReason: 'time_limit',
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
function design(
  overrides: Partial<EndingDesign & EndingNarrative> = {},
): EndingDesign & Omit<EndingNarrative, 'presentedEvidence'> {
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
const textOutput = () => {
  const { title, story, evaluation, tag, usedEvidenceIds } = design();
  return { title, story, evaluation, tag, usedEvidenceIds };
};
const narrative = (p = packet(), patch: Partial<EndingNarrative> = {}): EndingNarrative => ({
  ...textOutput(),
  presentedEvidence: p.evidence.records,
  ...patch,
});

function manyReferences(): EndingPacket {
  const p = packet();
  p.evidence.records = Array.from({ length: 140 }, (_, i) => ({
    sourceId: `voice:1:${String(i).padStart(4, '0')}` + 'x'.repeat(120),
    kind: 'assistant_transcript' as const,
    order: i + 1,
    generation: 1,
    gameVersion: 0,
    text: 'A known clue.',
  }));
  p.actions = Array.from({ length: 40 }, (_, i) => ({
    ...p.actions[0],
    actionId: `action-${i}-` + 'a'.repeat(120),
    order: i + 1,
  }));
  p.clearedIds = ['first'];
  return p;
}

test('large reference enums fit the real request limit and preserve every story/tag/film source', async () => {
  const p = manyReferences();
  assert(Buffer.byteLength(JSON.stringify(p.evidence.records)) < 48 * 1024);
  const f = fakeAi((call) => {
    parseEndingResponseRequest(call.body); // The previous implementation failed here, before AI.
    assert(Buffer.byteLength(JSON.stringify(call.body.text.format.schema)) <= 16384);
    const input = payloadOf(call);
    assert.equal(input.presentedEvidence.length, 140);
    const ids = [input.presentedEvidence[0].sourceId, input.presentedEvidence.at(-1).sourceId];
    assert.deepEqual(ids, ['e1', 'e140']);
    if (call.kind === 'story') {
      assert.equal(input.actions.length, 40);
      assert.equal(input.actions[0].actionId, 'a1');
      return response({
        ...textOutput(),
        usedEvidenceIds: ids,
        tag: {
          id: 'tools',
          evidenceActionIds: [input.actions[0].actionId, input.actions.at(-1).actionId],
          reason: 'Confirmed tool use.',
        },
      });
    }
    return response(design({ usedEvidenceIds: ids, mode: 'aftermath', usedActionIds: [] }));
  });
  const story = await createEndingText(f.ai, 'job', p, signal());
  const expectedSources = [p.evidence.records[0].sourceId, p.evidence.records.at(-1)!.sourceId];
  assert.deepEqual(story.usedEvidenceIds, expectedSources);
  assert.deepEqual(story.tag!.evidenceActionIds, [
    p.actions[0].actionId,
    p.actions.at(-1)!.actionId,
  ]);
  assert.deepEqual(story.presentedEvidence, p.evidence.records);
  const film = await createEndingDesign(f.ai, 'job', p, final, undefined, signal(), story);
  assert.deepEqual(film.usedEvidenceIds, expectedSources);
  assert.equal(f.calls.length, 2, 'one story and one film call; no extra extraction or repair');
});

test('long extraction IDs map back to exact original quotes without growing the schema', async () => {
  const p = manyReferences();
  for (const record of p.evidence.records) record.text += ' Observation.'.repeat(35);
  assert(Buffer.byteLength(JSON.stringify(p.evidence.records)) > 48 * 1024);
  const f = fakeAi((call) => {
    parseEndingResponseRequest(call.body);
    const part = payloadOf(call);
    assert(part[0].sourceId.startsWith('e'));
    return response({
      clues: [part[0], part.at(-1)].map((record) => ({
        sourceId: record.sourceId,
        quote: record.text.slice(0, 30),
      })),
    });
  });
  const clues = await endingClues(f.ai, 'job', p, signal());
  for (const clue of clues) {
    const original = p.evidence.records.find((record) => record.sourceId === clue.sourceId);
    assert(original);
    assert('quote' in clue && original.text.includes(clue.quote));
  }
  assert.equal(clues[0].sourceId, p.evidence.records[0].sourceId);
  assert.equal(clues.at(-1)!.sourceId, p.evidence.records.at(-1)!.sourceId);
});

test('aliasing never accepts invented aliases or original IDs absent from the model reference list', async () => {
  const p = manyReferences();
  for (const id of ['e999', p.evidence.records[0].sourceId]) {
    const f = fakeAi(() => response({ ...textOutput(), usedEvidenceIds: [id] }));
    await assert.rejects(createEndingText(f.ai, 'job', p, signal()), /ENDING_INVALID_SOURCES/);
    assert.equal(f.calls.length, 2);
  }
});

test('writer response schema separates evidence and action ID namespaces, including empty plays', async () => {
  for (const empty of [false, true]) {
    const p = packet();
    if (empty) {
      p.actions = [];
      p.evidence.records = [];
      p.clearedIds = [];
      p.outcome = 'bad';
    }
    const f = fakeAi(() =>
      response({ ...textOutput(), usedEvidenceIds: empty ? [] : ['early-clue'] }),
    );
    await createEndingText(f.ai, 'job', p, signal());
    const schema = f.calls[0].body.text.format.schema.properties;
    if (empty) {
      assert.equal(schema.usedEvidenceIds.maxItems, 0);
      assert.equal(schema.tag.type, 'null');
    } else {
      assert.deepEqual(schema.usedEvidenceIds.items.enum, ['early-clue', 'late-clue']);
      const tag = schema.tag.anyOf.find((s: any) => s.type === 'object');
      assert.deepEqual(
        tag.properties.evidenceActionIds.items.enum,
        p.actions.map((a) => a.actionId),
      );
    }
    assert.match(f.calls[0].body.instructions, /never actionId, eventId, item IDs/);
    assert.equal(f.calls.length, 1);
  }
});

for (const variant of [
  'action-id',
  'event-id',
  'unknown-id',
  'tag',
  'long',
  'json',
  'incomplete',
] as const) {
  test('writer repairs once after ' + variant + ' without weakening validation', async () => {
    const p = packet();
    p.evidence.records[0].eventId = 'PRIVATE_EVENT';
    let attempts = 0;
    const repairs: unknown[] = [];
    const f = fakeAi(() => {
      if (++attempts === 2) return response(textOutput());
      if (variant === 'json')
        return { output: [{ content: [{ type: 'output_text', text: '{' }] }] };
      if (variant === 'incomplete') return { status: 'incomplete', output: [] };
      const patch =
        variant === 'tag'
          ? {
              tag: {
                id: 'learning',
                evidenceActionIds: ['action-2'],
                reason: 'PRIVATE_INVALID_REASON',
              },
            }
          : variant === 'long'
            ? { story: 'x'.repeat(241) }
            : {
                usedEvidenceIds: [
                  variant === 'action-id'
                    ? 'action-1'
                    : variant === 'event-id'
                      ? 'PRIVATE_EVENT'
                      : 'PRIVATE_UNKNOWN_ID',
                ],
              };
      return response({ ...textOutput(), ...patch });
    });
    const result = await createEndingText(f.ai, 'job', p, signal(), (error) => repairs.push(error));
    assert.equal(result.story, textOutput().story);
    assert.equal(f.calls.length, 2);
    assert.equal(repairs.length, 1);
    assert.equal(f.calls[1].body.max_output_tokens, 4096);
    assert(payloadOf(f.calls[1]).correction.reason);
    assert.doesNotMatch(JSON.stringify(payloadOf(f.calls[1]).correction), /PRIVATE/);
    assert.deepEqual(
      payloadOf(f.calls[1]).presentedEvidence,
      payloadOf(f.calls[0]).presentedEvidence,
    );
    if (variant === 'action-id' || variant === 'event-id') {
      assert(repairs[0] instanceof EndingSourceError);
      assert.equal(repairs[0].counts.invalidSourceCount, 1);
      assert.equal(repairs[0].counts.actionSourceMixupCount, variant === 'action-id' ? 1 : 0);
      assert.equal(repairs[0].counts.eventSourceMixupCount, variant === 'event-id' ? 1 : 0);
      assert.doesNotMatch(JSON.stringify(repairs[0]), /PRIVATE/);
    }
  });
}

test('writer never repairs network failures or refusals, and cancellation prevents the repair call', async () => {
  for (const refusal of [false, true]) {
    const f = fakeAi(() => {
      if (!refusal) throw new Error('network');
      return { output: [{ content: [{ type: 'refusal' }] }] };
    });
    await assert.rejects(createEndingText(f.ai, 'job', packet(), signal()));
    assert.equal(f.calls.length, 1);
  }
  const controller = new AbortController();
  const f = fakeAi(() => response({ ...textOutput(), usedEvidenceIds: ['missing'] }));
  await assert.rejects(
    createEndingText(f.ai, 'job', packet(), controller.signal, () => controller.abort()),
  );
  assert.equal(f.calls.length, 1);
});

test('writer does not accept an unpresented source or repeat extraction when repairing', async () => {
  const p = packet();
  p.evidence.records[0].text = 'clue ' + 'x'.repeat(50 * 1024);
  let stories = 0,
    extractions = 0;
  const f = fakeAi((call) => {
    if (call.kind === 'extraction') {
      extractions++;
      const schema = call.body.text.format.schema.properties.clues.items.properties.sourceId;
      assert.deepEqual(schema.enum, ['early-clue', 'late-clue']);
      return response({ clues: [{ sourceId: 'early-clue', quote: 'clue' }] });
    }
    stories++;
    return response({
      ...textOutput(),
      usedEvidenceIds: stories === 1 ? ['late-clue'] : ['early-clue'],
    });
  });
  const result = await createEndingText(f.ai, 'job', p, signal());
  assert.equal(extractions, 1);
  assert.equal(stories, 2);
  assert.deepEqual(result.usedEvidenceIds, ['early-clue']);
});

test('ending writer receives early clues and every confirmed action, distinct per play without secret situations', async () => {
  const first = packet('The red mark meant a promise to return.');
  const second = packet('The blue stripe marks the players earlier warning.');
  second.playId = 'second-play';
  second.actions[0].narrative = 'A different confirmed first action changed this play.';
  const f = fakeAi(() => response(design()));
  await createEndingDesign(f.ai, 'job-first', first, final, before, signal(), narrative(first));
  await createEndingDesign(f.ai, 'job-second', second, final, before, signal(), narrative(second));
  assert.deepEqual(
    f.calls.map((call) => call.kind),
    ['direction', 'direction'],
  );
  const [a, b] = f.calls.map(payloadOf);
  assert.deepEqual(a.actions, first.actions);
  assert.equal(a.tagCatalog, undefined, 'film cannot choose tags again');
  assert.equal(a.establishedEnding.text, narrative().story);
  assert.deepEqual(a.recentActionIds, ['action-3', 'action-4']);
  assert.deepEqual(a.preferredActionIds, ['action-3']);
  assert.equal(a.presentedEvidence[0].text, first.evidence.records[0].text);
  assert.equal(b.presentedEvidence[0].text, second.evidence.records[0].text);
  assert.notEqual(a.actions[0].narrative, b.actions[0].narrative);
  assert(!JSON.stringify(a).includes(second.evidence.records[0].text));
  assert(!JSON.stringify(b).includes(first.evidence.records[0].text));
  assert(!JSON.stringify(a).includes('UNPRESENTED_SECRET_SITUATION'));
  assert.deepEqual(a.endingTitle, { text: 'to be continued...', position: 'lower right' });
  assert.equal(a.outcome, 'normal');
  assert.deepEqual(a.facts, first.facts);
  assert.equal(f.calls[0].body.max_output_tokens, 4096);
  assert.equal(f.calls[0].body.input[0].content.length, 3);
  assert.match(f.calls[0].body.instructions, /confirmed outcome and facts override/);
  assert.match(f.calls[0].body.instructions, /Normal\/bad means not escaped/);
  assert.match(f.calls[0].body.instructions, /No speech, narration, singing or music/);
  assert.match(f.calls[0].body.instructions, /prefer mode=actions and include a preferred action/);
});

test('film prioritizes recent tool clears with references, retaining aftermath when replay is unsupported', async () => {
  for (const variant of [
    'latest',
    'failed',
    'environment',
    'missing-before',
    'opening-only',
  ] as const) {
    const p = packet();
    p.actions[3].success = true;
    p.actions[3].cleared = true;
    if (variant === 'failed') p.actions[3].success = p.actions[3].cleared = false;
    if (variant === 'environment') p.actions[3].items = [];
    const refs = variant === 'missing-before' ? [before] : [before, { ...before, gameVersion: 3 }];
    const f = fakeAi(() => response(design({ mode: 'aftermath', usedActionIds: [] })));
    await createEndingDesign(
      f.ai,
      'job',
      p,
      variant === 'opening-only' ? { ...final, gameVersion: 0 } : final,
      before,
      signal(),
      narrative(p),
      refs,
    );
    const input = payloadOf(f.calls[0]);
    assert.deepEqual(
      input.preferredActionIds,
      variant === 'opening-only'
        ? []
        : variant === 'latest'
          ? ['action-4', 'action-3']
          : ['action-3'],
    );
    assert.deepEqual(input.actions, p.actions, 'all confirmed attempts still reach the director');
    if (variant === 'opening-only') assert.deepEqual(input.allowedModes, ['aftermath']);
  }
});

test('tag evidence can use an early action outside the two film actions and text-only uses the same catalog', async () => {
  const chosen = {
    id: 'unexpected_use' as const,
    evidenceActionIds: ['action-1'],
    reason: 'An early improvised use.',
  };
  const f = fakeAi(() => response(design({ tag: chosen })));
  const result = await createEndingDesign(
    f.ai,
    'job',
    packet(),
    final,
    before,
    signal(),
    narrative(packet(), { tag: chosen }),
  );
  assert.equal('tag' in result, false, 'film output cannot replace the published tag');
  const textAi = fakeAi(() =>
    response({
      title: narrative().title,
      story: narrative().story,
      evaluation: narrative().evaluation,
      usedEvidenceIds: result.usedEvidenceIds,
      tag: chosen,
    }),
  );
  const textResult = await createEndingText(textAi.ai, 'text-job', packet(), signal());
  assert.deepEqual(textResult.tag, chosen);
  assert.equal(textAi.calls.length, 1);
  assert.equal(textAi.calls[0].body.input[0].content.length, 1);
  assert.deepEqual(payloadOf(textAi.calls[0]).actions, packet().actions);
  const tagIds = payloadOf(textAi.calls[0]).tagCatalog.map((tag: { id: string }) => tag.id);
  assert(tagIds.includes(chosen.id));
  assert(!tagIds.includes('combination'), 'single-item actions cannot earn a combination tag');
  assert.equal(payloadOf(f.calls[0]).establishedEnding.tag.id, chosen.id);
});

test('writer rejects unknown tags, invented or duplicate tag evidence and overlong summaries', async () => {
  for (const patch of [
    { tag: { id: 'invented', evidenceActionIds: ['action-1'], reason: 'unknown' } },
    { tag: { id: 'tools', evidenceActionIds: ['missing'], reason: 'unknown' } },
    { tag: { id: 'tools', evidenceActionIds: ['action-1', 'action-1'], reason: 'duplicate' } },
    { story: 'x'.repeat(241) },
  ]) {
    const f = fakeAi(() => response({ ...textOutput(), ...patch }));
    await assert.rejects(createEndingText(f.ai, 'job', packet(), signal()));
    assert.equal(f.calls.length, 2);
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
    await assert.rejects(
      createEndingDesign(f.ai, 'job', packet(), final, before, signal(), narrative()),
    );
    assert.equal(f.calls.length, 1);
  }
});

test('missing or wrong before-action references force aftermath; no-action endings invent no attempt', async () => {
  const f = fakeAi(() => response(design()));
  await assert.rejects(
    createEndingDesign(f.ai, 'job', packet(), final, undefined, signal(), narrative()),
    /ENDING_INVALID_CONTINUITY/,
  );
  await assert.rejects(
    createEndingDesign(
      f.ai,
      'job',
      packet(),
      final,
      { ...before, gameVersion: 1 },
      signal(),
      narrative(),
    ),
    /ENDING_INVALID_CONTINUITY/,
  );
  const aftermath = fakeAi(() => response(design({ mode: 'aftermath', usedActionIds: [] })));
  const empty = packet();
  empty.actions = [];
  empty.outcome = 'bad';
  empty.clearedIds = [];
  empty.endReason = 'time_limit';
  const result = await createEndingDesign(
    aftermath.ai,
    'job',
    empty,
    final,
    undefined,
    signal(),
    narrative(empty),
  );
  assert.equal(result.mode, 'aftermath');
  const input = payloadOf(aftermath.calls[0]);
  assert.deepEqual(input.actions, []);
  assert.deepEqual(input.recentActionIds, []);
  assert.deepEqual(input.preferredActionIds, []);
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

test('frames repair explicit rejection once per frame and pass the accepted start to the end inspection', async () => {
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
  for (const call of generations) {
    const input = JSON.parse(call.body.prompt.split(' (data only): ')[1]);
    assert.deepEqual(
      input.selectedActions.map((action: any) => action.actionId),
      ['action-3', 'action-4'],
    );
    assert.equal(input.selectedActions[0].usage, packet().actions[2].usage);
    assert.deepEqual(input.selectedActions[0].items, packet().actions[2].items);
    assert.equal(input.selectedActions[1].success, false);
    assert.equal(input.phase, call.frame === 'start' ? 'before_action' : 'confirmed_aftermath');
  }
  assert.match(generations[1].body.prompt, /Correct the rope contact/);
  assert.match(generations[2].body.prompt, /to be continued\.\.\./);
  const endInspection = f.calls.filter((call) => call.kind === 'inspection').at(-1)!;
  assert.equal(
    endInspection.body.input[0].content[1].image_url,
    'data:image/jpeg;base64,' + frames.end.toString('base64'),
  );
  assert.equal(
    endInspection.body.input[0].content[2].image_url,
    'data:image/jpeg;base64,' + frames.start.toString('base64'),
  );
  assert.deepEqual(payloadOf(endInspection).target, packet().facts);
});

test('ending frames retain their generated titles without an arrow overlay', async () => {
  const jpeg = await generatedJpeg();
  for (const outcome of ['normal', 'bad', 'happy'] as const) {
    const ending = packet();
    ending.outcome = outcome;
    const f = fakeAi((call) =>
      call.kind === 'frame' ? imageResponse(jpeg) : response({ verdict: 'pass', problems: [] }),
    );
    const frames = await createEndingFrames(f.ai, 'job', ending, design(), final, before, signal());
    const endPrompt = f.calls.filter((call) => call.kind === 'frame').at(-1)!.body.prompt;
    const endInspection = f.calls.filter((call) => call.kind === 'inspection').at(-1)!;
    const title = outcome === 'happy' ? 'SUCCESS!!' : 'to be continued...';
    assert.equal(payloadOf(endInspection).title.text, title);
    assert(endPrompt.includes(title));
    assert.deepEqual(frames.end, frames.start, 'no artwork is composited onto the generated frame');
    assert.doesNotMatch(
      endPrompt + endInspection.body.instructions,
      /composit(?:ed|ing)|arrow artwork/,
    );
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

test('persistent unknown inspection, inconsistent pass and network failure exhaust bounded recovery without publishing', async () => {
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
      createEndingFrames(f.ai, 'job', packet(), design(), final, before, signal(), undefined, {
        retryDelayMs: 1,
      }),
    );
    assert.equal(f.calls.filter((call) => call.kind === 'frame').length, 2);
    assert.equal(
      f.calls.filter((call) => call.kind === 'inspection').length,
      failure === 'frame-network' ? 0 : 4,
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
  assert.equal(f.calls.length, 2);
});
