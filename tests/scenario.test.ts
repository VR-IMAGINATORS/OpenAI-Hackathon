import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseScenario, publicScenario } from '../packages/shared/scenario.js';
const sample = () => JSON.parse(readFileSync('scenarios/default.json', 'utf8'));

test('default scenario exposes only public briefing and settings', () => {
  const scenario = parseScenario(sample());
  const projected = publicScenario(scenario);
  assert.equal(projected.obstacleCount, 3);
  assert.equal(projected.rules.initialCredits, 1000);
  assert.deepEqual(Object.keys(projected).sort(), [
    'id',
    'obstacleCount',
    'playerBriefing',
    'rules',
    'title',
  ]);
  assert.equal(JSON.stringify(projected).includes(scenario.obstacles[0].goal), false);
});
test('planner typos, duplicate IDs, impossible counts and unknown event references are rejected', () => {
  const cases = [
    (s: any) => {
      s.rules.initialCredits = 0;
    },
    (s: any) => {
      s.rules.initialCredits = 100020;
    },
    (s: any) => {
      s.rules.initialCredits = 21;
    },
    (s: any) => {
      s.rules.initialCredits = 20.5;
    },
    (s: any) => {
      s.rules.maxPhotoSends = 4;
    },
    (s: any) => {
      s.rules.maxPhotosPerSend = 3;
    },
    (s: any) => {
      s.rules.totalTimeSeconds = 0;
    },
    (s: any) => {
      s.rules.totalTimeSeconds = 300.5;
    },
    (s: any) => {
      s.obstacles[1].id = s.obstacles[0].id;
    },
    (s: any) => {
      s.events[0].eligibleObstacleIds = ['missing'];
    },
    (s: any) => {
      s.events[0].mode = 'maybe';
    },
    (s: any) => {
      s.rules.maxAction = 4;
    },
    (s: any) => {
      s.ending.generateOnFailure = false;
    },
  ];
  for (const mutate of cases) {
    const value = sample();
    mutate(value);
    assert.throws(() => parseScenario(value));
  }
});
test('planner can tune values, replace scenario and disable an event', () => {
  const value = sample();
  value.id = 'another-scenario';
  value.rules.initialCredits = 600;
  value.rules.totalTimeSeconds = 180;
  value.events[0].mode = 'disabled';
  const scenario = parseScenario(value);
  assert.equal(scenario.rules.initialCredits, 600);
  assert.equal(scenario.events[0].mode, 'disabled');
});

test('initial credit configuration accepts the minimum and maximum multiples of twenty', () => {
  for (const initialCredits of [20, 100000]) {
    const value = sample();
    value.rules.initialCredits = initialCredits;
    assert.equal(parseScenario(value).rules.initialCredits, initialCredits);
  }
});
