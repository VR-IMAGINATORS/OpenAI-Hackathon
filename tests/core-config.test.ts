import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCoreConfig } from '../packages/shared/core-config.js';
import {
  localizeScenario,
  parseScenario,
  parseScenarioV2,
  publicScenarioV2,
} from '../packages/shared/scenario.js';
const scenario = () => JSON.parse(readFileSync('scenarios/mobile-playtest.json', 'utf8'));
const config = () => JSON.parse(readFileSync('config/game-core.json', 'utf8'));

test('v2 scenario projects both languages while retaining the v1 runtime contract', () => {
  const value = parseScenarioV2(scenario());
  for (const locale of ['ja', 'en'] as const) {
    const projected = localizeScenario(value, locale);
    assert.equal(projected.version, 1);
    assert.equal(projected.title, value.title[locale]);
    assert.equal(projected.obstacles[0].situation, value.obstacles[0].situationDisplay[locale]);
    assert.deepEqual(parseScenario(projected), projected);
  }
  assert.notEqual(localizeScenario(value, 'en').title, localizeScenario(value, 'ja').title);
  const safe = publicScenarioV2(value);
  assert.deepEqual(Object.keys(safe).sort(), [
    'id',
    'obstacleCount',
    'playerBriefing',
    'rules',
    'title',
  ]);
  assert.equal(JSON.stringify(safe).includes(value.core.judgmentPolicy), false);
  assert.equal(JSON.stringify(safe).includes(value.obstacles[0].goal), false);
});

test('v2 requires all player-facing translations and rejects planner privilege fields', () => {
  const cases = [
    (s: any) => {
      delete s.title.en;
    },
    (s: any) => {
      delete s.premise.ja;
    },
    (s: any) => {
      delete s.playerBriefing.en;
    },
    (s: any) => {
      delete s.obstacles[0].title.en;
    },
    (s: any) => {
      delete s.obstacles[0].situationDisplay.en;
    },
    (s: any) => {
      s.title.en = '';
    },
    (s: any) => {
      s.core.model = 'custom';
    },
    (s: any) => {
      s.apiUrl = 'https://example.invalid';
    },
    (s: any) => {
      s.core.facts[0].budget = 100;
    },
    (s: any) => {
      s.obstacles[0].requiredVisualFacts[0].secret = 'forbidden';
    },
    (s: any) => {
      s.core.characterAppearance = 'x'.repeat(2001);
    },
  ];
  for (const mutate of cases) {
    const value = scenario();
    mutate(value);
    assert.throws(() => parseScenarioV2(value));
  }
});

test('v2 rejects duplicate identifiers and inconsistent fact or transition references', () => {
  const cases = [
    (s: any) => {
      s.core.facts.push(s.core.facts[0]);
    },
    (s: any) => {
      s.core.facts[0].values.push(s.core.facts[0].values[0]);
    },
    (s: any) => {
      s.core.facts[0].initial = 'unknown';
    },
    (s: any) => {
      s.core.facts[0].allowedTransitions[0].to = 'unknown';
    },
    (s: any) => {
      s.core.facts[0].allowedTransitions[0].to = s.core.facts[0].allowedTransitions[0].from;
    },
    (s: any) => {
      s.core.facts[0].allowedTransitions.push(s.core.facts[0].allowedTransitions[0]);
    },
    (s: any) => {
      s.obstacles[0].factKeys.push('unknown');
    },
    (s: any) => {
      s.obstacles[0].factKeys.push(s.obstacles[0].factKeys[0]);
    },
    (s: any) => {
      s.obstacles[0].requiredVisualFacts[0].value = 'unknown';
    },
    (s: any) => {
      s.obstacles[0].requiredVisualFacts.push(s.obstacles[0].requiredVisualFacts[0]);
    },
    (s: any) => {
      s.obstacles[0].factKeys = ['door'];
    },
    (s: any) => {
      s.obstacles[0].forbiddenVisualChanges[0].to = 'unknown';
    },
    (s: any) => {
      s.obstacles[0].forbiddenVisualChanges.push(s.obstacles[0].forbiddenVisualChanges[0]);
    },
    (s: any) => {
      s.obstacles[1].id = s.obstacles[0].id;
    },
    (s: any) => {
      s.events[0].eligibleObstacleIds = ['unknown'];
    },
    (s: any) => {
      s.events[0].eligibleObstacleIds.push(s.events[0].eligibleObstacleIds[0]);
    },
    (s: any) => {
      s.rules.maxPhotoSends = 0;
    },
  ];
  for (const mutate of cases) {
    const value = scenario();
    mutate(value);
    assert.throws(() => parseScenarioV2(value));
  }
});

test('common config requires both languages and complete classification examples with bounded display timing', () => {
  assert.equal(parseCoreConfig(config()).schemaVersion, 1);
  const cases = [
    (c: any) => {
      delete c.conversation.en;
    },
    (c: any) => {
      c.conversation.ja.classificationExamples[0].kind = 'execute';
    },
    (c: any) => {
      c.chatGroupingGapMs = -1;
    },
    (c: any) => {
      c.chatGroupingGapMs = 10001;
    },
    (c: any) => {
      c.chatGroupingGapMs = 1.5;
    },
    (c: any) => {
      c.model = 'custom';
    },
    (c: any) => {
      c.conversation.ja.apiUrl = 'https://example.invalid';
    },
    (c: any) => {
      c.judgment.budget = 100;
    },
    (c: any) => {
      c.visualInspection.timeout = 600;
    },
  ];
  for (const mutate of cases) {
    const value = config();
    mutate(value);
    assert.throws(() => parseCoreConfig(value));
  }
});

test('time warning configuration validates thresholds and translations and is optional for old files', () => {
  const old = config();
  delete old.timeWarning;
  assert.doesNotThrow(() => parseCoreConfig(old));
  for (const thresholdSeconds of [0, -1, 1.5, 3601]) {
    const value = config();
    value.timeWarning.thresholdSeconds = thresholdSeconds;
    assert.throws(() => parseCoreConfig(value));
  }
  const value = config();
  delete value.timeWarning.message.en;
  assert.throws(() => parseCoreConfig(value));
});
