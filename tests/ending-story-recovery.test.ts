import assert from 'node:assert/strict';
import test from 'node:test';
import { createEndingText } from '../apps/local-server/ending-ai.js';
import type { EndingPacket } from '../apps/local-server/ending.js';
import { ScenarioCatalog } from '../apps/server/scenario-catalog.js';
import { AiService } from '../packages/server/ai-service.js';
import { loadAiConfig } from '../packages/server/ai-config.js';
import { localizeScenario } from '../packages/shared/scenario.js';
import { UpstreamError } from '../packages/server/openai.js';
import { endingSourceCounts, endingFailureCode } from '../apps/server/ending-failure.js';
import { boundedEndingEvidence } from '../apps/local-server/ending-evidence.js';

const response = (value: unknown) => ({
  output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
});
const story = {
  title: '閉じた扉',
  story: 'ひもで引いてみたけれど、扉は閉じたまま。工夫の続きは次の通話へ。',
  evaluation: '試みたが解除には至らなかった。',
  tag: null,
  usedEvidenceIds: [],
};

function packet(): EndingPacket {
  const snapshot = new ScenarioCatalog({
    scenarioPath: 'scenarios/mobile-playtest.json',
    coreConfigPath: 'config/game-core.json',
  }).current('ja');
  return {
    playId: 'recovery-play',
    snapshot,
    scenario: localizeScenario(snapshot.scenarioV2, 'ja'),
    locale: 'ja',
    outcome: 'bad',
    endReason: 'time_limit',
    clearedIds: [],
    remainingObstacles: [{ id: 'door', title: '閉じた扉', situation: 'UNPRESENTED_SECRET' }],
    facts: { obstacleId: 'door', values: { door: 'closed' } },
    inventory: [],
    endedAt: 0,
    gameVersion: 1,
    finalMessageId: null,
    recentActionScenes: [],
    actions: [
      {
        actionId: 'attempt',
        order: 1,
        obstacleId: 'door',
        usage: 'ひもで引く',
        items: [{ id: 'rope', name: 'ひも', beforeStatus: 'available', afterStatus: 'available' }],
        beforeVersion: 0,
        afterVersion: 1,
        beforeFacts: { obstacleId: 'door', values: { door: 'closed' } },
        afterFacts: { obstacleId: 'door', values: { door: 'closed' } },
        success: false,
        cleared: false,
        narrative: '引いたが扉は開かなかった。',
      },
    ],
    evidence: {
      records: Array.from({ length: 80 }, (_, i) => ({
        sourceId: `clue-${i}`,
        kind: i === 0 ? ('briefing' as const) : ('assistant_transcript' as const),
        order: i,
        generation: 1,
        gameVersion: 0,
        text: `既知の観察${i}。` + '扉は閉じたままです。'.repeat(40),
      })),
      truncated: false,
    },
  };
}

function setup(run: (name: string, input: any, body: any, signal?: AbortSignal) => unknown) {
  const calls: { name: string; input: any; body: any }[] = [];
  const ai = new AiService(
    loadAiConfig({ AI_MODE: 'mock' }),
    {
      async createLiveSession() {
        throw new Error('Unexpected live request');
      },
      async hangup() {},
      async createResponse(body, signal) {
        const b = body as any;
        const name = b.text.format.name;
        const input = JSON.parse(b.input[0].content[0].text);
        calls.push({ name, input, body: b });
        return run(name, input, b, signal);
      },
    },
    () => 0,
  );
  ai.register('recovery-play', 100_000);
  ai.registerEnding('recovery-play', 'ending-job', 100_000);
  return { ai, calls };
}

for (const variant of ['quote', 'source', 'incomplete', 'shape', 'json'] as const) {
  test(`ending text survives ${variant} extraction failure using only server evidence`, async () => {
    const p = packet();
    const f = setup((name) => {
      if (name === 'ending_text') return response(story);
      if (variant === 'incomplete') return { status: 'incomplete', output: [] };
      if (variant === 'shape') return response({ clues: 'PRIVATE_INVALID' });
      if (variant === 'json')
        return { output: [{ content: [{ type: 'output_text', text: '{' }] }] };
      return response({
        clues: [
          {
            sourceId: variant === 'source' ? 'PRIVATE_UNKNOWN_SOURCE' : 'clue-0',
            quote: 'PRIVATE_INVENTED_QUOTE',
          },
        ],
      });
    });
    const recovered = await createEndingText(f.ai, 'ending-job', p, new AbortController().signal);
    assert.equal(recovered.story, story.story);
    assert.equal(f.calls.filter((call) => call.name === 'ending_clues').length, 1);
    const input = f.calls.at(-1)!.input;
    assert.equal(input.evidenceIncomplete, true);
    assert.equal(input.outcome, 'bad');
    assert.equal(input.actions[0].success, false);
    assert.equal(input.actions.length, 1);
    assert.doesNotMatch(JSON.stringify(input), /PRIVATE_|UNPRESENTED_SECRET/);
    assert(recovered.presentedEvidence.length > 0);
    for (const record of recovered.presentedEvidence)
      assert(
        p.evidence.records.some(
          (original) =>
            original.sourceId === record.sourceId &&
            original.text === ('text' in record ? record.text : record.quote),
        ),
      );
  });
}

test('extraction deadline leaves writer capacity and records a safe recovery diagnostic', async () => {
  const p = packet();
  let aborted = false;
  const f = setup((name, _input, _body, signal) => {
    if (name === 'ending_text') {
      assert(aborted, 'extraction settles before writer reuses the permit');
      return response(story);
    }
    return new Promise((_resolve, reject) => {
      signal!.addEventListener(
        'abort',
        () => {
          aborted = true;
          reject(signal!.reason);
        },
        { once: true },
      );
    });
  });
  const diagnostics: string[] = [];
  const result = await createEndingText(
    f.ai,
    'ending-job',
    p,
    new AbortController().signal,
    undefined,
    {
      evidenceTimeoutMs: 15,
      onEvidenceFallback: (error) => diagnostics.push(endingFailureCode(error, 'extraction')),
    },
  );
  assert.equal(result.story, story.story);
  assert.deepEqual(diagnostics, ['ENDING_EXTRACTION_TIMEOUT']);
  assert.deepEqual(
    f.calls.map((call) => call.name),
    ['ending_clues', 'ending_text'],
  );
  assert.equal(f.ai.snapshot().responseBusy, 0);
});

test('malformed extraction diagnostics distinguish invalid sources from mismatched quotes without logging data', async () => {
  const f = setup((name) =>
    name === 'ending_text'
      ? response(story)
      : response({
          clues: [
            { sourceId: 'clue-0', quote: 'PRIVATE_QUOTE' },
            { sourceId: 'PRIVATE_ID', quote: 'PRIVATE_QUOTE' },
          ],
        }),
  );
  const diagnostics: unknown[] = [];
  await createEndingText(f.ai, 'ending-job', packet(), new AbortController().signal, undefined, {
    onEvidenceFallback: (error) => diagnostics.push(endingSourceCounts(error)),
  });
  assert.deepEqual(diagnostics, [{ invalidSourceCount: 1, quoteMismatchCount: 1 }]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE/);
});

for (const variant of ['cancel', 'auth', 'network', 'refusal', 'budget'] as const)
  test(`extraction ${variant} does not cause an unauthorized extra writer call`, async () => {
    const controller = new AbortController();
    const f = setup(() => {
      if (variant === 'cancel') {
        controller.abort();
        throw new Error('cancelled');
      }
      if (variant === 'auth') throw new UpstreamError(502, 401);
      if (variant === 'refusal') return { output: [{ content: [{ type: 'refusal' }] }] };
      throw new Error('PRIVATE_NETWORK_FAILURE');
    });
    if (variant === 'budget') f.ai.config.globalResponseAttempts = 0;
    await assert.rejects(createEndingText(f.ai, 'ending-job', packet(), controller.signal));
    assert.equal(f.calls.filter((call) => call.name === 'ending_text').length, 0);
    assert.equal(f.calls.length, variant === 'budget' ? 0 : 1);
    assert.equal(f.ai.snapshot().responseBusy, 0);
  });

test('eligible tags and null-only repair prevent repeating an impossible one-action tag', async () => {
  const p = packet();
  p.evidence.records = [];
  const f = setup((_name, input, body) => {
    if (input.correction) {
      assert.equal(body.text.format.schema.properties.tag.type, 'null');
      assert.deepEqual(input.tagCatalog, []);
      assert.match(input.correction.instruction, /rewrite the whole story/);
      assert.doesNotMatch(JSON.stringify(input), /PRIVATE_REJECTED/);
      return response(story);
    }
    const ids = input.tagCatalog.map((tag: { id: string }) => tag.id);
    assert(!ids.includes('one_tool'));
    assert(!ids.includes('learning'));
    assert(!ids.includes('persistent_retry'));
    assert(!ids.includes('combination'));
    assert(ids.includes('brute_force'));
    return response({
      ...story,
      story: 'PRIVATE_REJECTED_STORY',
      tag: { id: 'one_tool', evidenceActionIds: ['attempt'], reason: 'PRIVATE_REJECTED_REASON' },
    });
  });
  const result = await createEndingText(f.ai, 'ending-job', p, new AbortController().signal);
  assert.equal(result.tag, null);
  assert.equal(result.story, story.story);
  assert.equal(f.calls.length, 2);
});

test('many extracted Japanese quotations stay within the real writer request byte limit', async () => {
  const p = packet();
  for (const record of p.evidence.records) record.text = '引用。'.repeat(333);
  let extractedBytes = 0;
  const f = setup((name, input) => {
    if (name === 'ending_text') {
      assert.equal(input.evidenceIncomplete, true);
      assert(Buffer.byteLength(JSON.stringify(input)) < 128 * 1024);
      return response(story);
    }
    const clues = input
      .slice(0, 24)
      .map((r: { sourceId: string; text: string }) => ({ sourceId: r.sourceId, quote: r.text }));
    extractedBytes += Buffer.byteLength(JSON.stringify(clues));
    return response({ clues });
  });
  const result = await createEndingText(f.ai, 'ending-job', p, new AbortController().signal);
  assert(extractedBytes > 128 * 1024, 'previous aggregate overflow is reproduced');
  assert.equal(result.story, story.story);
  assert(Buffer.byteLength(JSON.stringify(result.presentedEvidence)) <= 48 * 1024);
});

test('repeated fact snapshots are compacted without dropping early actions or real changes', async () => {
  const p = packet();
  p.evidence.records = p.evidence.records.slice(0, 2);
  const unchanged = Object.fromEntries(
    Array.from({ length: 30 }, (_, i) => [`fact${i}`, 'unchanged'.repeat(100)]),
  );
  p.actions = Array.from({ length: 40 }, (_, i) => ({
    ...p.actions[0],
    actionId: `a${i}`,
    order: i,
    beforeFacts: { obstacleId: 'door', values: { ...unchanged, progress: String(i) } },
    afterFacts: { obstacleId: 'door', values: { ...unchanged, progress: String(i + 1) } },
  }));
  const f = setup((_name, input) => {
    assert.equal(input.actionFactsAreChanges, true);
    assert.equal(input.actions.length, 40);
    assert.deepEqual(input.facts, p.facts);
    assert.deepEqual(input.actions[0].beforeFacts.values, { progress: '0' });
    assert.deepEqual(input.actions.at(-1).afterFacts.values, { progress: '40' });
    assert.deepEqual(input.actions[0].items, p.actions[0].items);
    return response(story);
  });
  const result = await createEndingText(f.ai, 'ending-job', p, new AbortController().signal);
  assert.equal(result.story, story.story);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(
    p.actions[0].beforeFacts.values,
    { ...unchanged, progress: '0' },
    'packet stays immutable',
  );
});

test('bounded evidence preserves whole early and late records, never cuts off a negation', () => {
  const records = Array.from({ length: 20 }, (_, i) => ({
    sourceId: String(i),
    kind: 'assistant_transcript',
    text: `観察${i}。` + '赤い印がある。'.repeat(20) + '脱出できたわけではない。',
  }));
  const retained = boundedEndingEvidence(records, 2000);
  assert(retained.length < records.length);
  assert(retained.includes(records[0]));
  assert(retained.includes(records.at(-1)!));
  assert(retained.every((record) => record.text.endsWith('脱出できたわけではない。')));
  assert(Buffer.byteLength(JSON.stringify(retained)) <= 2000);
});

test('a single oversized evidence record cannot prevent writing from the remaining facts', async () => {
  const p = packet();
  p.evidence.records[0].text = '長い観察。'.repeat(25_000);
  const f = setup((name) => {
    assert.equal(name, 'ending_text');
    return response(story);
  });
  const result = await createEndingText(f.ai, 'ending-job', p, new AbortController().signal);
  assert.equal(result.story, story.story);
  assert.equal(f.calls[0].input.evidenceIncomplete, true);
});
