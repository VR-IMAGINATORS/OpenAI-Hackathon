import { storyOpeningBriefing } from '../apps/local-server/story.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ScenarioCatalog } from '../apps/server/scenario-catalog.js';
import { buildPublicScene } from '../apps/local-server/public-scene.js';
import {
  inspectScene,
  scenePrompt,
  sceneRules,
  type SceneInput,
} from '../packages/server/image-service.js';
import type { AiService } from '../packages/server/ai-service.js';
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
  assert.doesNotMatch(JSON.stringify(sceneRules(input)), /PRIVATE ALL STATES/);
  assert.ok(sceneRules(input).some((rule) => rule.ruleId === 'current-obstacle'));
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
test('non-story legacy image rules and inspection instructions remain available', async () => {
  const input = fixture();
  delete input.snapshot.scenarioV2.investigation;
  assert.ok(sceneRules(input).length > 0);
  assert.match(scenePrompt(input, ''), /Current facts override/);
  const fakeAi = {
    config: { inspectionModel: 'fake' },
    mediaCall: async (_job: string, _epoch: number, _kind: string, body: any) => {
      assert.doesNotMatch(body.instructions, /current obstacle is the primary subject/i);
      assert.ok(!JSON.stringify(body.input).includes('current-obstacle'));
      return {
        status: 'completed',
        output: [
          {
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({ verdict: 'pass', contradictions: [] }),
              },
            ],
          },
        ],
      };
    },
  } as unknown as AiService;
  assert.equal((await inspectScene(fakeAi, 'job', 0, input, Buffer.from('image'))).verdict, 'pass');
});

test('in-progress investigation images show confirmed current state without past action details', () => {
  const input = fixture();
  input.action = {
    actionId: 'action-1',
    order: 1,
    obstacleId: input.facts.obstacleId,
    usage: 'lever the panel with scissors',
    items: [
      { id: 'scissors', name: 'scissors', beforeStatus: 'available', afterStatus: 'damaged' },
    ],
    beforeVersion: 0,
    afterVersion: 1,
    beforeFacts: { obstacleId: input.facts.obstacleId, values: { secret: 'PRIVATE BEFORE' } },
    afterFacts: { obstacleId: input.facts.obstacleId, values: { secret: 'PRIVATE AFTER' } },
    success: false,
    cleared: false,
    narrative: 'The panel is still shut. The scissors bent.',
  };
  const prompt = scenePrompt(input, 'PRIVATE INSPECTION FEEDBACK');
  const data = JSON.parse(prompt.slice(prompt.indexOf('{')));
  assert.equal(data.committedAction, null);
  assert.equal(data.scene.currentObstacle.state, 'blocked');
  assert.doesNotMatch(
    prompt,
    /PRIVATE|beforeValues|afterValues|LATER PUBLIC VISUAL|scissors|panel is still shut/,
  );
});

function progressedInput(scenarioPath: string, terminal = false): SceneInput {
  const snapshot = structuredClone(
    new ScenarioCatalog({
      scenarioPath,
      coreConfigPath: 'config/game-core.json',
      randomIndex: () => 0,
    }).current('ja'),
  );
  const obstacles = snapshot.scenarioV2.obstacles;
  const values = Object.fromEntries(
    snapshot.scenarioV2.core.facts.map((fact) => [fact.key, fact.initial]),
  );
  for (const obstacle of obstacles.slice(0, terminal ? obstacles.length : 2)) {
    const completion = obstacle.completionFact!;
    values[completion.key] = completion.value;
  }
  const current = obstacles[terminal ? obstacles.length - 1 : 2]!;
  const previous = obstacles[terminal ? obstacles.length - 1 : 1]!;
  return {
    playId: 'progressed',
    messageId: terminal ? 'terminal' : 'third-obstacle',
    snapshot,
    facts: { obstacleId: current.id, values },
    situation: 'PRIVATE CURRENT SITUATION',
    action: {
      actionId: 'previous-action',
      order: terminal ? 3 : 2,
      obstacleId: previous.id,
      usage: terminal ? 'FINAL_TOOL_USE' : 'PAST_TOOL_USE',
      items: [
        {
          id: 'tool',
          name: terminal ? 'FINAL_TOOL' : 'PAST_TOOL',
          beforeStatus: 'available',
          afterStatus: 'available',
        },
      ],
      beforeVersion: terminal ? 2 : 1,
      afterVersion: terminal ? 3 : 2,
      beforeFacts: { obstacleId: previous.id, values: structuredClone(values) },
      afterFacts: { obstacleId: current.id, values: structuredClone(values) },
      success: true,
      cleared: true,
      narrative: terminal ? 'FINAL_CONFIRMED_OPEN' : 'PAST_OPENED_OTHER_DOOR',
    },
  };
}

test('default three-stage still focuses the blocked final exit after the second clear', () => {
  const input = progressedInput('scenarios/playtest/warehouse-expanded-r1.json');
  const publicScene = buildPublicScene(input.snapshot, input.facts);
  assert.equal(publicScene.currentObstacle.id, 'gimmick-thermal-leak');
  assert.equal(publicScene.currentObstacle.state, 'blocked');
  assert.match(publicScene.currentObstacle.description, /出口.*金具.*閂/);
  const data = JSON.parse(scenePrompt(input, '').slice(scenePrompt(input, '').indexOf('{')));
  assert.equal(data.committedAction, null);
  assert.equal(data.scene.currentObstacle.id, 'gimmick-thermal-leak');
  assert.doesNotMatch(JSON.stringify(data), /PAST_TOOL|PAST_OPENED_OTHER_DOOR|内扉が手前へ開/);
  assert.match(JSON.stringify(data.rules), /blocked.*出口.*金具.*閂/);
});

test('in-progress public visuals exclude a matching visual from a previously cleared obstacle', () => {
  const input = progressedInput('scenarios/playtest/warehouse-expanded-r1.json');
  const scenario = input.snapshot.scenarioV2;
  const past = scenario.obstacles[0]!.completionFact!;
  scenario.investigation!.publicVisuals.push(
    {
      id: 'past-obstacle',
      description: loc('PAST_OBSTACLE_VISUAL'),
      prerequisites: [{ factKey: past.key, value: past.value }],
    },
    { id: 'global', description: loc('GLOBAL_VISUAL'), prerequisites: [] },
  );
  const prompt = scenePrompt(input, '');
  assert.doesNotMatch(prompt, /PAST_OBSTACLE_VISUAL/);
  assert.match(prompt, /GLOBAL_VISUAL/);
});

test('compiled catalog still uses only the current public obstacle state', () => {
  const input = progressedInput('scenarios/story-catalog.json');
  input.snapshot.scenarioV2.core.facts[2]!.visualDescription = 'PRIVATE ALL STATES';
  const prompt = scenePrompt(input, 'PRIVATE INSPECTION FEEDBACK');
  const data = JSON.parse(prompt.slice(prompt.indexOf('{')));
  assert.equal(data.scene.currentObstacle.id, 'gimmick-thermal-leak');
  assert.equal(data.scene.currentObstacle.state, 'blocked');
  assert.equal(data.committedAction, null);
  assert.equal(data.character, input.snapshot.scenarioV2.core.characterAppearance);
  assert.equal(data.style, input.snapshot.scenarioV2.core.visualStyle);
  assert.doesNotMatch(prompt, /PRIVATE|PAST_TOOL|PAST_OPENED_OTHER_DOOR|内扉が手前へ開/);
  assert.ok(sceneRules(input).every((rule) => rule.ruleId !== 'action:tools'));
});

test('partial current obstacle stays unresolved and omits its completed attempt details', () => {
  const input = progressedInput('scenarios/playtest/warehouse-expanded-r1.json');
  input.facts.values['gimmick-thermal-leak'] = 'partial';
  input.action = {
    ...input.action!,
    obstacleId: 'gimmick-thermal-leak',
    success: false,
    cleared: false,
    usage: 'PARTIAL_TOOL_USE',
    narrative: 'PARTIAL_ATTEMPT_NARRATIVE',
  };
  const prompt = scenePrompt(input, '');
  const data = JSON.parse(prompt.slice(prompt.indexOf('{')));
  assert.equal(data.scene.currentObstacle.state, 'partial');
  assert.match(data.scene.currentObstacle.description, /出口は開いていない/);
  assert.equal(data.committedAction, null);
  assert.doesNotMatch(prompt, /PARTIAL_TOOL_USE|PARTIAL_ATTEMPT_NARRATIVE/);
  assert.ok(
    data.rules.some((rule: { ruleId: string }) => rule.ruleId.startsWith('current:forbidden:')),
  );
});

test('terminal clear retains the confirmed final action and open-exit visual', () => {
  const input = progressedInput('scenarios/playtest/warehouse-expanded-r1.json', true);
  const first = input.snapshot.scenarioV2.obstacles[0]!.completionFact!;
  input.snapshot.scenarioV2.investigation!.publicVisuals.push({
    id: 'past-obstacle-at-terminal',
    description: loc('PAST_OBSTACLE_TERMINAL_VISUAL'),
    prerequisites: [{ factKey: first.key, value: first.value }],
  });
  const prompt = scenePrompt(input, '');
  const data = JSON.parse(prompt.slice(prompt.indexOf('{')));
  assert.equal(data.scene.currentObstacle.state, 'cleared');
  assert.ok(
    data.scene.visuals.some((visual: { id: string }) => visual.id === 'confirmed-open-exit'),
  );
  assert.equal(data.committedAction.obstacleId, 'gimmick-thermal-leak');
  assert.equal(data.committedAction.narrative, 'FINAL_CONFIRMED_OPEN');
  assert.match(prompt, /確認済みの最終出口/);
  assert.doesNotMatch(prompt, /PAST_OBSTACLE_TERMINAL_VISUAL/);
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
