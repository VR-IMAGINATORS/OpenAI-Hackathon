import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseScenarioV2 } from '../packages/shared/scenario.js';
import { parseCoreConfig } from '../packages/shared/core-config.js';
import type { ScenarioSnapshot } from '../apps/server/scenario-catalog.js';
import { gimmickGuidance } from '../apps/local-server/gimmick-guidance.js';
import { storyOpeningBriefing } from '../apps/local-server/story.js';

function snapshot(locale: 'ja' | 'en' = 'ja'): ScenarioSnapshot {
  return {
    digest: 'guidance-test',
    createdAt: 0,
    locale,
    scenarioV2: parseScenarioV2(
      JSON.parse(readFileSync('scenarios/playtest/warehouse-expanded-r1.json', 'utf8')),
    ),
    coreConfig: parseCoreConfig(JSON.parse(readFileSync('config/game-core.json', 'utf8'))),
  };
}

test('every authored obstacle presentation places one useful hint after its explanation', () => {
  for (const locale of ['ja', 'en'] as const) {
    const snap = snapshot(locale);
    snap.scenarioV2.obstacles.forEach((obstacle, index) => {
      const guide = gimmickGuidance(snap, index)!;
      assert.equal(guide.obstacleId, obstacle.id);
      assert.equal(guide.explanation, obstacle.situationDisplay[locale]);
      assert.equal(guide.hint, obstacle.hints![0]![locale]);
      assert.ok(guide.text.indexOf(guide.explanation) < guide.text.indexOf(guide.hint));
      assert.match(guide.text, locale === 'ja' ? /\n\nヒント: / : /\n\nHint: /);
    });
  }
});

test('missing authored hint uses a current-obstacle fallback without another model call', () => {
  const snap = snapshot();
  delete snap.scenarioV2.obstacles[0]!.hints;
  const guide = gimmickGuidance(snap, 0)!;
  assert.match(guide.hint, /動かせそうな場所/);
  assert.doesNotMatch(guide.text, /マジックハンド|ドライバー/);
});

test('reapplying guidance replaces prior copies of the same current hint', () => {
  const snap = snapshot();
  const initial = gimmickGuidance(snap, 0, '現在の公開状態。')!;
  const repeated = gimmickGuidance(
    snap,
    0,
    `${initial.text}\n\n${initial.text.slice(initial.explanation.length + 2)}`,
  )!;
  assert.equal(repeated.explanation, '現在の公開状態。');
  assert.equal(repeated.text.split(initial.hint).length - 1, 1);
});

test('opening screen briefing includes the first explanation followed by its hint only', () => {
  const snap = snapshot();
  const briefing = storyOpeningBriefing(snap);
  const current = gimmickGuidance(snap, 0)!;
  assert.ok(briefing.includes(current.text));
  assert.ok(briefing.indexOf(current.explanation) < briefing.indexOf(current.hint));
  assert.ok(!briefing.includes(snap.scenarioV2.obstacles[1]!.hints![0]!.ja));
});
