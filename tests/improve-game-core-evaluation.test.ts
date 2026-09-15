import {
  decodeEvaluationInput,
  encodeEvaluationInput,
} from '../tools/auto-mission/expansion/evaluation-input.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadExpansionConfig } from '../tools/auto-mission/expansion/config.js';
import {
  candidateFromProposal,
  mockExpansionProposal,
} from '../tools/auto-mission/expansion/generator.js';
import {
  evaluateCandidate,
  loadEvaluationPrompts,
  validateEvaluationForAdoption,
} from '../tools/auto-mission/expansion/evaluate.js';
import { validateEvidence } from '../tools/auto-mission/expansion/verify.js';
import { artifactDigest, conditionsDigest } from '../tools/auto-mission/expansion/store.js';
import { sha256 } from '../tools/auto-mission/expansion/source.js';
import { ExpansionBudget, EXPANSION_LIMITS } from '../tools/auto-mission/expansion/budget.js';
import { EXPANSION_PRICING } from '../tools/auto-mission/expansion/usage.js';
import type {
  EvaluationConditions,
  PlayCheckpoint,
} from '../tools/auto-mission/expansion/store-schema.js';
const input = await loadExpansionConfig('config/auto-mission/expand-default.json');
const candidate = candidateFromProposal(input.source, mockExpansionProposal(input.source));
const prompts = loadEvaluationPrompts();
const conditions: EvaluationConditions = {
  sourceDigest: input.source.sourceDigest,
  candidateDigest: artifactDigest(candidate),
  revision: 1,
  codeRevision: 'test',
  dirtyDigest: 'f'.repeat(64),
  configDigest: input.configDigest,
  promptDigests: Object.fromEntries(
    Object.entries(prompts).map(([name, p]) => ['evaluation/' + name, sha256(p)]),
  ),
  catalogDigest: input.catalogDigest,
  locale: 'ja',
  rules: input.source.compiledOriginal.rules,
  initiative: 'observations',
  selectedModels: {},
};
const ref = {
  kind: 'pointer' as const,
  document: 'candidate' as const,
  pointer: '/openingOverview',
};
const score = {
  score: 1,
  rationale: 'low but not a repair criterion',
  evidence: [ref],
  suggestions: [],
};
const review = {
  feasibilityFindings: [],
  feasibilityEvidence: [ref],
  funScores: {
    investigationDesire: score,
    inferenceFromInformation: score,
    satisfyingDiscovery: score,
    conversationValue: score,
  },
};
function budget() {
  return new ExpansionBudget({
    mode: 'mock',
    pricing: EXPANSION_PRICING,
    limits: { ...EXPANSION_LIMITS.pilot, maxInputBytes: 65536 },
  });
}
function play(status: 'cleared' | 'uncleared' = 'cleared'): PlayCheckpoint {
  return {
    playId: 'test-play',
    attemptId: randomUUID(),
    candidateDigest: artifactDigest(candidate),
    revision: 1,
    conditionsDigest: conditionsDigest(conditions),
    model: 'gpt-5.6-sol',
    persona: 'investigation',
    status,
    terminationReason: status,
    turns: [{ index: 1, playerRequest: 'inspect', publicReply: 'visible detail' }],
    disclosureTrace: [],
    ambienceTrace: [],
    stateVersions: [],
    callIds: [],
  };
}
function client(handler: (body: any) => unknown) {
  return {
    respond: async (body: unknown) => ({
      model: (body as any).model,
      status: 'completed',
      usage: { input_tokens: 1, output_tokens: 1 },
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify(handler(body)) }],
        },
      ],
    }),
  };
}
test('three independent roles get identical bounded input; scores never gate adoption', async () => {
  const calls: any[] = [];
  const plays = [play()];
  const result = await evaluateCandidate({
    source: input.source,
    candidate,
    conditions,
    plays,
    prompts,
    budget: budget(),
    client: client((body) => {
      calls.push(body);
      return body.model === 'gpt-6-astra' ? { findings: [] } : review;
    }),
  });
  assert.equal(result.status, 'complete', result.failure ?? '');
  assert.equal(calls.length, 4);
  const offered: { document: 'source' | 'candidate'; pointer: string }[] = [];
  const inspect = (value: any) => {
    if (!value || typeof value !== 'object') return;
    if (value.properties?.kind?.const === 'pointer') {
      assert.ok(Array.isArray(value.properties.pointer.enum));
      for (const pointer of value.properties.pointer.enum)
        offered.push({ document: value.properties.document.const, pointer });
    }
    Object.values(value).forEach(inspect);
  };
  inspect(calls[0].text.format.schema);
  assert.ok(offered.length > 0);
  assert.ok(!offered.some((ref) => ref.pointer.startsWith('/compiledOriginal/originalSections')));
  for (const ref of offered)
    validateEvidence([{ kind: 'pointer', ...ref }], { source: input.source, candidate, plays });
  assert.equal(new Set(calls.slice(0, 3).map((c) => c.input[0].content[0].text)).size, 1);
  assert.ok(calls.every((c) => Buffer.byteLength(JSON.stringify(c)) <= 65536));
  assert.equal(
    validateEvaluationForAdoption(result, {
      source: input.source,
      candidate,
      candidateDigest: artifactDigest(candidate),
      conditionsDigest: conditionsDigest(conditions),
      plays,
      expectedPlayIds: ['test-play'],
    }).status,
    'complete',
  );
});
test('invalid pointer or turn reference is rejected, even with valid JSON shape', () => {
  for (const refs of [
    [{ ...ref, pointer: '/absent' }],
    [{ kind: 'turn' as const, playId: 'test-play', turnId: '999' }],
  ])
    assert.throws(() =>
      validateEvidence(refs, { source: input.source, candidate, plays: [play()] }),
    );
});
test('missing model, API failure and unsupported scores remain incomplete', async () => {
  for (const bad of ['api', 'score', 'pointer']) {
    const result = await evaluateCandidate({
      source: input.source,
      candidate,
      conditions,
      plays: [play()],
      prompts,
      budget: budget(),
      client: client(() => {
        if (bad === 'api') throw new Error('offline');
        const r = structuredClone(review);
        if (bad === 'score') r.funScores.conversationValue.evidence = [];
        else r.feasibilityEvidence = [{ ...ref, pointer: '/missing' }];
        return r;
      }),
    });
    assert.equal(result.status, 'incomplete');
    assert.throws(() =>
      validateEvaluationForAdoption(result, {
        source: input.source,
        candidate,
        candidateDigest: artifactDigest(candidate),
        conditionsDigest: conditionsDigest(conditions),
        plays: [play()],
        expectedPlayIds: ['test-play'],
      }),
    );
  }
});
test('failed players require Astra verification and player miss permits low-score result', async () => {
  const plays = [play('uncleared')];
  const result = await evaluateCandidate({
    source: input.source,
    candidate,
    conditions,
    plays,
    prompts,
    budget: budget(),
    client: client((body) =>
      body.model === 'gpt-6-astra'
        ? {
            findings: [
              {
                findingId: 'failed-test-play',
                classification: 'player_miss',
                reason: 'Player missed a reachable clue',
                evidence: [ref],
                counterEvidence: [{ kind: 'turn', playId: 'test-play', turnId: '1' }],
                counterEvidenceReason: 'Failed action does not demonstrate a configuration defect',
              },
            ],
          }
        : review,
    ),
  });
  assert.equal(result.status, 'complete', result.failure ?? '');
  assert.equal(result.verifiedFindings[0]?.repairable, false);
  assert.doesNotThrow(() =>
    validateEvaluationForAdoption(result, {
      source: input.source,
      candidate,
      candidateDigest: artifactDigest(candidate),
      conditionsDigest: conditionsDigest(conditions),
      plays,
      expectedPlayIds: ['test-play'],
    }),
  );
  for (const classification of [
    'harness_defect',
    'inconclusive',
    'confirmed_scenario_defect',
  ] as const) {
    const modified = structuredClone(result);
    modified.verifiedFindings[0]!.classification = classification;
    assert.throws(() =>
      validateEvaluationForAdoption(modified, {
        source: input.source,
        candidate,
        candidateDigest: artifactDigest(candidate),
        conditionsDigest: conditionsDigest(conditions),
        plays,
        expectedPlayIds: ['test-play'],
      }),
    );
  }
});

test('deterministic segments cover every turn for every reviewer; own synthesis contains no peers', async () => {
  const p = play();
  p.turns = Array.from({ length: 12 }, (_, i) => ({
    index: i + 1,
    playerRequest: 'inspect ' + i,
    publicReply: String(i) + 'x'.repeat(4000),
  }));
  const calls: any[] = [];
  const result = await evaluateCandidate({
    source: input.source,
    candidate,
    conditions,
    plays: [p],
    prompts,
    budget: budget(),
    client: client((body) => {
      calls.push(body);
      return body.model === 'gpt-6-astra' ? { findings: [] } : review;
    }),
  });
  assert.equal(result.status, 'complete', result.failure ?? '');
  assert.ok(result.reviews.every((r) => r.segments.length > 1));
  assert.ok(calls.every((c) => Buffer.byteLength(JSON.stringify(c)) <= 65536));
  assert.doesNotThrow(() =>
    validateEvaluationForAdoption(result, {
      source: input.source,
      candidate,
      candidateDigest: artifactDigest(candidate),
      conditionsDigest: conditionsDigest(conditions),
      plays: [p],
      expectedPlayIds: [p.playId],
    }),
  );
  for (const role of result.reviews) {
    assert.equal(role.segments.flatMap((s) => s.turnRefs).length, 12);
    assert.deepEqual(
      role.segments.map((s) => s.inputDigest),
      result.reviews[0]!.segments.map((s) => s.inputDigest),
    );
  }
  const missing = structuredClone(result);
  missing.reviews[0]!.segments[0]!.turnRefs.pop();
  assert.throws(
    () =>
      validateEvaluationForAdoption(missing, {
        source: input.source,
        candidate,
        candidateDigest: artifactDigest(candidate),
        conditionsDigest: conditionsDigest(conditions),
        plays: [p],
        expectedPlayIds: [p.playId],
      }),
    /COVERAGE/,
  );
});
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repairCandidate } from '../tools/auto-mission/expansion/repair.js';
import type { EvaluationManifest } from '../tools/auto-mission/expansion/store-schema.js';
test('only confirmed configuration defects create at most two immutable revisions awaiting explicit pilot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expansion-evaluation-test-'));
  try {
    let current = candidate;
    let currentConditions = conditions;
    for (let revision = 1; revision <= 2; revision++) {
      const p = {
        ...play(),
        candidateDigest: artifactDigest(current),
        revision,
        conditionsDigest: conditionsDigest(currentConditions),
      };
      const evaluator = client((body) => {
        if (body.model === 'gpt-6-astra') {
          const data = decodeEvaluationInput(body.input[0].content[0].text) as any;
          return {
            findings: data.findings.map((f: any) => ({
              findingId: f.id,
              classification: 'confirmed_scenario_defect',
              reason: 'fixture missing reachable clue',
              evidence: [ref],
              counterEvidence: [],
              counterEvidenceReason: 'fixture examined no counterexample',
            })),
          };
        }
        return {
          ...review,
          feasibilityFindings: [
            { id: 'clue', claim: 'fixture missing reachable clue', evidence: [ref] },
          ],
        };
      });
      const evaluation = await evaluateCandidate({
        source: input.source,
        candidate: current,
        conditions: currentConditions,
        plays: [p],
        prompts,
        budget: budget(),
        client: evaluator,
      });
      assert.equal(evaluation.status, 'complete', evaluation.failure ?? '');
      const manifest: EvaluationManifest = {
        schemaVersion: 1,
        kind: 'mission-expansion',
        runId: randomUUID(),
        mode: 'mock',
        parentRunId: null,
        conditions: currentConditions,
        pricingSnapshot: EXPANSION_PRICING,
        stage: 'pilot_reported',
        budgets: { maxCostUsd: null, maxCalls: 650, maxOutputTokens: 350000, deadlineMs: 4500000 },
        playMatrix: [{ playId: p.playId, model: p.model, persona: p.persona }],
        plays: [],
        callIds: [],
      };
      const args = {
        root,
        source: input.source,
        candidate: current,
        manifest,
        plays: [p],
        evaluation,
        client: client(() => mockExpansionProposal(input.source)),
        budget: budget(),
        prompt: prompts.repair,
      };
      const repaired = await repairCandidate(args);
      assert.equal(repaired.stage, 'awaiting_pilot');
      assert.equal(repaired.store.snapshot.plays.length, 0);
      assert.equal(repaired.candidate.revision, revision + 1);
      assert.equal(repaired.candidate.parentDigest, artifactDigest(current));
      const noDefect = structuredClone(evaluation);
      for (const f of noDefect.verifiedFindings) {
        f.classification = 'player_miss';
        f.blocking = false;
        f.repairable = false;
      }
      await assert.rejects(repairCandidate({ ...args, evaluation: noDefect }), /NO_CONFIRMED/);
      current = repaired.candidate;
      currentConditions = repaired.store.snapshot.conditions;
      if (revision === 2)
        await assert.rejects(repairCandidate({ ...args, candidate: current }), /REPAIR_LIMIT/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('shared-value encoding preserves every nested source and public-state value', () => {
  const value = {
    source: input.source,
    candidate,
    plays: Array.from({ length: 3 }, () => play()),
    repeated: [{ text: 'same'.repeat(100) }, { text: 'same'.repeat(100) }],
  };
  const encoded = encodeEvaluationInput(value);
  assert.deepEqual(decodeEvaluationInput(encoded), value);
  assert.ok(Buffer.byteLength(encoded) < Buffer.byteLength(JSON.stringify(value)));
});
test('Astra verifies all windows of a long failed play before synthesizing and rejects missing coverage', async () => {
  const p = play('uncleared');
  p.turns = Array.from({ length: 12 }, (_, i) => ({
    index: i + 1,
    playerRequest: 'inspect ' + i,
    publicReply: String(i) + 'q'.repeat(4000),
  }));
  const result = await evaluateCandidate({
    source: input.source,
    candidate,
    conditions,
    plays: [p],
    prompts,
    budget: budget(),
    client: client((body) => {
      if (body.model !== 'gpt-6-astra') return review;
      const data = decodeEvaluationInput(body.input[0].content[0].text) as {
        findings: { id: string }[];
      };
      return {
        findings: data.findings.map((f) => ({
          findingId: f.id,
          classification: 'player_miss',
          reason: 'fixture missed visible clue',
          evidence: [ref],
          counterEvidence: [],
          counterEvidenceReason: 'Synthetic fixture only',
        })),
      };
    }),
  });
  assert.equal(result.status, 'complete', result.failure ?? '');
  assert.ok(result.verifiedFindings[0]!.segments.length > 1);
  const expected = {
    source: input.source,
    candidate,
    candidateDigest: artifactDigest(candidate),
    conditionsDigest: conditionsDigest(conditions),
    plays: [p],
    expectedPlayIds: [p.playId],
  };
  assert.doesNotThrow(() => validateEvaluationForAdoption(result, expected));
  result.verifiedFindings[0]!.segments[0]!.turnRefs.pop();
  assert.throws(
    () => validateEvaluationForAdoption(result, expected),
    /VERIFICATION_COVERAGE_MISSING/,
  );
});

test('large source and candidate use bounded evaluation capacity without changing play limits', async () => {
  const large = structuredClone(candidate);
  large.expandedStory = Array.from({ length: 6 }, (_, i) => ({
    id: 'chapter-' + i,
    title: { ja: '章' + i, en: 'Chapter ' + i },
    body: {
      ja: String.fromCharCode(0x3042 + i).repeat(1800),
      en: String.fromCharCode(65 + i).repeat(1800),
    },
  }));
  const fixed = { ...conditions, candidateDigest: artifactDigest(large) };
  const p = {
    ...play(),
    candidateDigest: fixed.candidateDigest,
    conditionsDigest: conditionsDigest(fixed),
  };
  const calls: any[] = [];
  const args = {
    source: input.source,
    candidate: large,
    conditions: fixed,
    plays: [p],
    prompts,
    client: client((body) => {
      calls.push(body);
      return body.model === 'gpt-6-astra' ? { findings: [] } : review;
    }),
  };
  const small = await evaluateCandidate({ ...args, budget: budget() });
  assert.equal(small.status, 'incomplete');
  assert.equal(calls.length, 0);
  const result = await evaluateCandidate({
    ...args,
    budget: new ExpansionBudget({
      mode: 'mock',
      pricing: EXPANSION_PRICING,
      limits: EXPANSION_LIMITS.pilot,
    }),
  });
  assert.equal(result.status, 'complete', result.failure ?? '');
  assert.ok(calls.some((c) => Buffer.byteLength(JSON.stringify(c)) > 65536));
  assert.ok(calls.every((c) => Buffer.byteLength(JSON.stringify(c)) <= 131072));
  assert.equal(EXPANSION_LIMITS.static.maxInputBytes, 65536);
  assert.equal(EXPANSION_LIMITS.play.maxInputBytes, 65536);
});

test('runtime turn ids are the canonical references used by coverage and evidence', async () => {
  const p = play();
  p.turns = [{ id: 'test-play-turn-1', index: 1, playerRequest: 'inspect', publicReply: 'detail' }];
  const cited = {
    ...review,
    feasibilityEvidence: [{ kind: 'turn', playId: p.playId, turnId: 'test-play-turn-1' }],
  };
  const result = await evaluateCandidate({
    source: input.source,
    candidate,
    conditions,
    plays: [p],
    prompts,
    budget: budget(),
    client: client((body) => (body.model === 'gpt-6-astra' ? { findings: [] } : cited)),
  });
  assert.equal(result.status, 'complete', result.failure ?? '');
  assert.equal(result.reviews[0]!.segments[0]!.turnRefs[0]!.turnId, 'test-play-turn-1');
  assert.doesNotThrow(() =>
    validateEvaluationForAdoption(result, {
      source: input.source,
      candidate,
      candidateDigest: artifactDigest(candidate),
      conditionsDigest: conditionsDigest(conditions),
      plays: [p],
      expectedPlayIds: [p.playId],
    }),
  );
});
