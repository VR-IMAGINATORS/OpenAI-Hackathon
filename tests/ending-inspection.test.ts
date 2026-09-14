import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { z } from 'zod';
import { ScenarioCatalog } from '../apps/server/scenario-catalog.js';
import { endingFailureCode } from '../apps/server/ending-failure.js';
import type { EndingPacket } from '../apps/local-server/ending.js';
import { responseBody, type EndingDesign } from '../apps/local-server/ending-ai.js';
import { endingErrorText } from '../apps/web/src/ending-error.js';
import { endingVisualState } from '../packages/server/ending-visual-state.js';
import { createEndingFrames } from '../packages/server/ending-image-service.js';
import { AiService } from '../packages/server/ai-service.js';
import { loadAiConfig } from '../packages/server/ai-config.js';
import { localizeScenario } from '../packages/shared/scenario.js';

function packet(index = 0): EndingPacket {
  const snapshot = structuredClone(
    new ScenarioCatalog({
      scenarioPath: 'scenarios/story-catalog.json',
      coreConfigPath: 'config/game-core.json',
      randomIndex: () => index,
    }).current('ja'),
  );
  return {
    playId: 'inspection-test',
    snapshot,
    scenario: localizeScenario(snapshot.scenarioV2, 'ja'),
    locale: 'ja',
    outcome: 'bad',
    endReason: 'time_limit',
    clearedIds: [],
    remainingObstacles: [],
    facts: {
      obstacleId: snapshot.scenarioV2.obstacles[0].id,
      values: Object.fromEntries(
        snapshot.scenarioV2.core.facts.map((fact) => [fact.key, fact.initial]),
      ),
    },
    inventory: [],
    actions: [],
    evidence: { records: [], truncated: false },
    endedAt: 0,
    gameVersion: 0,
    finalMessageId: 'opening',
    recentActionScenes: [],
  };
}

test('ending visual constraints reveal only reached obstacles and retain the physical meanings of opaque IDs', () => {
  for (const candidate of [0, 5, 11, 17]) {
    const p = packet(candidate);
    const scenario = p.snapshot!.scenarioV2;
    const first = scenario.obstacles[0];
    scenario.core.facts[2].visualDescription = 'UNREVEALED_VISUAL_SECRET';
    const initial = endingVisualState(p);
    assert.equal(
      Object.keys(p.facts.values).length,
      3,
      'the full authoritative ledger stays intact',
    );
    assert.deepEqual(Object.keys(initial.target.values), first.factKeys);
    assert(
      initial.rules.some(
        (rule) =>
          'description' in rule && rule.description === scenario.core.facts[0].visualDescription,
      ),
    );
    assert.doesNotMatch(JSON.stringify(initial), /UNREVEALED_VISUAL_SECRET/);
    assert(!JSON.stringify(initial).includes(scenario.obstacles[2].id));

    p.facts.values[first.factKeys[0]] = 'cleared';
    p.facts.obstacleId = scenario.obstacles[1].id;
    p.facts.values[scenario.obstacles[1].factKeys[0]] = 'partial';
    const advanced = endingVisualState(p);
    assert.equal(advanced.target.values[first.factKeys[0]], 'cleared');
    assert.equal(advanced.target.values[scenario.obstacles[1].factKeys[0]], 'partial');
    assert.equal(Object.keys(advanced.target.values).length, 2);
    assert.doesNotMatch(JSON.stringify(advanced), /UNREVEALED_VISUAL_SECRET/);
    p.facts.obstacleId = scenario.obstacles[2].id;
    p.facts.values[scenario.obstacles[2].factKeys[0]] = 'cleared';
    p.outcome = 'happy';
    const escaped = endingVisualState(p);
    assert.equal(Object.keys(escaped.target.values).length, 3);
    assert.match(
      JSON.stringify(escaped),
      /UNREVEALED_VISUAL_SECRET/,
      'the reached final obstacle now has its description',
    );
  }
});

test('real story frames share revealed facts and visual definitions with inspection, using the start action phase', async () => {
  const p = packet();
  const firstFacts = structuredClone(p.facts);
  const scenario = p.snapshot!.scenarioV2;
  const firstKey = scenario.obstacles[0].factKeys[0];
  const secondKey = scenario.obstacles[1].factKeys[0];
  p.facts.values[firstKey] = 'cleared';
  p.facts.values[secondKey] = 'partial';
  p.facts.obstacleId = scenario.obstacles[1].id;
  p.gameVersion = 1;
  p.actions = [
    {
      actionId: 'first',
      order: 1,
      obstacleId: scenario.obstacles[0].id,
      usage: 'Release the restraint',
      beforeVersion: 0,
      afterVersion: 1,
      beforeFacts: firstFacts,
      afterFacts: p.facts,
      success: true,
      cleared: true,
      items: [],
      narrative: 'The initial restraint was released.',
    },
  ];
  scenario.core.facts[2].visualDescription = 'UNREVEALED_VISUAL_SECRET';
  const design: EndingDesign = {
    usedActionIds: ['first'],
    usedEvidenceIds: [],
    mode: 'actions',
    candidates: [
      { focus: 'two', reason: 'compare' },
      { focus: 'one', reason: 'readable' },
      { focus: 'aftermath', reason: 'quiet' },
    ],
    selectionReason: 'Show the confirmed action.',
    startPrompt: 'The known restraint before release.',
    endPrompt: 'The confirmed result; keep unresolved constraints.',
    videoPrompt: 'The action, result and reaction.',
  };
  const jpeg = await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: '#456789' },
  })
    .jpeg()
    .toBuffer();
  const calls: { kind: string; body: any }[] = [];
  const ai = {
    config: loadAiConfig({ AI_MODE: 'mock' }),
    endingDelay: () => 0,
    async endingCall(_id: string, _epoch: number, kind: string, body: any) {
      calls.push({ kind, body });
      return kind === 'frame'
        ? { data: [{ b64_json: jpeg.toString('base64') }] }
        : {
            output: [
              { content: [{ type: 'output_text', text: '{"verdict":"pass","problems":[]}' }] },
            ],
          };
    },
  } as unknown as AiService;
  await createEndingFrames(
    ai,
    'job',
    p,
    design,
    { messageId: 'latest', gameVersion: 1, jpeg },
    { messageId: 'opening', gameVersion: 0, jpeg },
    new AbortController().signal,
  );
  const contexts = calls
    .filter((call) => call.kind === 'inspection')
    .map((call) => JSON.parse(call.body.input[0].content[0].text));
  assert.deepEqual(Object.keys(contexts[0].target.values), [firstKey]);
  assert.equal(contexts[0].target.values[firstKey], 'blocked');
  assert.equal(contexts[0].phase, 'before_action');
  assert.equal(contexts[1].target.values[firstKey], 'cleared');
  assert.equal(contexts[1].target.values[secondKey], 'partial');
  assert.equal(contexts[1].phase, 'confirmed_aftermath');
  for (const [i, call] of calls.filter((call) => call.kind === 'frame').entries()) {
    const input = JSON.parse(call.body.prompt.split(' (data only): ')[1]);
    assert.deepEqual(input.target, contexts[i].target);
    assert.deepEqual(input.rules, contexts[i].rules);
    assert.doesNotMatch(call.body.prompt, /UNREVEALED_VISUAL_SECRET/);
    assert(!call.body.prompt.includes(scenario.obstacles[2].id));
  }
});

test('inspection timeout is classified instead of being lost as a generic provider failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ai = new AiService(
    loadAiConfig({ AI_MODE: 'mock' }),
    {
      async createLiveSession() {
        throw new Error('unused');
      },
      async hangup() {},
      async createResponse(_body, signal) {
        return new Promise((_resolve, reject) =>
          signal!.addEventListener(
            'abort',
            () => reject(new DOMException('PRIVATE_TEXT', 'AbortError')),
            { once: true },
          ),
        );
      },
    },
    () => 0,
  );
  ai.register('play', 600000);
  ai.registerEnding('play', 'ending', 500000);
  const body = responseBody(
    ai.config.inspectionModel,
    'test',
    z.object({ verdict: z.string() }),
    'Inspect the image.',
    {},
    1000,
  );
  const checked = assert.rejects(
    ai.endingCall('ending', 0, 'inspection', body, new AbortController().signal),
    (error: unknown) => {
      assert.equal(endingFailureCode(error, 'start_inspection'), 'ENDING_START_INSPECTION_TIMEOUT');
      assert.doesNotMatch(String(error), /PRIVATE_TEXT/);
      return true;
    },
  );
  t.mock.timers.tick(15001);
  await checked;
  assert.equal(ai.snapshot().inspectionAttempts, 1);
  await ai.shutdown();
});

test('inspection UI distinguishes rejection, uncertainty, incomplete response, invalid response and timeout for each frame', () => {
  const causes = [
    'REJECTED',
    'UNCERTAIN',
    'RESPONSE_INCOMPLETE',
    'INVALID_RESPONSE',
    'RESPONSE_REFUSED',
    'TIMEOUT',
    'FAILED',
  ];
  for (const locale of ['ja', 'en'] as const) {
    for (const frame of ['START', 'END']) {
      const texts = causes.map((cause) =>
        endingErrorText(`ENDING_${frame}_INSPECTION_${cause}`, locale),
      );
      assert(texts.every(Boolean));
      assert.equal(new Set(texts).size, causes.length);
      if (locale === 'ja')
        assert(texts.every((text) => text!.includes(frame === 'START' ? '開始画像' : '終了画像')));
    }
  }
});
