import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { localizeScenario, parseScenarioV2 } from '../packages/shared/scenario.js';
import { parseCoreConfig } from '../packages/shared/core-config.js';
import {
  createGameAI,
  projectPublicJudgment,
  judgmentResponseSchema,
  type AIContext,
  type CoreJudgment,
} from '../apps/local-server/game-ai.js';
import { companionResultFacts } from '../apps/local-server/companion-response.js';
import type { CompanionContext } from '../apps/local-server/companion-knowledge.js';
import type { ScenarioSnapshot } from '../apps/server/scenario-catalog.js';
import { aiFailureCode } from '../apps/local-server/ai-failure.js';

const privateText = 'HIDDEN_CULPRIT_CANARY';
const snapshot: ScenarioSnapshot = {
  digest: 'test',
  locale: 'ja',
  createdAt: 0,
  scenarioV2: parseScenarioV2(JSON.parse(readFileSync('scenarios/mobile-playtest.json', 'utf8'))),
  coreConfig: parseCoreConfig(JSON.parse(readFileSync('config/game-core.json', 'utf8'))),
};
snapshot.scenarioV2.knowledge = [
  {
    id: 'loose',
    kind: 'observable',
    revealMode: 'automatic',
    prerequisites: [{ factKey: 'wrists', value: 'loosened' }],
    localizedText: { ja: '縄が少し緩んだ。', en: 'The rope loosened.' },
    requestCue: { ja: '縄', en: 'Rope' },
  },
  {
    id: 'private',
    kind: 'hidden',
    revealMode: 'on_request',
    prerequisites: [],
    localizedText: { ja: privateText, en: privateText },
    requestCue: { ja: '犯人', en: 'Captor' },
  },
];
const context: AIContext = {
  scenario: localizeScenario(snapshot.scenarioV2, 'ja'),
  obstacleIndex: 0,
  situation: '縄で縛られている。',
  inventory: [
    {
      id: '12345678-1234-4234-8234-123456789012',
      name: 'はさみ',
      description: 'はさみ',
      status: 'available',
    },
  ],
  photos: [],
  transcript: '',
  facts: { obstacleId: 'wrists', values: { wrists: 'bound' } },
};
const judged: CoreJudgment = {
  success: false,
  narrative: privateText,
  situation: privateText,
  shortReason: privateText,
  inventoryChanges: [
    { id: context.inventory[0]!.id, status: 'available', description: privateText },
  ],
  factChanges: [{ key: 'wrists', from: 'bound', to: 'loosened' }],
};
const replyContext: CompanionContext = {
  scene: '部屋',
  currentGoal: '出口を開く',
  situation: '出口の扉が閉まっている。',
  knownFacts: [{ id: 'door', text: '扉が閉まっている。', currentlyApplicable: true }],
  inferences: [],
  inventory: [],
};
const output = (value: unknown) => ({
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
});

test('private judge prose is replaced by authored automatic observations', () => {
  const safe = projectPublicJudgment(snapshot, context, judged);
  assert.equal(JSON.stringify(safe).includes(privateText), false);
  assert.match(safe.narrative, /縄が少し緩んだ/);
  assert.equal(safe.situation, '縄が少し緩んだ。');
  assert.equal(safe.inventoryChanges[0]!.description, 'はさみ');
  assert.deepEqual(safe.factChanges, judged.factChanges);
});

test('no eligible observation keeps public state and never uses a private explanation', () => {
  const safe = projectPublicJudgment(snapshot, context, { ...judged, factChanges: [] });
  assert.equal(safe.situation, context.situation);
  assert.equal(JSON.stringify(safe).includes(privateText), false);
});

test('createGameAI projects core judgment before returning to GameSession', async () => {
  const ai = createGameAI({ respond: async () => output(judged) }, () => 'test', snapshot);
  const safe = await ai.judge(context, { items: [], usage: '試す', summary: '' });
  assert.equal(JSON.stringify(safe).includes(privateText), false);
});

test('recognition request does not include private obstacle mechanics or declared future values', async () => {
  const changed = structuredClone(snapshot);
  changed.scenarioV2.obstacles[0]!.mechanism = { ja: privateText, en: privateText };
  const recognitionContext = structuredClone(context);
  recognitionContext.scenario.obstacles[0]!.goal = privateText;
  recognitionContext.scenario.obstacles[0]!.constraints = [privateText];
  let sent = '';
  const ai = createGameAI(
    {
      respond: async (body) => {
        sent = JSON.stringify(body);
        return output({ items: [], usage: '', summary: '写真なし' });
      },
    },
    () => 'test',
    changed,
  );
  await ai.recognize(recognitionContext);
  assert.equal(sent.includes(privateText), false);
  assert.equal(sent.includes('allowedTransitions'), false);
});

test('Live result briefing projects public facts synchronously without a dialogue model', () => {
  const facts = JSON.parse(
    companionResultFacts(
      Object.assign({}, replyContext, { mechanism: privateText }),
      Object.assign({ success: false, narrative: '縄が緩んだ。' }, { shortReason: privateText }),
    ),
  );
  assert.deepEqual(facts, {
    type: 'action_result',
    success: false,
    result: '縄が緩んだ。',
    situation: '出口の扉が閉まっている。',
    inventory: [],
  });
  assert.equal(JSON.stringify(facts).includes(privateText), false);
});

test('Live result briefing falls back to the committed public situation', () => {
  const facts = JSON.parse(
    companionResultFacts(
      { ...replyContext, situation: '' },
      { success: false, narrative: '縄が緩んだ。', situation: '扉は閉じている。' },
    ),
  );
  assert.equal(facts.situation, '扉は閉じている。');
});

test('core judgment forwards the cancellation signal through the response client', async () => {
  const controller = new AbortController();
  let received: AbortSignal | undefined;
  const ai = createGameAI(
    {
      respond: async (_body, signal) => {
        received = signal;
        return output(judged);
      },
    },
    () => 'test',
    snapshot,
  );
  await ai.judge(context, { items: [], usage: '試す', summary: '' }, controller.signal);
  assert.equal(received, controller.signal);
});

test('provider judgment permits only current transitions and real inventory IDs', () => {
  const schema = judgmentResponseSchema(snapshot, context);
  assert.equal(schema.safeParse(judged).success, true);
  for (const factChanges of [
    [{ key: 'unknown', from: 'bound', to: 'loosened' }],
    [{ key: 'wrists', from: 'free', to: 'loosened' }],
    [{ key: 'wrists', from: 'bound', to: 'magic' }],
    [{ key: 'wrists', from: 'bound', to: 'bound' }],
  ])
    assert.equal(schema.safeParse({ ...judged, factChanges }).success, false);
  assert.equal(
    schema.safeParse({
      ...judged,
      inventoryChanges: [
        { id: '12345678-1234-4234-8234-999999999999', status: 'consumed', description: '' },
      ],
    }).success,
    false,
  );
  const noItems = judgmentResponseSchema(snapshot, { ...context, inventory: [] });
  assert.equal(noItems.safeParse({ ...judged, inventoryChanges: [] }).success, true);
  assert.equal(noItems.safeParse(judged).success, false);
});

test('explicitly incomplete or refused judgment is never parsed as a committed result', async () => {
  for (const [raw, code] of [
    [{ ...output(judged), status: 'incomplete' }, 'AI_OUTPUT_INCOMPLETE'],
    [
      { output: [{ type: 'message', content: [{ type: 'refusal', refusal: privateText }] }] },
      'AI_OUTPUT_REFUSED',
    ],
    [{ output: [] }, 'AI_OUTPUT_INVALID'],
  ] as const) {
    const ai = createGameAI({ respond: async () => raw }, () => 'test', snapshot);
    await assert.rejects(ai.judge(context, { items: [], usage: 'try', summary: '' }), (error) => {
      assert.equal(aiFailureCode(error), code);
      assert.doesNotMatch(String(error), new RegExp(privateText));
      return true;
    });
  }
});

test('diagnostics retain only allowlisted technical causes', () => {
  assert.equal(aiFailureCode({ code: 'UPSTREAM_FAILED', message: privateText }), 'UPSTREAM_FAILED');
  assert.equal(
    aiFailureCode({ code: 'INVALID_FACT_CHANGE', message: 'ACTION_FAILED' }),
    'INVALID_FACT_CHANGE',
  );
  assert.equal(aiFailureCode(new SyntaxError(privateText)), 'AI_OUTPUT_INVALID');
  assert.equal(aiFailureCode(new Error(privateText)), 'PROCESSING_ERROR');
  assert.equal(aiFailureCode({ code: privateText, message: privateText }), 'PROCESSING_ERROR');
});
