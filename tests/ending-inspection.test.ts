import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { z } from 'zod';
import { ScenarioCatalog } from '../apps/server/scenario-catalog.js';
import { endingFailureCode } from '../apps/server/ending-failure.js';
import type { EndingPacket } from '../apps/local-server/ending.js';
import {
  createEndingDesign,
  responseBody,
  type EndingDesign,
} from '../apps/local-server/ending-ai.js';
import { endingErrorText } from '../apps/web/src/ending-error.js';
import { endingVisualState } from '../packages/server/ending-visual-state.js';
import { createEndingFrames } from '../packages/server/ending-image-service.js';
import { AiService } from '../packages/server/ai-service.js';
import { loadAiConfig } from '../packages/server/ai-config.js';
import { localizeScenario } from '../packages/shared/scenario.js';
import { endingImageRequest, endingResponseRequest } from '../packages/server/ending-ai-request.js';
import { parseStoryCatalog, storyCandidateCount } from '../packages/shared/story-catalog.js';
import { readFileSync } from 'node:fs';

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
    actionScenes: [],
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
    itemCoverage: [],
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
    endingImageRequest.parse(call.body);
    const input = JSON.parse(call.body.prompt.split(' (data only): ')[1]);
    assert.deepEqual(input.target, contexts[i].target);
    assert.deepEqual(input.rules, contexts[i].rules);
    assert.doesNotMatch(call.body.prompt, /UNREVEALED_VISUAL_SECRET/);
    assert(!call.body.prompt.includes(scenario.obstacles[2].id));
    assert.match(call.body.prompt, /An empty inventory does not mean an empty room/);
  }
  for (const call of calls.filter((c) => c.kind === 'inspection')) {
    endingResponseRequest.parse(call.body);
    assert.match(call.body.instructions, /An empty inventory does not mean an empty room/);
    assert.match(
      call.body.instructions,
      /Do not grant those background objects a new usable function/,
    );
    assert.match(
      call.body.instructions,
      /a still-required restraint disappearing or an unearned open exit/,
    );
  }
});

const candidateCount = storyCandidateCount(
  parseStoryCatalog(JSON.parse(readFileSync('scenarios/story-catalog.json', 'utf8'))),
);

test('aftermath applies confirmed changes to an old opening and bases the end on the accepted current start', async () => {
  const jpeg = async (color: string) =>
    sharp({ create: { width: 1024, height: 1024, channels: 3, background: color } })
      .jpeg()
      .toBuffer();
  const opening = await jpeg('#334455'),
    current = await jpeg('#775533');
  for (const outcome of ['normal', 'happy'] as const) {
    const p = packet();
    p.outcome = outcome;
    p.gameVersion = outcome === 'happy' ? 3 : 2;
    const obstacles = p.snapshot!.scenarioV2.obstacles;
    p.facts.obstacleId = obstacles[2].id;
    for (const obstacle of obstacles.slice(0, p.gameVersion))
      for (const key of obstacle.factKeys) p.facts.values[key] = 'cleared';
    const calls: { kind: string; body: any }[] = [];
    const ai = {
      config: loadAiConfig({ AI_MODE: 'mock' }),
      endingDelay: () => 0,
      async endingCall(_id: string, _epoch: number, kind: string, body: any) {
        calls.push({ kind, body });
        if (kind === 'frame') {
          endingImageRequest.parse(body);
          return { data: [{ b64_json: current.toString('base64') }] };
        }
        endingResponseRequest.parse(body);
        return {
          output: [
            { content: [{ type: 'output_text', text: '{"verdict":"pass","problems":[]}' }] },
          ],
        };
      },
    } as unknown as AiService;
    const design: EndingDesign = {
      usedActionIds: [],
      itemCoverage: [],
      usedEvidenceIds: [],
      mode: 'aftermath',
      candidates: [
        { focus: 'two', reason: 'unavailable' },
        { focus: 'one', reason: 'unavailable' },
        { focus: 'aftermath', reason: 'confirmed state' },
      ],
      selectionReason: 'The opening predates the final outcome.',
      startPrompt: 'The confirmed outcome.',
      endPrompt: 'A backward glance; leave the lower right empty before title compositing.',
      videoPrompt: 'The confirmed outcome and reaction.',
    };
    const frames = await createEndingFrames(
      ai,
      'job',
      p,
      design,
      { messageId: 'opening', gameVersion: 0, jpeg: opening },
      undefined,
      new AbortController().signal,
    );
    const edits = calls.filter((c) => c.kind === 'frame');
    assert.deepEqual(edits[0].body.images, [opening]);
    assert.deepEqual(edits[1].body.images, [frames.start]);
    assert.notDeepEqual(frames.start, opening);
    assert.match(edits[0].body.prompt, /Recompose the whole scene/);
    assert.doesNotMatch(edits[1].body.prompt, /This source image predates/);
    assert.match(edits[1].body.prompt, /replace any proposed backward glance/);
    for (const edit of edits) {
      if (outcome === 'happy')
        assert.match(edit.body.prompt, /person and BOTH feet are beyond that threshold/);
      else assert.doesNotMatch(edit.body.prompt, /Make completed escape visually unambiguous/);
    }
    const checks = calls
      .filter((c) => c.kind === 'inspection')
      .map((c) => JSON.parse(c.body.input[0].content[0].text));
    assert.deepEqual(
      checks.map((c) => c.referenceGameVersion),
      [0, p.gameVersion],
    );
    assert(checks.every((c) => c.targetGameVersion === p.gameVersion));
    assert(
      checks.every((c) => JSON.stringify(c.target) === JSON.stringify(endingVisualState(p).target)),
    );
  }
});

for (let candidate = 0; candidate < candidateCount; candidate++) {
  test(`catalog ending ${candidate}: every progress stage preserves visible physical state with incomplete image history`, async () => {
    // Real catalog data with a stubbed director: verifies request contracts and state
    // selection, not generated image quality. Live comparisons are recorded separately.
    const p = packet(candidate);
    const scenario = p.snapshot!.scenarioV2;
    const jpeg = await sharp({
      create: { width: 16, height: 16, channels: 3, background: '#444444' },
    })
      .jpeg()
      .toBuffer();
    for (const locale of ['ja', 'en'] as const) {
      p.locale = locale;
      for (let cleared = 0; cleared <= 3; cleared++) {
        for (const partial of cleared === 3 ? [false] : [false, true]) {
          p.clearedIds = scenario.obstacles.slice(0, cleared).map((o) => o.id);
          p.outcome = cleared === 3 ? 'happy' : cleared === 2 ? 'normal' : 'bad';
          const active = Math.min(cleared, 2);
          p.facts = {
            obstacleId: scenario.obstacles[active].id,
            values: Object.fromEntries(
              scenario.obstacles.flatMap((o, i) =>
                o.factKeys.map((key) => [
                  key,
                  i < cleared ? 'cleared' : i === active && partial ? 'partial' : 'blocked',
                ]),
              ),
            ),
          };
          p.gameVersion = cleared + (partial ? 1 : 0);
          p.inventory = partial
            ? [
                {
                  id: 'tool',
                  name: 'damaged tool',
                  description: 'Damaged in the committed attempt.',
                  status: 'damaged',
                },
              ]
            : [];
          p.actions = [];
          const before = packet(candidate).facts;
          for (let i = 0; i < p.gameVersion; i++) {
            const after = structuredClone(before);
            const obstacle = scenario.obstacles[Math.min(i, 2)];
            const success = i < cleared;
            for (const key of obstacle.factKeys)
              after.values[key] = success ? 'cleared' : 'partial';
            p.actions.push({
              actionId: `action-${i}`,
              order: i + 1,
              obstacleId: obstacle.id,
              usage: 'Use the tool on the current obstacle.',
              items:
                partial && !success
                  ? [
                      {
                        id: 'tool',
                        name: 'damaged tool',
                        beforeStatus: 'available',
                        afterStatus: 'damaged',
                      },
                    ]
                  : [],
              beforeVersion: i,
              afterVersion: i + 1,
              beforeFacts: structuredClone(before),
              afterFacts: after,
              success,
              cleared: success,
              narrative: success
                ? 'The current obstacle was cleared.'
                : 'Partial progress; the tool was damaged and the obstacle was not cleared.',
            });
            Object.assign(before, structuredClone(after));
            if (success && i < 2) before.obstacleId = scenario.obstacles[i + 1].id;
          }
          const visual = endingVisualState(p);
          assert.deepEqual(
            Object.keys(visual.target.values),
            scenario.obstacles.slice(0, active + 1).flatMap((o) => o.factKeys),
          );
          for (const rule of visual.rules)
            if (rule.ruleId.startsWith('fact:')) {
              assert('description' in rule && 'value' in rule);
              const key = rule.ruleId.slice(5);
              assert.equal(rule.value, p.facts.values[key]);
              assert.equal(
                rule.description,
                scenario.core.facts.find((f) => f.key === key)!.visualDescription,
              );
            }
          for (const history of [
            'opening-only',
            'latest-without-before',
            'latest-with-before',
          ] as const) {
            const final = {
              messageId: 'source',
              gameVersion: history === 'opening-only' ? 0 : p.gameVersion,
              jpeg,
            };
            const first = p.actions.slice(-2)[0];
            const previous =
              history === 'latest-with-before' && first
                ? { messageId: 'previous', gameVersion: first.beforeVersion, jpeg }
                : undefined;
            const expectedReplay = !!previous && p.gameVersion > 0;
            const ai = {
              config: loadAiConfig({ AI_MODE: 'mock' }),
              endingDelay: () => 0,
              async endingCall(_job: string, _epoch: number, kind: string, body: any) {
                assert.equal(kind, 'direction');
                endingResponseRequest.parse(body);
                const input = JSON.parse(body.input[0].content[0].text);
                assert.deepEqual(input.visualState, visual);
                assert.deepEqual(input.inventory, p.inventory);
                assert.deepEqual(
                  input.allowedModes,
                  expectedReplay ? ['actions', 'aftermath'] : ['aftermath'],
                );
                assert.match(body.instructions, /not every object in the room/);
                const output: EndingDesign = {
                  usedEvidenceIds: [],
                  usedActionIds: expectedReplay ? [first.actionId] : [],
                  itemCoverage: partial
                    ? [
                        {
                          itemId: 'tool',
                          actionId: p.actions.at(-1)!.actionId,
                          shot: 1,
                          depiction: 'trace',
                          reason: 'Keep the confirmed tool damage.',
                        },
                      ]
                    : [],
                  mode: expectedReplay ? 'actions' : 'aftermath',
                  candidates: [
                    { focus: 'two', reason: 'compare' },
                    { focus: 'one', reason: 'compare' },
                    { focus: 'aftermath', reason: 'compare' },
                  ],
                  selectionReason: 'Supported reference and confirmed state.',
                  startPrompt: 'Keep the confirmed physical state.',
                  endPrompt: 'Keep the confirmed physical state.',
                  videoPrompt:
                    '[Shot 1] Confirmed outcome and reaction with damaged tool when present.',
                };
                return {
                  output: [{ content: [{ type: 'output_text', text: JSON.stringify(output) }] }],
                };
              },
            } as unknown as AiService;
            const design = await createEndingDesign(
              ai,
              'test',
              p,
              final,
              previous,
              new AbortController().signal,
              undefined,
            );
            assert.equal(design.mode, expectedReplay ? 'actions' : 'aftermath');
          }
        }
      }
    }
  });
}

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
