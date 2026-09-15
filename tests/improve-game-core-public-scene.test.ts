import { storyOpeningBriefing } from '../apps/local-server/story.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ScenarioCatalog } from '../apps/server/scenario-catalog.js';
import { buildPublicScene } from '../apps/local-server/public-scene.js';
import { scenePrompt, sceneRules, type SceneInput } from '../packages/server/image-service.js';
import { GameHarness } from '../apps/local-server/game-harness.js';
import { GameSession } from '../apps/local-server/game.js';
import { localizeScenario } from '../packages/shared/scenario.js';

const loc = (text: string) => ({ ja: text, en: text });
function fixture(): SceneInput {
  const snapshot = structuredClone(
    new ScenarioCatalog({
      scenarioPath: 'scenarios/mobile-playtest.json',
      coreConfigPath: 'config/game-core.json',
    }).current('ja'),
  );
  const first = snapshot.scenarioV2.core.facts[0]!;
  snapshot.scenarioV2.investigation = {
    initialOverview: loc('PUBLIC OVERVIEW'),
    knowledgeMetadata: [],
    ambienceSlots: [],
    publicVisuals: [
      {
        id: 'initial',
        description: loc('PUBLIC INITIAL VISUAL'),
        prerequisites: [{ factKey: first.key, value: first.initial }],
      },
      {
        id: 'later',
        description: loc('LATER PUBLIC VISUAL'),
        prerequisites: [
          { factKey: first.key, value: first.values.find((value) => value !== first.initial)! },
        ],
      },
    ],
    sourceRef: { sourceDigest: 'a'.repeat(64), candidateId: 'test-candidate', revision: 1 },
  };
  return {
    playId: 'test',
    messageId: 'initial',
    snapshot,
    situation: 'PRIVATE NARRATION',
    facts: {
      obstacleId: snapshot.scenarioV2.obstacles[0]!.id,
      values: Object.fromEntries(snapshot.scenarioV2.core.facts.map((f) => [f.key, f.initial])),
    },
  };
}
test('expanded image prompt uses public scene only, excluding all-state descriptions and retry prose', () => {
  const input = fixture();
  const scenario = input.snapshot.scenarioV2;
  scenario.setting.location = 'PRIVATE LOCATION';
  scenario.core.characterAppearance = 'PRIVATE APPEARANCE';
  scenario.core.visualStyle = 'PRIVATE STYLE';
  for (const fact of scenario.core.facts) fact.visualDescription = 'PRIVATE ALL STATES';
  for (const entry of scenario.knowledge) entry.localizedText = loc('PRIVATE KNOWLEDGE');
  if (scenario.story) scenario.story.openingClue = loc('PRIVATE OPENING CLUE');
  const prompt = scenePrompt(input, 'PRIVATE INSPECTION FEEDBACK');
  const briefing = storyOpeningBriefing(input.snapshot);
  assert.match(briefing, /PUBLIC OVERVIEW/);
  assert.doesNotMatch(briefing, /PRIVATE|LATER PUBLIC VISUAL/);
  assert.doesNotMatch(prompt, /PRIVATE|LATER PUBLIC VISUAL/);
  assert.match(prompt, /PUBLIC OVERVIEW|PUBLIC INITIAL VISUAL/);
  assert.equal(JSON.parse(prompt.slice(prompt.indexOf('{'))).retry, true);
  assert.match(JSON.stringify(sceneRules(input)), /PRIVATE ALL STATES/); // Inspector retains the established rules; generation never receives them.
});
test('public scene resolves committed current values without exposing prerequisite keys or future states', () => {
  const input = fixture();
  const first = input.snapshot.scenarioV2.core.facts[0]!;
  input.facts.values[first.key] = first.values.find((value) => value !== first.initial)!;
  const publicScene = buildPublicScene(input.snapshot, input.facts);
  assert.equal(publicScene.overview, '');
  assert.deepEqual(publicScene.visuals, [{ id: 'later', description: 'LATER PUBLIC VISUAL' }]);
  assert.doesNotMatch(JSON.stringify(publicScene), /prerequisites|factKey|PUBLIC INITIAL/);
});
test('legacy image rules remain available without investigation metadata', () => {
  const input = fixture();
  delete input.snapshot.scenarioV2.investigation;
  assert.ok(sceneRules(input).length > 0);
  assert.match(scenePrompt(input, ''), /Current facts override/);
});

test('consultation advances the real game clock while a frozen evaluation clock ignores API delay', async () => {
  for (const frozen of [false, true]) {
    const { snapshot } = fixture();
    delete snapshot.scenarioV2.investigation;
    let elapsed = 0;
    const now = () => (frozen ? 0 : elapsed);
    let resolve!: (value: unknown) => void;
    const pending = new Promise<unknown>((done) => {
      resolve = done;
    });
    const game = new GameSession(
      localizeScenario(snapshot.scenarioV2, 'ja'),
      {
        recognize: async () => {
          throw new Error('unused');
        },
        judge: async () => {
          throw new Error('unused');
        },
      },
      now,
      () => {},
      snapshot,
    );
    game.heartbeat('connected');
    game.start();
    const harness = new GameHarness({
      game,
      snapshot,
      model: 'test',
      now,
      client: {
        respond: async (body) => {
          const request = body as any;
          if (request.text.format.name === 'knowledge_selection')
            return {
              output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ids":[]}' }] }],
            };
          return pending;
        },
      },
    });
    harness.ledger.append({
      eventId: 'ask',
      generation: game.generation,
      speaker: 'user',
      delta: 'What is happening?',
      startMs: 0,
      endMs: 1,
    });
    harness.sync();
    const context = harness.ledger.captureUnconsumedContext();
    const before = game.state().remainingMs;
    const request = harness.handleRequest(context);
    elapsed = 2000;
    assert.equal(game.state().remainingMs, before - (frozen ? 0 : 2000));
    assert.equal(game.clock.paused, false);
    resolve({
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                decision: {
                  kind: 'consult',
                  evidenceSeq: context.eligibleEvidenceSeq,
                  reason: 'private',
                  answer: 'public answer',
                },
              }),
            },
          ],
        },
      ],
    });
    const result = await request;
    assert.deepEqual(result.committedPublicEvents, []);
    assert.equal(game.state().remainingMs, before - (frozen ? 0 : 2000));
  }
});
