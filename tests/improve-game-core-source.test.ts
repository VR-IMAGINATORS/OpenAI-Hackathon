import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  freezeSource,
  validateSource,
  validatePreservation,
  sha256,
} from '../tools/auto-mission/expansion/source.js';
import { compileExpandedScenario } from '../tools/auto-mission/expansion/compile.js';
import {
  parseExpansionCandidate,
  type ExpansionCandidate,
} from '../tools/auto-mission/expansion/schemas.js';
import { parseScenarioV2 } from '../packages/shared/scenario.js';
const raw = readFileSync('scenarios/story-catalog.json', 'utf8');
const source = freezeSource(raw);
const loc = (s: string) => ({ ja: s, en: s });
function candidate(): ExpansionCandidate {
  return {
    schemaVersion: 1,
    candidateId: 'warehouse-expanded',
    revision: 1,
    parentDigest: null,
    sourceDigest: source.sourceDigest,
    originalInvariantDigest: source.originalInvariantDigest,
    openingOverview: loc('A dark room with a restraint nearby.'),
    expandedStory: [
      { id: 'opening', title: loc('Opening'), body: loc('An expanded story chapter.') },
    ],
    knowledgeAdditions: [
      {
        id: 'restraint-detail',
        kind: 'observable',
        localizedText: loc('A narrow seam is visible.'),
        prerequisites: [{ factKey: source.selection.obstacleIds[0]!, value: 'blocked' }],
        revealMode: 'on_request',
        requestCue: loc('Inspect the seam'),
        observationTargetId: source.selection.obstacleIds[0]!,
      },
    ],
    observationTargets: [],
    knowledgeMetadata: [
      {
        knowledgeId: 'restraint-detail',
        targetId: source.selection.obstacleIds[0]!,
        layer: 'detail',
      },
    ],
    displayOverrides: [{ path: '/playerBriefing', value: loc('Investigate your surroundings.') }],
    ambienceSlots: [],
    publicVisuals: [{ id: 'opening', description: loc('Darkness.'), prerequisites: [] }],
    changeMap: [
      {
        sourcePointer: '/scenes/0',
        expandedPointer: '/expandedStory/0',
        kind: 'added',
        reason: loc('Adds investigation context.'),
      },
    ],
  };
}
test('freezes exact raw bytes, fixed selection and reference solutions without mutating source', () => {
  assert.equal(source.rawCatalogText, raw);
  assert.equal(source.sourceDigest, sha256(raw));
  assert.equal(source.selection.sceneId, 'scene-echo-platform');
  assert.deepEqual(source.selection.obstacleIds, [
    'gimmick-pressure-latch',
    'gimmick-magnetic-rail',
    'gimmick-thermal-leak',
  ]);
  assert.deepEqual(
    source.originalSections.gimmicks.map((g) => g.referenceSolutions),
    JSON.parse(raw)
      .gimmicks.filter((g: any) => source.selection.obstacleIds.includes(g.id))
      .map((g: any) => g.referenceSolutions),
  );
  const before = JSON.stringify(source);
  const compiled = compileExpandedScenario(source, candidate());
  assert.equal(JSON.stringify(source), before);
  validatePreservation(source, compiled);
  assert.equal(readFileSync('scenarios/story-catalog.json', 'utf8'), raw);
  assert.equal(freezeSource(raw + '\n').sourceDigest === source.sourceDigest, false);
});
test('rejects tampered raw, selection, compiled state and reference solution snapshot', () => {
  for (const mutate of [
    (s: any) => {
      s.rawCatalogText += ' ';
    },
    (s: any) => {
      s.selection.obstacleIds.reverse();
    },
    (s: any) => {
      s.compiledOriginal.rules.totalTimeSeconds += 1;
    },
    (s: any) => {
      s.originalSections.gimmicks[0].referenceSolutions[0].use.ja = 'tampered';
    },
  ]) {
    const changed = structuredClone(source);
    mutate(changed);
    assert.throws(() => validateSource(changed));
  }
});
test('fixed rules, order, conditions, transitions, acceptance, examples and physical constraints cannot change', () => {
  const compiled = compileExpandedScenario(source, candidate());
  const mutations = [
    (s: any) => s.obstacles.reverse(),
    (s: any) => {
      s.rules.initialCredits += 20;
    },
    (s: any) => {
      s.obstacles[0].completionFact.value = 'partial';
    },
    (s: any) => {
      s.core.facts[0].allowedTransitions.pop();
    },
    (s: any) => {
      s.obstacles[0].goal = 'new acceptance';
    },
    (s: any) => {
      s.obstacles[0].constraints = [];
    },
    (s: any) => {
      s.obstacles[0].mechanism.ja = 'different solution';
    },
    (s: any) => {
      s.setting.constraints = [];
    },
    (s: any) => {
      s.knowledge[0].prerequisites = [];
      s.knowledge[0].kind = 'hidden';
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(compiled);
    mutate(changed);
    assert.throws(() => validatePreservation(source, changed));
  }
  const c = candidate();
  c.displayOverrides.push({ path: '/obstacles/0/goal', value: loc('changed') });
  assert.throws(() => compileExpandedScenario(source, c), /Forbidden/);
});
test('layer and reference validation keeps direct detail conditions and separates hints/background', () => {
  const c = candidate();
  const compiled = compileExpandedScenario(source, c);
  assert.deepEqual(
    compiled.knowledge.at(-1)!.prerequisites,
    c.knowledgeAdditions[0]!.prerequisites,
  );
  for (const mutate of [
    (c: ExpansionCandidate) => {
      c.knowledgeMetadata[0]!.knowledgeId = 'missing';
    },
    (c: ExpansionCandidate) => {
      c.knowledgeMetadata[0]!.targetId = 'missing';
    },
    (c: ExpansionCandidate) => {
      c.knowledgeMetadata[0]!.layer = 'background';
      c.knowledgeAdditions[0]!.revealMode = 'automatic';
    },
    (c: ExpansionCandidate) => {
      c.knowledgeMetadata[0]!.layer = 'hint';
      c.knowledgeAdditions[0]!.revealMode = 'automatic';
    },
    (c: ExpansionCandidate) => {
      c.publicVisuals[0]!.prerequisites = [{ factKey: 'missing', value: 'blocked' }];
    },
    (c: ExpansionCandidate) => {
      c.changeMap[0]!.sourcePointer = '/missing';
    },
    (c: ExpansionCandidate) => {
      c.changeMap[0]!.expandedPointer = '/expandedStory/100';
    },
    (c: ExpansionCandidate) => {
      c.knowledgeAdditions[0]!.id = source.compiledOriginal.knowledge[0]!.id;
    },
  ]) {
    const changed = candidate();
    mutate(changed);
    assert.throws(() => compileExpandedScenario(source, changed));
  }
});
test('ambience allowlist requires existing targets and distinct attributes', () => {
  const c = candidate();
  const slot = {
    id: 'dust-tone',
    targetId: source.selection.obstacleIds[0]!,
    attribute: 'dust-tone',
    allowedValues: [loc('Grey')],
    nonGameplayRationale: loc('Decorative dust hue has no mechanism role.'),
  };
  c.ambienceSlots = [slot];
  assert.equal(compileExpandedScenario(source, c).investigation!.ambienceSlots.length, 1);
  c.ambienceSlots.push({ ...slot, id: 'duplicate' });
  assert.throws(() => compileExpandedScenario(source, c));
  c.ambienceSlots = [{ ...slot, targetId: 'missing' }];
  assert.throws(() => compileExpandedScenario(source, c));
});
test('rejects oversized source, candidate texts, total output and too many knowledge entries', () => {
  assert.throws(() => freezeSource(raw + ' '.repeat(256 * 1024)), /256 KiB/);
  const long = candidate();
  long.openingOverview.ja = 'a'.repeat(2001);
  assert.throws(() => parseExpansionCandidate(long));
  const many = candidate();
  many.knowledgeAdditions = Array.from({ length: 100 }, (_, i) => ({
    ...many.knowledgeAdditions[0]!,
    id: 'extra-' + i,
  }));
  many.knowledgeMetadata = many.knowledgeAdditions.map((entry) => ({
    knowledgeId: entry.id,
    targetId: entry.observationTargetId!,
    layer: 'detail',
  }));
  assert.throws(() => compileExpandedScenario(source, many), /100/);
  const huge = candidate();
  huge.expandedStory = Array.from({ length: 100 }, (_, i) => ({
    id: 'chapter-' + i,
    title: loc('Chapter'),
    body: loc('あ'.repeat(2000)),
  }));
  assert.throws(() => parseExpansionCandidate(huge), /256 KiB/);
});
test('legacy V2 and compiled V3 do not require investigation metadata', () => {
  assert.equal(parseScenarioV2(source.compiledOriginal).investigation, undefined);
  assert.equal(freezeSource(raw, 1).compiledOriginal.investigation, undefined);
});

test('added knowledge cannot omit typed disclosure metadata', () => {
  const c = candidate();
  c.knowledgeMetadata = [];
  assert.throws(() => compileExpandedScenario(source, c), /matching target and layer/);
});
