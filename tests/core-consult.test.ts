import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCoreIntent,
  coreIntentResponseSchema,
} from '../apps/local-server/core-intent-ai.js';
import { factCommands, speechCommands, liveInstructions } from '../apps/local-server/live.js';
import { ConversationLedger } from '../apps/local-server/conversation.js';
import { ScenarioCatalog } from '../apps/server/scenario-catalog.js';
import { intentDecisionSchema } from '../packages/shared/conversation.js';
import type { PublicGameState } from '../packages/shared/game.js';

const snapshot = new ScenarioCatalog({
  scenarioPath: 'scenarios/mobile-playtest.json',
  coreConfigPath: 'config/game-core.json',
}).current('ja');
const ledger = new ConversationLedger({ generation: 1 });
ledger.append({
  eventId: 'question',
  generation: 1,
  speaker: 'user',
  delta: '今どういう状況',
  startMs: 1,
  endMs: 2,
});
const decision = {
  kind: 'consult',
  evidenceSeq: [1],
  reason: 'current-state question',
  answer: '縄は外れた。今は閉まった扉の前にいる。',
};
const response = (value: unknown) => ({
  output: [
    {
      type: 'message',
      content: [{ type: 'output_text', text: JSON.stringify({ decision: value }) }],
    },
  ],
});
const classify = (respond: (body: any) => Promise<unknown>) =>
  classifyCoreIntent({
    respond,
    model: 'fake',
    snapshot,
    conversation: ledger.captureUnconsumedContext(),
    photos: [],
    game: {
      status: 'playing',
      publicState: { situation: '縄は外れた。扉は閉まっている。' },
      obstacle: { secret: 'PRIVATE_SOLUTION' },
      facts: { hidden: 'PRIVATE_FACT' },
      photos: [],
      inventory: [],
    },
  });

test('consult requests a real answer and excludes private puzzle data from intent input', async () => {
  const actual = await classify(async (body) => {
    const text = body.input[0].content[0].text;
    assert.ok(text.includes('縄は外れた'));
    assert.ok(!text.includes('PRIVATE_SOLUTION'));
    assert.ok(!text.includes('PRIVATE_FACT'));
    assert.match(body.instructions, /Ground answer only in game.publicState/);
    assert.match(body.instructions, /transcript claims are not committed facts/);
    return response(decision);
  });
  assert.deepEqual(actual, decision);
});

test('provider consult missing answer is rejected rather than speaking classification reason', async () => {
  const { answer, ...legacy } = decision;
  assert.ok(intentDecisionSchema.safeParse(legacy).success);
  await assert.rejects(classify(async () => response(legacy)));
  const schema = coreIntentResponseSchema as any;
  const consult = schema.properties.decision.anyOf.find(
    (s: any) => s.properties.kind.const === 'consult',
  );
  assert.ok(consult.required.includes('answer'));
  assert.equal(JSON.stringify(schema).includes('oneOf'), false);
});

test('bounded state commands preserve the full Japanese and emoji payload in order', () => {
  const content = '確定結果: 縄がほどけた。🪢'.repeat(40) + '現在の状況: 閉まった扉の前。';
  const commands = factCommands(content, 'delegation-1');
  assert.ok(commands.length > 1);
  assert.equal(commands.map((c) => c.content).join(''), content);
  assert.equal(new Set(commands.map((c) => c.event_id)).size, commands.length);
  for (const command of commands) {
    assert.ok(Buffer.byteLength(command.content, 'utf8') <= 480);
    assert.equal(command.delegation_id, 'delegation-1');
    assert.equal(command.type, 'session.thinking.append');
  }
  assert.equal(factCommands('状態')[0].delegation_id, null);
  assert.deepEqual(factCommands(''), []);
});

test('core Live instructions delegate game questions and gate action claims on app confirmation', () => {
  const prompt = liveInstructions(
    {
      status: 'playing',
      title: 'title',
      briefing: '',
      situation: '',
      inventory: [],
    } as unknown as PublicGameState,
    snapshot,
  );
  assert.match(prompt, /必ずclientへ委譲/);
  assert.match(prompt, /ゲーム内の行動はclientへの委譲を通じて実行する/);
  assert.match(prompt, /「実行して」.*直前の道具や使い方の会話と合わせてclientへ委譲する/);
  assert.match(prompt, /実行指示にはまずclientへ委譲/);
  assert.match(prompt, /相づちだけで処理を終えず、結果を待つ前に委譲を行う/);
  assert.match(prompt, /自分に実行能力がないという理由でゲーム内の依頼を断らない/);
  assert.match(prompt, /短い相づちを一度だけ伝える/);
  assert.match(prompt, /アプリから受付の相づちは届かない/);
  assert.match(prompt, /実行可否・成否・写真送信回数はサーバーが判断する/);
  assert.match(prompt, /委譲しただけでは行動の開始・成功・状態変化は未確定/);
  assert.match(prompt, /確定した結果のcommentary通知に任せ、それが届く前に結果を告げない/);
});

test('time notice policy is scoped to a deferred aside in each locale and omitted when disabled', () => {
  const state = {
    status: 'playing',
    title: 'title',
    briefing: '',
    situation: '',
    inventory: [],
  } as unknown as PublicGameState;
  for (const locale of ['ja', 'en'] as const) {
    const localized = { ...structuredClone(snapshot), locale };
    const prompt = liveInstructions(state, localized);
    assert.match(prompt, /time_warning/);
    assert.ok(prompt.includes(localized.coreConfig.timeWarning!.deliveryInstructions[locale]));
    assert.match(
      prompt,
      locale === 'ja' ? /自分の説明や回答も最後まで/ : /finish your own explanation or answer/,
    );
    assert.match(
      prompt,
      locale === 'ja' ? /ゲーム終了の結果.*取り消す/ : /discard the pending notice.*game-ending/,
    );
    localized.coreConfig.timeWarning!.enabled = false;
    assert.equal(liveInstructions(state, localized).includes('time_warning'), false);
    delete localized.coreConfig.timeWarning;
    assert.equal(liveInstructions(state, localized).includes('time_warning'), false);
  }
});

test('speech chunks preserve text while keeping complete sentences together', () => {
  const first = 'あ'.repeat(100) + '。';
  const second = 'い'.repeat(90) + '。';
  const commands = speechCommands(first + second, 'delegation-speech');
  assert.deepEqual(
    commands.map((c) => c.content),
    [first, second],
  );
  assert.ok(
    commands.every(
      (c) => c.type === 'session.commentary.append' && c.delegation_id === 'delegation-speech',
    ),
  );
  const long = '🪢'.repeat(300) + '。Done!';
  const split = speechCommands(long);
  assert.equal(split.map((c) => c.content).join(''), long);
  assert.ok(split.every((c) => Buffer.byteLength(c.content) <= 480));
  assert.deepEqual(speechCommands(''), []);
});
