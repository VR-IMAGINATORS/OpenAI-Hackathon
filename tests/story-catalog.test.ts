import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  compileStoryScenario,
  parseStoryCatalog,
  storyCandidateCount,
  type StoryCatalog,
} from '../packages/shared/story-catalog.js';
import {
  localizeScenario,
  parseScenarioV2,
  publicScenarioV2,
  type ScenarioV2,
} from '../packages/shared/scenario.js';

const raw = () => JSON.parse(readFileSync('scenarios/story-catalog.json', 'utf8'));
const catalog = () => parseStoryCatalog(raw());
const master = JSON.parse(readFileSync('.agents/skills/call-to-past/assets/masters.json', 'utf8'));

test('all six scenes, ten gimmicks and eighteen sequences retain original Japanese master data', () => {
  const value = catalog();
  assert.equal(value.scenes.length, 6);
  assert.equal(value.gimmicks.length, 10);
  assert.equal(storyCandidateCount(value), 18);
  assert.deepEqual(
    value.scenes.map((scene) => scene.id),
    master.scenes.map((s: any) => s.id),
  );
  value.scenes.forEach((scene, index) => {
    const original = master.scenes[index];
    for (const field of ['name', 'description', 'anchor', 'mystery'] as const)
      assert.equal(scene[field].ja, original[field]);
    assert.deepEqual(scene.sequences, original.sequences);
  });
  assert.deepEqual(
    value.gimmicks.map((gimmick) => gimmick.id),
    master.gimmicks.map((g: any) => g.id),
  );
  value.gimmicks.forEach((gimmick, index) => {
    const original = master.gimmicks[index];
    for (const field of ['name', 'observation', 'mechanism'] as const)
      assert.equal(gimmick[field].ja, original[field]);
    for (const field of ['hints', 'acceptance', 'rejection', 'examples'] as const)
      assert.deepEqual(
        gimmick[field].map((entry) => entry.ja),
        original[field],
      );
    assert.deepEqual(
      gimmick.referenceSolutions.map((solution) => ({
        item_ids: solution.itemIds,
        required_properties: solution.requiredProperties,
        use: solution.use.ja,
        photo_count: solution.photoCount,
        preconditions: solution.preconditions.map((entry) => entry.ja),
        consumes: solution.consumes,
        breaks: solution.breaks,
        clears: solution.clears,
        postconditions: solution.postconditions.map((entry) => entry.ja),
      })),
      original.reference_solutions,
    );
    assert.equal(gimmick.states.blocked.ja, original.observation);
    assert.equal(
      gimmick.states.cleared.ja,
      original.reference_solutions[0].postconditions.join(' '),
    );
  });
  assert.deepEqual(
    value.items.map((item) => ({
      id: item.id,
      name: item.name.ja,
      properties: item.properties,
      uses: item.uses.map((entry) => entry.ja),
    })),
    master.items,
  );
});

test('every localized field has Japanese and English text without replacement or placeholder damage', () => {
  const walk = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if ('ja' in value && 'en' in value) {
      assert.equal(typeof value.ja, 'string');
      assert.equal(typeof value.en, 'string');
      assert.match(value.ja as string, /[\u3040-\u30ff\u3400-\u9fff]/u);
      assert.match(value.en as string, /[a-z]/i);
      assert.doesNotMatch(value.en as string, /[\u3040-\u30ff\u3400-\u9fff]/u);
      assert.doesNotMatch(`${value.ja} ${value.en}`, /\?{2}|\uFFFD/u);
    }
    Object.values(value).forEach(walk);
  };
  walk(catalog());
});

test('catalog requires a localized player objective instead of falling back to the obstacle name', () => {
  for (const objective of [
    undefined,
    { ja: '縄を外す' },
    { en: 'Release the rope' },
    { ja: '', en: 'Release the rope' },
  ]) {
    const value = raw();
    value.gimmicks[0].objective = objective;
    assert.throws(() => parseStoryCatalog(value));
  }
});

test('all candidates compile in master order with isolated progress facts, complete metadata and both locales', () => {
  const value = catalog();
  const ids = new Set<string>();
  const expected = master.scenes.flatMap((scene: any) => scene.sequences);
  for (let index = 0; index < storyCandidateCount(value); index++) {
    const scenario = compileStoryScenario(value, index);
    const scene = value.scenes[Math.floor(index / 3)]!;
    ids.add(scenario.id);
    assert.deepEqual(
      scenario.obstacles.map((obstacle) => obstacle.id),
      expected[index],
    );
    assert.deepEqual(scenario.story?.openingClue, scene.openingClue);
    assert.deepEqual(scenario.story?.mystery, scene.mystery);
    assert.equal(scenario.setting.location, scene.description.ja);
    assert.equal(scenario.core.characterAppearance, scene.anchor.ja);
    assert.deepEqual(scenario.rules, {
      initialCredits: 1000,
      maxPhotosPerSend: 2,
      totalTimeSeconds: 300,
    });
    for (const obstacle of scenario.obstacles) {
      assert.deepEqual(obstacle.factKeys, [obstacle.id]);
      assert.deepEqual(obstacle.completionFact, { key: obstacle.id, value: 'cleared' });
      assert.deepEqual(obstacle.requiredVisualFacts, [{ key: obstacle.id, value: 'blocked' }]);
      assert.deepEqual(
        obstacle.forbiddenVisualChanges.map((change) => change.from),
        ['blocked', 'partial'],
      );
      const fact = scenario.core.facts.find((entry) => entry.key === obstacle.id)!;
      assert.equal(fact.initial, 'blocked');
      assert.deepEqual(fact.allowedTransitions, [
        { from: 'blocked', to: 'partial' },
        { from: 'blocked', to: 'cleared' },
        { from: 'partial', to: 'cleared' },
      ]);
      assert.ok(obstacle.mechanism);
      assert.equal(obstacle.hints?.length, 3);
      for (const locale of ['ja', 'en'] as const) {
        assert.equal(localizeScenario(scenario, locale).title, scene.name[locale]);
        assert.ok(obstacle.hints![2]![locale]);
      }
    }
    const publicText = JSON.stringify(publicScenarioV2(scenario));
    assert.equal(publicText.includes(scenario.story!.mystery.ja), false);
    assert.equal(publicText.includes(scenario.obstacles[2]!.mechanism!.ja), false);
  }
  assert.equal(ids.size, 18);
  assert.equal(new Set(value.gimmicks.map((gimmick) => gimmick.states.partial.ja)).size, 10);
  for (const index of [-1, 18, 1.2, NaN, Infinity])
    assert.throws(() => compileStoryScenario(value, index), RangeError);
});

test('catalog rejects bad references, stage order, properties, photos and typos before any candidate is selected', () => {
  const mutations: Array<(value: StoryCatalog) => void> = [
    (c) => {
      c.scenes[1]!.id = c.scenes[0]!.id;
    },
    (c) => {
      c.gimmicks[1]!.id = c.gimmicks[0]!.id;
    },
    (c) => {
      c.items[1]!.id = c.items[0]!.id;
    },
    (c) => {
      c.scenes[5]!.sequences[2]![2] = 'missing';
    },
    (c) => {
      c.scenes[0]!.sequences[0]!.reverse();
    },
    (c) => {
      c.scenes[0]!.sequences[1] = [...c.scenes[0]!.sequences[0]!];
    },
    (c) => {
      c.gimmicks[0]!.stage = 'exit';
    },
    (c) => {
      c.gimmicks[0]!.referenceSolutions[0]!.itemIds = ['missing'];
    },
    (c) => {
      c.gimmicks[0]!.referenceSolutions[0]!.requiredProperties = ['unseen-power'];
    },
    (c) => {
      c.gimmicks[0]!.referenceSolutions[0]!.consumes = ['missing'];
    },
    (c) => {
      c.gimmicks[0]!.referenceSolutions[0]!.photoCount = 2;
    },
    (c) => {
      c.rules.initialCredits = 0;
    },
    (c) => {
      c.story.world.en = '';
    },
    (c) => {
      Object.assign(c.scenes[0]!, { hiddenAnswer: 'unexpected' });
    },
  ];
  for (const mutate of mutations) {
    const value = raw();
    mutate(value);
    assert.throws(() => parseStoryCatalog(value));
  }
});

test('V2 completion facts must be owned, declared, reachable and terminal; old V2 remains valid', () => {
  const mutations: Array<(scenario: ScenarioV2) => void> = [
    (s) => {
      s.obstacles[0]!.completionFact!.key = 'missing';
    },
    (s) => {
      s.obstacles[0]!.completionFact!.key = s.obstacles[1]!.id;
    },
    (s) => {
      s.obstacles[0]!.completionFact!.value = 'undeclared';
    },
    (s) => {
      s.obstacles[0]!.completionFact!.value = 'blocked';
    },
    (s) => {
      s.core.facts[0]!.allowedTransitions = [{ from: 'blocked', to: 'partial' }];
    },
    (s) => {
      s.core.facts[0]!.allowedTransitions.push({ from: 'cleared', to: 'blocked' });
    },
    (s) => {
      s.obstacles[1]!.completionFact = { ...s.obstacles[0]!.completionFact! };
      s.obstacles[1]!.factKeys.push(s.obstacles[0]!.id);
    },
    (s) => {
      s.core.facts[0]!.allowedTransitions.push({ from: 'partial', to: 'unknown' });
    },
  ];
  const value = catalog();
  for (const mutate of mutations) {
    const scenario = compileStoryScenario(value, 0);
    mutate(scenario);
    assert.throws(() => parseScenarioV2(scenario));
  }
  const previous = JSON.parse(readFileSync('scenarios/mobile-playtest.json', 'utf8'));
  assert.deepEqual(parseScenarioV2(previous), {
    ...previous,
    knowledge: [],
    observationTargets: [],
  });
});
