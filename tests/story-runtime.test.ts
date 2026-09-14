import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseScenarioV2, localizeScenario, type ScenarioV2 } from '../packages/shared/scenario.js';
import {
  compileStoryScenario,
  parseStoryCatalog,
  storyCandidateCount,
} from '../packages/shared/story-catalog.js';
import { parseCoreConfig } from '../packages/shared/core-config.js';
import type { ScenarioSnapshot } from '../apps/server/scenario-catalog.js';
import { GameSession } from '../apps/local-server/game.js';
import { createGameAI, type CoreJudgment } from '../apps/local-server/game-ai.js';
import { GameRuntime } from '../apps/local-server/hosted-runtime.js';
import { classifyCoreIntent } from '../apps/local-server/core-intent-ai.js';
import { ConversationLedger } from '../apps/local-server/conversation.js';
import { liveInstructions, factCommands } from '../apps/local-server/live.js';
import {
  storyClearCount,
  storyContext,
  storyOpening,
  storyHint,
} from '../apps/local-server/story.js';
import {
  scenePrompt,
  sceneRules,
  inspectScene,
  type SceneInput,
} from '../packages/server/image-service.js';
import { PhotoQueue } from '../apps/server/photo-queue.js';
import { AiService } from '../packages/server/ai-service.js';
import { loadAiConfig } from '../packages/server/ai-config.js';

const localized = (ja: string, en = ja) => ({ ja, en });
const base = parseScenarioV2(JSON.parse(readFileSync('scenarios/mobile-playtest.json', 'utf8')));
const coreConfig = parseCoreConfig(JSON.parse(readFileSync('config/game-core.json', 'utf8')));
function snapshot(locale: 'ja' | 'en' = 'ja', scenario?: ScenarioV2): ScenarioSnapshot {
  const value = structuredClone(scenario ?? base);
  if (!scenario) {
    value.story = {
      aiName: localized('メイ', 'Mei'),
      world: localized(
        '一週間後から電話している。写真から道具を作れる。',
        'I’m calling from one week ahead. Your photos can become tools here.',
      ),
      mystery: localized('PRIVATE_MYSTERY_DIRECTION'),
      openingClue: localized('壁に昨日の日付がある。', 'Yesterday’s date is on the wall.'),
      phases: {
        opening: localized('序盤の問い', 'opening direction'),
        middle: localized('中盤の問い', 'middle direction'),
        final: localized('終盤の問い', 'final direction'),
      },
    };
    value.obstacles.forEach((obstacle, index) => {
      const key = `puzzle-${index}`;
      obstacle.factKeys = [key];
      obstacle.completionFact = { key, value: 'cleared' };
      obstacle.mechanism = localized(`PRIVATE_MECHANISM_${index}`);
      obstacle.hints = [localized(`HINT_${index}_1`), localized(`HINT_${index}_2`)];
      obstacle.requiredVisualFacts = [
        { key, value: 'blocked' },
        { key, value: 'cleared' },
      ];
      obstacle.forbiddenVisualChanges = [{ key, from: 'blocked', to: 'cleared' }];
    });
    value.core.facts = value.obstacles.map((obstacle, index) => ({
      key: obstacle.factKeys[0],
      initial: 'blocked',
      values: ['blocked', 'partial', 'cleared'],
      allowedTransitions: [
        { from: 'blocked', to: 'partial' },
        { from: 'blocked', to: 'cleared' },
        { from: 'partial', to: 'cleared' },
      ],
      visualDescription: `VISIBLE_PUZZLE_${index}`,
    }));
  }
  return { digest: 'runtime-test', createdAt: 0, locale, scenarioV2: value, coreConfig };
}
const response = (value: unknown) => ({
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
});
function context(text: string) {
  const ledger = new ConversationLedger({ generation: 1 });
  ledger.append({
    eventId: randomUUID(),
    generation: 1,
    speaker: 'user',
    delta: text,
    startMs: 1,
    endMs: 2,
  });
  return ledger.captureUnconsumedContext();
}
function fixture(
  snap: ScenarioSnapshot,
  judgments: Array<Pick<CoreJudgment, 'success' | 'factChanges'>>,
) {
  const game = new GameSession(
    localizeScenario(snap.scenarioV2, snap.locale),
    {
      recognize: async () => ({ items: [], summary: 'test', usage: '' }),
      judge: async () => ({
        ...judgments.shift()!,
        narrative: '確定した変化。',
        situation: '変化後の現在状況。',
        shortReason: '道具の物性による変化。',
        inventoryChanges: [],
      }),
    },
    () => 0,
    () => {},
    snap,
  );
  game.inventory = [
    { id: randomUUID(), name: '道具', description: 'ordinary tool', status: 'available' },
  ];
  game.heartbeat('connected');
  game.start();
  let sequence = 0;
  const act = () =>
    game.judgeAction(
      game.reserveAction(
        {
          kind: 'execute',
          evidenceSeq: [++sequence],
          itemRefs: [{ inventoryId: game.inventory[0].id }],
          usage: '道具を使って',
          reason: '明示指示',
        },
        game.currentContextVersion,
        game.gameVersion,
        game.actionEpoch,
        game.controllerEpoch,
      ),
    );
  return { game, act };
}

test('story clear phases follow committed facts, including the last available action; partial progress keeps its phase and tool', async () => {
  const snap = snapshot();
  const { game, act } = fixture(snap, [
    { success: false, factChanges: [{ key: 'puzzle-0', from: 'blocked', to: 'partial' }] },
    { success: true, factChanges: [{ key: 'puzzle-0', from: 'partial', to: 'cleared' }] },
    { success: true, factChanges: [{ key: 'puzzle-1', from: 'blocked', to: 'cleared' }] },
    { success: true, factChanges: [{ key: 'puzzle-2', from: 'blocked', to: 'cleared' }] },
  ]);
  const phase = () => storyContext(snap, storyClearCount(snap, game.facts))?.phase;
  assert.equal(phase(), 'opening');
  const itemId = game.inventory[0].id;
  await act();
  assert.equal(phase(), 'opening');
  assert.equal(game.facts.values['puzzle-0'], 'partial');
  assert.equal(game.inventory[0].id, itemId);
  await act();
  assert.equal(phase(), 'middle');
  assert.equal(game.situation, snap.scenarioV2.obstacles[1].situationDisplay.ja);
  await act();
  assert.equal(phase(), 'final');
  await act();
  assert.equal(game.status, 'won');
  assert.equal(game.actionsUsed, 4);
  assert.equal(storyClearCount(snap, game.facts), 3);
});

for (const judgment of [
  { success: true, factChanges: [] },
  { success: true, factChanges: [{ key: 'puzzle-0', from: 'blocked', to: 'partial' }] },
  { success: false, factChanges: [{ key: 'puzzle-0', from: 'blocked', to: 'cleared' }] },
  {
    success: true,
    factChanges: [
      { key: 'puzzle-0', from: 'blocked', to: 'cleared' },
      { key: 'puzzle-1', from: 'blocked', to: 'cleared' },
    ],
  },
])
  test(
    'story rejects inconsistent or future completion atomically: ' + JSON.stringify(judgment),
    async () => {
      const { game, act } = fixture(snapshot(), [judgment]);
      await assert.rejects(act(), /ACTION_FAILED/);
      assert.equal(game.actionsUsed, 0);
      assert.equal(game.gameVersion, 0);
      assert.equal(game.facts.values['puzzle-0'], 'blocked');
      assert.equal(game.facts.values['puzzle-1'], 'blocked');
    },
  );

test('all 18 story routes expose player objectives in both languages through each committed stage', async () => {
  const catalog = parseStoryCatalog(
    JSON.parse(readFileSync('scenarios/story-catalog.json', 'utf8')),
  );
  for (let index = 0; index < storyCandidateCount(catalog); index++) {
    const scenario = compileStoryScenario(catalog, index);
    for (const locale of ['ja', 'en'] as const) {
      const { game, act } = fixture(
        snapshot(locale, scenario),
        scenario.obstacles.map((obstacle) => ({
          success: true,
          factChanges: [{ key: obstacle.id, from: 'blocked', to: 'cleared' }],
        })),
      );
      for (const [stage, obstacle] of scenario.obstacles.entries()) {
        const gimmick = catalog.gimmicks.find((entry) => entry.id === obstacle.id)!;
        const visible = game.state().obstacle;
        assert.equal(visible.index, stage);
        assert.equal(visible.title, gimmick.objective[locale], `${index}/${locale}/${stage}`);
        assert.notEqual(
          visible.title,
          gimmick.name[locale],
          'a noun-only obstacle name is not an objective',
        );
        assert.notEqual(
          visible.title,
          obstacle.goal,
          'internal solutions are not a public objective',
        );
        await act();
      }
      assert.equal(game.status, 'won');
    }
  }
});

test('all ten imported gimmicks accept a retained partial state followed by a complete clear', async () => {
  const catalog = parseStoryCatalog(
    JSON.parse(readFileSync('scenarios/story-catalog.json', 'utf8')),
  );
  const seen = new Set<string>();
  for (let index = 0; index < storyCandidateCount(catalog); index++) {
    const scenario = compileStoryScenario(catalog, index);
    for (const obstacle of scenario.obstacles) {
      if (seen.has(obstacle.id)) continue;
      seen.add(obstacle.id);
      const value = structuredClone(scenario);
      value.obstacles = [obstacle];
      value.events = [];
      const completion = obstacle.completionFact!;
      const { game, act } = fixture(snapshot('ja', value), [
        { success: false, factChanges: [{ key: completion.key, from: 'blocked', to: 'partial' }] },
        {
          success: true,
          factChanges: [{ key: completion.key, from: 'partial', to: completion.value }],
        },
      ]);
      await act();
      assert.equal(game.facts.values[completion.key], 'partial', obstacle.id);
      assert.equal(storyClearCount(snapshot('ja', value), game.facts), 0);
      await act();
      assert.equal(game.status, 'won', obstacle.id);
      assert.equal(game.facts.values[completion.key], completion.value);
    }
  }
  assert.equal(seen.size, 10);
});

for (const locale of ['ja', 'en'] as const)
  test('story opening is visible, localized and includes the clue: ' + locale, async (t) => {
    const snap = snapshot(locale);
    const config = loadAiConfig({ AI_MODE: 'mock' });
    let livePrompt = '';
    const ai = new AiService(
      config,
      {
        async createLiveSession(body) {
          livePrompt = (body as { session: { instructions: string } }).session.instructions;
          return { session: { id: 'story-live' }, transport: { type: 'webrtc', sdp: 'answer' } };
        },
        async hangup() {},
        async createResponse() {
          throw new Error('No additional AI call expected');
        },
      },
      () => 0,
    );
    const scenes: Array<{ text: string }> = [];
    const runtime = new GameRuntime(
      randomUUID(),
      600000,
      localizeScenario(snap.scenarioV2, locale),
      ai,
      config,
      new PhotoQueue(),
      () => 0,
      snap,
      {
        transcript() {},
        async photos() {},
        scene(scene) {
          scenes.push(scene);
        },
        ended() {},
      },
    );
    t.after(async () => {
      runtime.dispose();
      await runtime.close();
    });
    await runtime.live(randomUUID(), 'offer');
    runtime.heartbeat('connected');
    const expected = storyOpening(snap, runtime.game.situation);
    assert.equal(scenes[0].text, expected);
    assert.ok(expected.includes(snap.scenarioV2.story!.aiName[locale]));
    assert.ok(expected.includes(snap.scenarioV2.story!.openingClue[locale]));
    assert.ok(livePrompt.includes(expected));
    assert.ok(!expected.includes('PRIVATE_MYSTERY_DIRECTION'));
    assert.ok(!expected.includes('PRIVATE_MECHANISM'));
    assert.ok(!livePrompt.includes('HINT_'));
    assert.ok(factCommands(expected).every((command) => Buffer.byteLength(command.content) <= 480));
  });

test('lore and ordinary consultation receive only public story; hints are opt-in, staged and current only', async () => {
  const snap = snapshot();
  for (const text of [
    'なぜ未来から電話しているの？',
    'この道具は使えそう？',
    'ヒントはいらない',
    '未来から連絡できる理由が分からない',
    'What does that clue mean?',
    'Don’t give me a hint',
  ]) {
    assert.equal(storyHint(snap, 0, context(text)), undefined);
    await classifyCoreIntent({
      snapshot: snap,
      model: 'fake',
      conversation: context(text),
      photos: [],
      obstacleIndex: 0,
      game: {
        status: 'playing',
        publicState: { story: storyContext(snap, 0), situation: 'visible state' },
      },
      respond: async (body: any) => {
        const prompt = JSON.stringify(body);
        assert.ok(prompt.includes(snap.scenarioV2.story!.world.ja));
        assert.ok(!prompt.includes('PRIVATE_MYSTERY_DIRECTION'));
        assert.ok(!prompt.includes('PRIVATE_MECHANISM'));
        assert.ok(!prompt.includes('HINT_'));
        return response({
          decision: {
            kind: 'consult',
            evidenceSeq: [1],
            reason: 'lore',
            answer: '公開された世界設定の説明。',
          },
        });
      },
    });
  }
  const asking = context('ヒントを教えて');
  assert.deepEqual(storyHint(snap, 0, asking), {
    obstacleId: snap.scenarioV2.obstacles[0].id,
    level: 1,
    hint: 'HINT_0_1',
  });
  assert.equal(storyHint(snap, 0, asking, 1)?.hint, 'HINT_0_2');
  assert.equal(storyHint(snap, 1, asking)?.hint, 'HINT_1_1');
  assert.equal(storyHint(snap, 0, context('Please give me a hint'))?.level, 1);
  assert.equal(storyHint(snap, 0, context('No hints please')), undefined);
});

test('judgment receives current mechanism and completion but no future facts or mystery instructions', async () => {
  const snap = snapshot();
  const game = fixture(snap, []).game;
  const ai = createGameAI(
    {
      respond: async (body: any) => {
        const data = JSON.parse(body.input[0].content[0].text);
        assert.equal(data.mechanism, 'PRIVATE_MECHANISM_0');
        assert.equal(data.completionFact.key, 'puzzle-0');
        assert.deepEqual(Object.keys(data.facts.values), ['puzzle-0']);
        assert.equal(data.declaredFacts.length, 1);
        assert.ok(!JSON.stringify(body).includes('PRIVATE_MYSTERY_DIRECTION'));
        assert.ok(!JSON.stringify(body).includes('PRIVATE_MECHANISM_1'));
        assert.ok(!JSON.stringify(body).includes('HINT_1_'));
        return response({
          success: false,
          narrative: 'partial',
          situation: 'partial',
          shortReason: 'partial',
          factChanges: [],
          inventoryChanges: [],
        });
      },
    },
    () => 'fake',
    snap,
  );
  await ai.judge(
    {
      scenario: game.scenario,
      obstacleIndex: 0,
      situation: game.situation,
      inventory: game.inventory,
      photos: [],
      transcript: 'try',
      facts: game.facts,
    },
    { items: [], usage: 'try', summary: 'try' },
  );
});

test('scene generation and inspection exclude future obstacle facts and keep selected location', async () => {
  const snap = snapshot();
  const input: SceneInput = {
    playId: 'play',
    messageId: 'scene',
    snapshot: snap,
    facts: fixture(snap, []).game.facts,
    situation: 'current observed situation',
  };
  const prompt = scenePrompt(input, '');
  assert.ok(prompt.includes(snap.scenarioV2.setting.location));
  assert.ok(prompt.includes(snap.scenarioV2.story!.openingClue.ja));
  assert.ok(prompt.includes('VISIBLE_PUZZLE_0'));
  assert.ok(!prompt.includes('VISIBLE_PUZZLE_1'));
  assert.ok(!prompt.includes('puzzle-1'));
  assert.ok(!prompt.includes('PRIVATE_MECHANISM'));
  assert.ok(!prompt.includes('PRIVATE_MYSTERY_DIRECTION'));
  const rules = sceneRules(input);
  assert.ok(rules.some((rule) => rule.ruleId === 'fact:puzzle-0'));
  assert.ok(!rules.some((rule) => rule.ruleId === 'fact:puzzle-1'));
  const fakeAi = {
    config: { inspectionModel: 'fake' },
    mediaCall: async (_job: string, _epoch: number, _kind: string, body: any) => {
      assert.ok(!JSON.stringify(body).includes('puzzle-1'));
      return response({ verdict: 'pass', contradictions: [] });
    },
  } as unknown as AiService;
  assert.equal((await inspectScene(fakeAi, 'job', 0, input, Buffer.from('fake'))).verdict, 'pass');
  input.facts.values['puzzle-0'] = 'cleared';
  input.facts.obstacleId = snap.scenarioV2.obstacles[1].id;
  const next = scenePrompt(input, '');
  assert.ok(next.includes('puzzle-0'));
  assert.ok(next.includes('puzzle-1'));
  assert.ok(!next.includes('puzzle-2'));
});

test('legacy V2 preserves its opening and Live instructions without story metadata', () => {
  const snap = { ...snapshot(), scenarioV2: base };
  const game = fixture(snap, []).game;
  assert.equal(storyOpening(snap, game.situation), coreConfig.conversation.ja.openingMessage);
  assert.ok(
    liveInstructions(game.state(), snap).includes(coreConfig.conversation.ja.openingMessage),
  );
});

test('expanding world lore does not lengthen the spoken opening, while Live retains it for consultation', () => {
  const snap = snapshot();
  const before = storyOpening(snap, '現在の観察。');
  snap.scenarioV2.story!.world = localized(
    '詳しい世界設定。'.repeat(100),
    'Detailed world lore. '.repeat(50),
  );
  assert.equal(storyOpening(snap, '現在の観察。'), before);
  const game = fixture(snap, []).game;
  assert.ok(liveInstructions(game.state(), snap).includes(snap.scenarioV2.story!.world.ja));
  assert.ok(storyContext(snap, 0)?.world.includes('詳しい世界設定。'));
});

test('runtime advances requested hint levels across partial progress and resets for the next obstacle', async (t) => {
  const snap = snapshot();
  const config = loadAiConfig({ AI_MODE: 'mock' });
  const hints: Array<{ obstacleId: string; level: number }> = [];
  const judgments = [
    { success: false, factChanges: [{ key: 'puzzle-0', from: 'blocked', to: 'partial' }] },
    { success: true, factChanges: [{ key: 'puzzle-0', from: 'partial', to: 'cleared' }] },
  ];
  const itemId = randomUUID();
  const ai = new AiService(
    config,
    {
      async createLiveSession() {
        return { session: { id: 'hint-live' }, transport: { type: 'webrtc', sdp: 'answer' } };
      },
      async hangup() {},
      async createResponse(body: any) {
        const data = JSON.parse(body.input[0].content[0].text);
        if (data.conversation) {
          if (data.game.requestedHint) {
            hints.push(data.game.requestedHint);
            return response({
              decision: {
                kind: 'consult',
                evidenceSeq: data.conversation.eligibleEvidenceSeq,
                reason: 'requested hint',
                answer: data.game.requestedHint.hint,
              },
            });
          }
          return response({
            decision: {
              kind: 'execute',
              evidenceSeq: data.conversation.eligibleEvidenceSeq,
              reason: 'instruction',
              usage: '道具を使って',
              itemRefs: [{ inventoryId: itemId }],
            },
          });
        }
        return response({
          ...judgments.shift()!,
          narrative: '確定した変化。',
          situation: '部分変化。',
          shortReason: '通常の物性。',
          inventoryChanges: [],
        });
      },
    },
    () => 0,
  );
  const scenes: Array<{ text: string }> = [];
  const runtime = new GameRuntime(
    randomUUID(),
    600000,
    localizeScenario(snap.scenarioV2, 'ja'),
    ai,
    config,
    new PhotoQueue(),
    () => 0,
    snap,
    {
      transcript() {},
      async photos() {},
      scene(scene) {
        scenes.push(scene);
      },
      ended() {},
    },
  );
  t.after(async () => {
    runtime.dispose();
    await runtime.close();
  });
  const live = await runtime.live(randomUUID(), 'offer');
  runtime.heartbeat('connected');
  runtime.game.inventory = [
    { id: itemId, name: '道具', description: 'ordinary tool', status: 'available' },
  ];
  let time = 1000;
  const say = async (text: string) => {
    time += 1000;
    await runtime.event(live.generation, {
      type: 'session.input_transcript.delta',
      event_id: randomUUID(),
      delta: text,
      start_ms: time,
      end_ms: time + 1,
    });
    await runtime.event(live.generation, {
      type: 'session.delegation.created',
      event_id: randomUUID(),
      offset_ms: time + 2,
      delegation: { id: randomUUID(), type: 'delegation', target: 'client' },
    });
  };
  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 100; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(
      predicate(),
      'runtime did not settle: ' +
        JSON.stringify({
          status: runtime.game.status,
          error: runtime.game.error,
          actions: runtime.game.actionsUsed,
          facts: runtime.game.facts,
          hints,
        }),
    );
  };
  await say('ヒントを教えて');
  await until(() => hints.length === 1);
  await say('もっとヒントを教えて');
  await until(() => hints.length === 2);
  await say('道具を使って');
  await until(() => runtime.game.actionsUsed === 1);
  await say('もう一度ヒントを教えて');
  await until(() => hints.length === 3);
  await say('道具を使って');
  await until(() => runtime.game.obstacleIndex === 1);
  await say('ヒントを教えて');
  await until(() => hints.length === 4);
  assert.deepEqual(
    hints.map((hint) => hint.level),
    [1, 2, 2, 1],
  );
  assert.equal(hints[3].obstacleId, snap.scenarioV2.obstacles[1].id);
  assert.equal(runtime.game.actionsUsed, 2);
  assert.ok(scenes[2].text.includes(snap.scenarioV2.obstacles[1].situationDisplay.ja));
  const commands = runtime.pollCommands(live.generation, 0).commands;
  assert.ok(commands.every((queued) => Buffer.byteLength(queued.content) <= 480));
  const spoken = commands
    .filter((queued) => queued.type === 'session.commentary.append')
    .map((queued) => queued.content)
    .join('');
  assert.ok(spoken.includes('HINT_0_1'));
  assert.ok(spoken.includes('HINT_0_2'));
  assert.ok(spoken.includes('HINT_1_1'));
  assert.ok(!spoken.includes('HINT_2_'));
  assert.ok(!spoken.includes('一言だけ自然に反応'));
  assert.ok(!spoken.includes('Updated story stage'));
  assert.ok(spoken.includes(snap.scenarioV2.obstacles[1].situationDisplay.ja));
});
