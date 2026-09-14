import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { digestValue } from '../tools/auto-mission/config.js';
import { simulateWitness, validateContract } from '../tools/auto-mission/simulate.js';
import { deriveVerdict, validateEvidence } from '../tools/auto-mission/verdict.js';
import {
  missionContractSchema,
  missionCandidateSchema,
  type MissionContract,
  type MissionCandidate,
  type Review,
  type Verification,
} from '../tools/auto-mission/schemas.js';
function fixture(name = 'valid') {
  const f = JSON.parse(readFileSync(`tests/fixtures/auto-mission/${name}.json`, 'utf8'));
  return {
    contract: missionContractSchema.parse(f.contract),
    candidate: missionCandidateSchema.parse(f.candidate),
  };
}
const passes = (contract: MissionContract, candidate: MissionCandidate) =>
  simulateWitness(contract, candidate).checks.every((c) => c.status === 'pass');
function evaluations(candidate: MissionCandidate) {
  const candidateDigest = digestValue(candidate);
  return {
    reviews: ['physics', 'resources', 'causality'].map((role) => ({
      role,
      candidateDigest,
      verdict: 'pass',
      summary: '確認済み',
      findings: [],
    })) as Review[],
    verification: { candidateDigest, decisions: [], findings: [] } as Verification,
  };
}
test('normal fixture passes deterministic checks with resource totals', () => {
  const { contract, candidate } = fixture();
  const result = simulateWitness(contract, candidate);
  assert.equal(passes(contract, candidate), true);
  assert.deepEqual(result.resourceTotals, { photoSends: 3, actions: 5, photos: 3 });
  assert.equal(result.stateTrace.length, 8);
});
test('all fixtures parse but mechanics alone do not claim physics review', () => {
  for (const name of ['valid', 'action-limit', 'spent-tool', 'bound-body', 'missing-placement'])
    fixture(name);
  for (const name of ['action-limit', 'spent-tool']) {
    const f = fixture(name);
    assert.equal(passes(f.contract, f.candidate), false, name);
  }
  for (const name of ['bound-body', 'missing-placement']) {
    const f = fixture(name);
    assert.equal(passes(f.contract, f.candidate), true, name);
  }
});
test('invalid contract references and duplicate fact values fail', () => {
  const { contract } = fixture();
  contract.initialState.locationId = 'absent';
  assert.equal(validateContract(contract).valid, false);
});
test('contract mutation, unknown tool, unmet precondition, time and photo overages fail', () => {
  for (const mutation of [
    (c: MissionContract, k: MissionCandidate) => (c.difficulty.totalTimeSeconds = 1),
    (c: MissionContract, k: MissionCandidate) => (k.items[0].catalogId = 'magic'),
    (c: MissionContract, k: MissionCandidate) =>
      (k.steps[0].preconditions = [{ key: 'rope', value: 'open' }]),
    (c: MissionContract, k: MissionCandidate) => {
      c.difficulty.maxPhotoSends = 1;
      k.contractDigest = digestValue(c);
    },
    (c: MissionContract, k: MissionCandidate) => {
      c.difficulty.totalTimeSeconds = 1;
      k.contractDigest = digestValue(c);
    },
  ]) {
    const f = fixture();
    mutation(f.contract, f.candidate);
    assert.equal(passes(f.contract, f.candidate), false);
  }
});
test('cannot skip earlier goal or fake ending', () => {
  const f = fixture();
  f.candidate.steps[1].factEffects = [];
  assert.equal(passes(f.contract, f.candidate), false);
});
test('placed tools do not follow movement without retrieval', () => {
  const f = fixture();
  f.contract.locations.push({ id: 'hall', description: '別室' });
  f.candidate.contractDigest = digestValue(f.contract);
  const held = { phase: 'held', locationId: 'room', condition: 'usable' } as const;
  const placed = { ...held, phase: 'placed' } as const;
  const base = structuredClone(f.candidate.steps[1]);
  f.candidate.steps.splice(
    1,
    0,
    {
      ...base,
      id: 'put',
      kind: 'place',
      factEffects: [],
      itemEffects: [{ itemId: 'scissors', from: held, to: placed }],
    },
    {
      ...base,
      id: 'walk',
      kind: 'move',
      itemIds: [],
      factEffects: [],
      itemEffects: [],
      targetLocationId: 'hall',
    },
  );
  assert.equal(passes(f.contract, f.candidate), false);
});
test('use cannot silently retrieve a placed object or restore a spent tool', () => {
  const f = fixture();
  const base = f.candidate.steps[1];
  base.itemEffects = [
    {
      itemId: 'scissors',
      from: { phase: 'held', locationId: 'room', condition: 'usable' },
      to: { phase: 'placed', locationId: 'room', condition: 'usable' },
    },
  ];
  assert.equal(passes(f.contract, f.candidate), false);
});
test('verdict requires all three independent roles and current digest', () => {
  const f = fixture();
  const m = simulateWitness(f.contract, f.candidate);
  const { reviews, verification } = evaluations(f.candidate);
  assert.equal(deriveVerdict(f.candidate, m, reviews, verification).passed, true);
  assert.equal(
    deriveVerdict(f.candidate, m, reviews.slice(1), verification).failureCode,
    'REVIEW_INCOMPLETE',
  );
  reviews[0].verdict = 'unknown';
  assert.equal(deriveVerdict(f.candidate, m, reviews, verification).passed, false);
  reviews[0].verdict = 'pass';
  verification.candidateDigest = 'a'.repeat(64);
  assert.equal(deriveVerdict(f.candidate, m, reviews, verification).failureCode, 'OUTPUT_INVALID');
});
test('findings require exact coverage and rejection counterevidence', () => {
  const f = fixture();
  const m = simulateWitness(f.contract, f.candidate);
  const { reviews, verification } = evaluations(f.candidate);
  reviews[0].findings = [
    {
      id: 'physics-1',
      role: 'physics',
      blocking: true,
      category: 'physical',
      targetPath: '/steps/1/description',
      excerpt: 'ハサミ',
      reason: '不可能',
      missingInformation: '',
    },
  ];
  reviews[0].verdict = 'fail';
  assert.equal(deriveVerdict(f.candidate, m, reviews, verification).passed, false);
  verification.decisions = [
    {
      findingId: 'physics-1',
      disposition: 'rejected',
      reason: '操作可能',
      evidencePaths: ['/opening'],
      counterevidence: '',
    },
  ];
  assert.equal(deriveVerdict(f.candidate, m, reviews, verification).passed, false);
  verification.decisions[0].counterevidence = '手が自由に動くと冒頭で明示されている';
  assert.equal(deriveVerdict(f.candidate, m, reviews, verification).passed, true);
  verification.decisions[0].disposition = 'unresolved';
  assert.equal(deriveVerdict(f.candidate, m, reviews, verification).failureCode, 'STORY_REJECTED');
  verification.decisions.push(verification.decisions[0]);
  assert.equal(deriveVerdict(f.candidate, m, reviews, verification).failureCode, 'OUTPUT_INVALID');
});
test('mechanical failure cannot be overturned and invalid evidence is rejected', () => {
  const f = fixture('spent-tool');
  const { reviews, verification } = evaluations(f.candidate);
  assert.equal(
    deriveVerdict(f.candidate, simulateWitness(f.contract, f.candidate), reviews, verification)
      .failureCode,
    'STORY_REJECTED',
  );
  assert.equal(validateEvidence(f.candidate, { targetPath: '/__proto__', excerpt: 'x' }), false);
  assert.equal(
    validateEvidence(f.candidate, { targetPath: '/opening', excerpt: 'nonexisting excerpt' }),
    false,
  );
});

test('barehand interaction with a fixed prop can change declared facts without inventing items', () => {
  const f = fixture();
  f.contract.initialState.props[0].description =
    f.contract.initialState.props[0].description.replace(
      '取っ手は常温で、少量の水滴だけが付いて滑る。',
      '取っ手は常温で乾いており、素手で握れる。',
    );
  f.candidate.contractDigest = digestValue(f.contract);
  const step = f.candidate.steps.find((s) => s.id === 'use-towel')!;
  step.description = '既存の出口の取っ手を素手で引いて開ける。';
  step.itemIds = [];
  step.itemEffects = [];
  assert.equal(passes(f.contract, f.candidate), true);
  const result = simulateWitness(f.contract, f.candidate);
  assert.equal(result.resourceTotals.actions, 5);
  assert.equal(result.stateTrace.at(-1)?.facts.find((f) => f.key === 'exit')?.value, 'open');
  step.itemEffects = [
    {
      itemId: 'invented-key',
      from: { phase: 'unmaterialized', locationId: null, condition: 'usable' },
      to: { phase: 'held', locationId: 'room', condition: 'usable' },
    },
  ];
  assert.equal(passes(f.contract, f.candidate), false);
});

test('send, place and retrieve still require a materialized-object target', () => {
  for (const kind of ['send', 'place', 'retrieve'] as const) {
    const f = fixture();
    const step = f.candidate.steps[0];
    step.kind = kind;
    step.itemIds = [];
    step.itemEffects = [];
    assert.equal(passes(f.contract, f.candidate), false, kind);
    assert.ok(
      simulateWitness(f.contract, f.candidate).checks.some(
        (c) => c.status === 'fail' && c.reason === '操作対象が指定されている',
      ),
    );
  }
});

test('contract rejects mutually exclusive terminal goals across obstacle milestones', () => {
  const { contract } = fixture();
  contract.factDefinitions.push({
    key: 'player_location',
    allowedValues: ['room', 'middle_room', 'exit_room', 'outside'],
    initialValue: 'room',
  });
  for (const [index, value] of ['middle_room', 'exit_room', 'outside'].entries()) {
    contract.orderedObstacles[index].goalConditions = [{ key: 'player_location', value }];
  }
  contract.escapeConditions = [{ key: 'player_location', value: 'outside' }];
  const result = validateContract(contract);
  assert.equal(result.valid, false);
  assert.ok(
    result.checks.some(
      (c) =>
        c.status === 'fail' &&
        c.path === '/orderedObstacles/1/goalConditions/0' &&
        c.reason.includes('終端条件が矛盾'),
    ),
  );
  assert.ok(result.checks.some((c) => c.status === 'fail' && c.path === '/escapeConditions/0'));
});

test('contract rejects escape conflicts but permits shared identical terminal facts', () => {
  const { contract } = fixture();
  contract.escapeConditions = [{ key: 'rope', value: 'closed' }];
  assert.equal(validateContract(contract).valid, false);
  contract.escapeConditions = [{ key: 'rope', value: 'open' }];
  contract.orderedObstacles[1].goalConditions.push({ key: 'rope', value: 'open' });
  assert.equal(validateContract(contract).valid, true);
  contract.orderedObstacles[1].goalConditions.push({ key: 'rope', value: 'open' });
  assert.equal(
    validateContract(contract).valid,
    false,
    'duplicate keys within one goal list remain invalid',
  );
});
