import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, open } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ExpansionBudget,
  EXPANSION_LIMITS,
  MeasuredResponsesClient,
  measuredFetch,
} from '../tools/auto-mission/expansion/budget.js';
import {
  EXPANSION_PRICING,
  extractUsage,
  estimateCost,
  summarizeUsage,
  predictRemainingCost,
} from '../tools/auto-mission/expansion/usage.js';
import {
  ExpansionStore,
  conditionsDigest,
  artifactDigest,
  RUN_BYTES_LIMIT,
} from '../tools/auto-mission/expansion/store.js';
import {
  type EvaluationManifest,
  type PlayCheckpoint,
} from '../tools/auto-mission/expansion/store-schema.js';
import { freezeSource } from '../tools/auto-mission/expansion/source.js';
import type { ExpansionCandidate } from '../tools/auto-mission/expansion/schemas.js';
const body = () => ({
  model: 'gpt-5.6-sol',
  max_output_tokens: 100,
  instructions: 'a private instruction',
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'Japanese 日本語' }] }],
  text: { format: { name: 'core_intent' } },
});
const response = (
  usage: unknown = {
    input_tokens: 100,
    output_tokens: 20,
    input_tokens_details: { cached_tokens: 50 },
    output_tokens_details: { reasoning_tokens: 10 },
  },
) => ({ model: 'gpt-5.6-sol', status: 'completed', usage, output: [] });
const budget = (overrides: Partial<ConstructorParameters<typeof ExpansionBudget>[0]> = {}) =>
  new ExpansionBudget({
    mode: 'live',
    maxCostUsd: 10,
    pricing: EXPANSION_PRICING,
    limits: EXPANSION_LIMITS.pilot,
    ...overrides,
  });
const context = { revision: 1 };
test('usage records cache/reasoning without double charging and unknown totals stay null', () => {
  const usage = extractUsage(response());
  assert.deepEqual(usage, {
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 50,
    reasoningTokens: 10,
  });
  assert.equal(estimateCost(EXPANSION_PRICING, 'gpt-5.6-sol', usage), 0.00067);
  assert.deepEqual(extractUsage(null), {
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    reasoningTokens: null,
  });
  assert.equal(estimateCost(EXPANSION_PRICING, 'unknown', usage), null);
});
test('live cost authorization, known pricing and bounded text request are checked before transport', async () => {
  assert.throws(() => budget({ maxCostUsd: undefined }), /EXPLICIT_COST/);
  let calls = 0;
  for (const mutate of [
    (r: any) => (r.model = 'unknown'),
    (r: any) => (r.max_output_tokens = undefined),
    (r: any) => (r.previous_response_id = 'hidden'),
    (r: any) => (r.tools = []),
    (r: any) => (r.service_tier = 'priority'),
    (r: any) => (r.input = [{ type: 'input_image' }]),
    (r: any) => (r.instructions = 'あ'.repeat(65536)),
  ]) {
    const request = body();
    mutate(request);
    await assert.rejects(() =>
      budget().measure(request, context, async () => {
        calls++;
        return response();
      }),
    );
  }
  assert.equal(calls, 0);
  await assert.rejects(
    () =>
      budget({ maxCostUsd: 0.00001 }).measure(body(), context, async () => {
        calls++;
        return response();
      }),
    /COST_LIMIT/,
  );
  assert.equal(calls, 0);
});
test('synchronous reservations stop concurrent calls and preserve unknown usage reservations', async () => {
  const b = budget({ limits: { ...EXPANSION_LIMITS.pilot, maxOutputTokens: 100 } });
  let release!: (value: unknown) => void;
  const first = b.measure(
    body(),
    context,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => b.measure(body(), context, async () => response()), /CALL_OR_TOKEN/);
  const reserved = b.snapshot().chargedCostUsd;
  release(response(undefined));
  await first;
  // Explicit missing usage, as opposed to the helper's default value.
  const b2 = budget();
  await b2.measure(body(), context, async () => ({ model: 'gpt-5.6-sol', status: 'completed' }));
  assert.equal(b2.snapshot().chargedCostUsd, b2.calls[0]!.reservedCostUsd);
  assert.equal(b2.calls[0]!.estimatedCostUsd, null);
  assert.equal(b2.snapshot().unknownUsageCalls, 1);
  assert.ok(reserved > 0);
});
test('measured game client persists reservation before transport and contains no prompt/header plaintext', async () => {
  const b = budget(),
    seen: string[] = [];
  const client = new MeasuredResponsesClient(
    {
      respond: async (request: any) => {
        seen.push('transport');
        assert.equal(request.service_tier, 'default');
        return response();
      },
    },
    b,
    () => ({ revision: 1, playId: 'pilot-sol' }),
    async (record) => {
      seen.push(record.status);
    },
  );
  await client.respond(body());
  assert.deepEqual(seen, ['running', 'transport', 'completed']);
  assert.equal(b.calls[0]!.role, 'core_intent');
  const serialized = JSON.stringify(b.calls);
  assert.equal(serialized.includes('private instruction'), false);
  assert.equal(serialized.includes('Japanese'), false);
  assert.ok(b.calls[0]!.reservedInputTokens >= Buffer.byteLength(JSON.stringify(body())));
});
test('returned model aliases require explicit verified configuration; mismatches block later spend', async () => {
  const b = budget();
  await assert.rejects(
    () =>
      b.measure(body(), context, async () => ({ ...response(), model: 'gpt-5.6-sol-2026-09-01' })),
    /MODEL_MISMATCH/,
  );
  await assert.rejects(() => b.measure(body(), context, async () => response()), /BUDGET_BLOCKED/);
  const pricing = structuredClone(EXPANSION_PRICING);
  pricing.responseAliases['gpt-5.6-sol-verified-fixture'] = 'gpt-5.6-sol';
  const allowed = budget({ mode: 'mock', pricing });
  await allowed.measure(body(), context, async () => ({
    ...response(),
    model: 'gpt-5.6-sol-verified-fixture',
  }));
  assert.equal(allowed.calls[0]!.modelReturned, 'gpt-5.6-sol-verified-fixture');
});
test('scope clocks, timeouts, upstream overuse and storage failure stop spend without fake zero usage', async () => {
  let now = 0;
  const b = budget({ now: () => now });
  b.addScope('play', { ...EXPANSION_LIMITS.play, deadlineMs: 10 });
  now = 11;
  assert.throws(() => b.reserve(body(), { revision: 1, scopeId: 'play' }), /DEADLINE/);
  const timed = budget({ limits: { ...EXPANSION_LIMITS.pilot, requestTimeoutMs: 15 } });
  await assert.rejects(
    () => timed.measure(body(), context, () => new Promise(() => {})),
    /TIMEOUT/,
  );
  assert.equal(timed.calls[0]!.status, 'incomplete');
  assert.equal(timed.calls[0]!.estimatedCostUsd, null);
  const over = budget();
  await assert.rejects(
    () =>
      over.measure(body(), context, async () =>
        response({ input_tokens: 100, output_tokens: 101 }),
      ),
    /USAGE_EXCEEDED/,
  );
  const fail = budget();
  let invoked = false;
  await assert.rejects(
    () =>
      fail.measure(
        body(),
        context,
        async () => {
          invoked = true;
          return response();
        },
        undefined,
        async () => {
          throw new Error('secret credential');
        },
      ),
    /CHECKPOINT/,
  );
  assert.equal(invoked, false);
  assert.equal(JSON.stringify(fail.calls).includes('secret credential'), false);
});
test('fetch injection measures original provider-shaped requests without exposing authorization', async () => {
  const b = budget();
  const transport = measuredFetch(
    async () => new Response(JSON.stringify(response())),
    b,
    () => ({ revision: 1, role: 'generator' }),
  );
  await transport('https://api.openai.com/v1/responses', {
    method: 'POST',
    body: JSON.stringify(body()),
    headers: { Authorization: 'secret' },
  });
  assert.equal(b.calls[0]!.role, 'generator');
  assert.equal(JSON.stringify(b.calls).includes('secret'), false);
});
const source = freezeSource(readFileSync('scenarios/story-catalog.json', 'utf8'));
const loc = { ja: '概要', en: 'Overview' };
const candidate: ExpansionCandidate = {
  schemaVersion: 1,
  candidateId: 'warehouse-expanded',
  revision: 1,
  parentDigest: null,
  sourceDigest: source.sourceDigest,
  originalInvariantDigest: source.originalInvariantDigest,
  openingOverview: loc,
  expandedStory: [{ id: 'opening', title: loc, body: loc }],
  knowledgeAdditions: [],
  observationTargets: [],
  knowledgeMetadata: [],
  displayOverrides: [],
  ambienceSlots: [],
  publicVisuals: [],
  changeMap: [],
};
function manifest(): EvaluationManifest {
  return {
    schemaVersion: 1,
    kind: 'mission-expansion',
    runId: randomUUID(),
    mode: 'mock',
    parentRunId: null,
    conditions: {
      sourceDigest: source.sourceDigest,
      candidateDigest: artifactDigest(candidate),
      revision: 1,
      codeRevision: 'test-code',
      dirtyDigest: 'a'.repeat(64),
      configDigest: 'b'.repeat(64),
      promptDigests: { game: 'c'.repeat(64) },
      catalogDigest: 'd'.repeat(64),
      locale: 'ja',
      rules: source.compiledOriginal.rules,
      initiative: 'observations',
      selectedModels: { player: 'gpt-5.6-sol' },
    },
    pricingSnapshot: EXPANSION_PRICING,
    stage: 'pilot_running',
    budgets: { maxCostUsd: null, maxCalls: 650, maxOutputTokens: 350000, deadlineMs: 4500000 },
    playMatrix: [{ playId: 'pilot-sol', model: 'gpt-5.6-sol', persona: 'investigator' }],
    plays: [],
    callIds: [],
  };
}
function play(m: EvaluationManifest): PlayCheckpoint {
  return {
    playId: 'pilot-sol',
    attemptId: randomUUID(),
    candidateDigest: m.conditions.candidateDigest,
    revision: 1,
    conditionsDigest: conditionsDigest(m.conditions),
    model: 'gpt-5.6-sol',
    persona: 'investigator',
    status: 'running',
    terminationReason: null,
    turns: [],
    disclosureTrace: [],
    ambienceTrace: [],
    stateVersions: [],
    callIds: [],
  };
}
async function withStore(work: (s: ExpansionStore, m: EvaluationManifest) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'expansion-store-test-'));
  try {
    const m = manifest();
    await work(await ExpansionStore.create(root, m, source, candidate), m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test('resume freezes all conditions and recovers running calls/plays as incomplete with reservations intact', async () =>
  withStore(async (s, m) => {
    const b = budget({ mode: 'mock' });
    const call = b.reserve(body(), { revision: 1, playId: 'pilot-sol' });
    await s.saveCall(call);
    const p = play(m);
    p.turns = [{ request: 'inspect' }];
    p.callIds = [call.callId];
    await s.checkpointPlay(p);
    for (const field of [
      'candidateDigest',
      'dirtyDigest',
      'configDigest',
      'catalogDigest',
    ] as const) {
      const changed = structuredClone(m.conditions);
      changed[field] = 'f'.repeat(64);
      await assert.rejects(
        () => ExpansionStore.resume(join(s.directory, 'manifest.json'), changed),
        /conditions mismatch/,
      );
    }
    const resumed = await ExpansionStore.resume(join(s.directory, 'manifest.json'), m.conditions);
    assert.equal(resumed.snapshot.stage, 'incomplete');
    const saved = (await resumed.readCalls())[0]!;
    assert.equal(saved.status, 'incomplete');
    assert.equal(saved.reservedCostUsd, call.reservedCostUsd);
    assert.equal(saved.estimatedCostUsd, null);
    assert.equal((await resumed.reusablePlays()).length, 0);
    const retry = play(m);
    await resumed.checkpointPlay(retry);
    assert.equal((await resumed.readPlays()).length, 2);
  }));
test('completed plays are reusable and immutable; retries never overwrite old attempts', async () =>
  withStore(async (s, m) => {
    const p = play(m);
    await s.checkpointPlay(p);
    p.turns = [{ index: 1 }];
    p.status = 'cleared';
    p.terminationReason = 'escaped';
    await s.checkpointPlay(p);
    const resumed = await ExpansionStore.resume(join(s.directory, 'manifest.json'), m.conditions);
    assert.equal((await resumed.reusablePlays()).length, 1);
    await assert.rejects(
      () => resumed.checkpointPlay({ ...p, status: 'running', terminationReason: null }),
      /immutable/,
    );
    await assert.rejects(() => resumed.checkpointPlay({ ...p, attemptId: randomUUID() }), /Retry/);
    await resumed.setStage('pilot_reported');
    await assert.rejects(() => s.setStage('pilot_reported'), /Stale/);
  }));
test('play 16 MiB and run 128 MiB limits reject before changing the manifest', async () =>
  withStore(async (s, m) => {
    const before = await readFile(join(s.directory, 'manifest.json'), 'utf8');
    const p = play(m);
    p.turns = [{ text: 'a'.repeat(16 * 1024 * 1024) }];
    await assert.rejects(() => s.checkpointPlay(p), /size limit/);
    assert.equal(await readFile(join(s.directory, 'manifest.json'), 'utf8'), before);
    const sparse = await open(join(s.directory, 'quota-fixture'), 'wx');
    await sparse.truncate(RUN_BYTES_LIMIT);
    await sparse.close();
    await assert.rejects(() => s.setStage('pilot_reported'), /128 MiB/);
    assert.equal(await readFile(join(s.directory, 'manifest.json'), 'utf8'), before);
  }));
test('invalid JSON, corrupted snapshot digests and active locks never become successful resumes', async () =>
  withStore(async (s, m) => {
    const p = play(m);
    await s.checkpointPlay(p);
    const ref = s.snapshot.plays[0]!;
    await writeFile(join(s.directory, 'plays', ref.snapshotId + '.json'), '{');
    await assert.rejects(() =>
      ExpansionStore.resume(join(s.directory, 'manifest.json'), m.conditions),
    );
    await writeFile(join(s.directory, '.writer.lock'), JSON.stringify({ pid: process.pid }));
    await assert.rejects(
      () => ExpansionStore.resume(join(s.directory, 'manifest.json'), m.conditions),
      /active/,
    );
  }));

test('settlement is idempotent and explicit aliases remain absent from production pricing', () => {
  const b = budget();
  const record = b.reserve(body(), context);
  b.settle(record, response(), context);
  const charged = b.snapshot().chargedCostUsd;
  b.settle(record, response(), context);
  assert.equal(b.snapshot().chargedCostUsd, charged);
  assert.deepEqual(EXPANSION_PRICING.responseAliases, {});
});

test('cost reports separate unknown reservations and remaining forecasts require completed known pilot calls', async () => {
  const known = budget();
  await known.measure(body(), context, async () => response());
  const unknown = budget();
  await unknown.measure(body(), context, async () => ({
    model: 'gpt-5.6-sol',
    status: 'completed',
  }));
  const summary = summarizeUsage([...known.calls, ...unknown.calls]);
  assert.equal(summary.unknownCostCalls, 1);
  assert.equal(summary.retainedUnknownCostUsd, unknown.calls[0]!.reservedCostUsd);
  const prediction = predictRemainingCost(
    [{ model: 'sol', status: 'cleared', calls: known.calls }],
    ['sol', 'sol'],
  );
  assert.equal(prediction?.estimatedUsd, known.calls[0]!.estimatedCostUsd! * 2);
  assert.equal(prediction?.guaranteed, false);
  assert.equal(
    predictRemainingCost([{ model: 'sol', status: 'cleared', calls: unknown.calls }], ['sol']),
    null,
  );
  assert.equal(
    predictRemainingCost([{ model: 'sol', status: 'incomplete', calls: known.calls }], ['sol']),
    null,
  );
});
test('read-only report loading never converts running records and HTML is stored as HTML', async () =>
  withStore(async (store, m) => {
    await store.checkpointPlay(play(m));
    await store.saveEvaluation({ status: 'incomplete' });
    await store.saveReport('<!doctype html><title>Report</title>');
    const before = await readFile(join(store.directory, 'manifest.json'), 'utf8');
    const loaded = await ExpansionStore.readOnly(join(store.directory, 'manifest.json'));
    assert.equal(loaded.plays[0]!.status, 'running');
    assert.deepEqual(loaded.evaluation, { status: 'incomplete' });
    assert.equal(await readFile(join(store.directory, 'manifest.json'), 'utf8'), before);
    assert.equal(
      (await readFile(join(store.directory, 'report.html'), 'utf8')).startsWith('<!doctype'),
      true,
    );
  }));
