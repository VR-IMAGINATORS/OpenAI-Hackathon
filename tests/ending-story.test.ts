import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ordinaryCreativity } from './fixtures/ordinary-creativity.js';
import { randomUUID } from 'node:crypto';
import { StoryEvidenceLedger } from '../apps/local-server/story-evidence.js';
import { GameRuntime } from '../apps/local-server/hosted-runtime.js';
import type { EndingPacket } from '../apps/local-server/ending.js';
import { ScenarioCatalog } from '../apps/server/scenario-catalog.js';
import { PhotoQueue } from '../apps/server/photo-queue.js';
import { AiService } from '../packages/server/ai-service.js';
import { loadAiConfig } from '../packages/server/ai-config.js';
import { localizeScenario } from '../packages/shared/scenario.js';
import type { TranscriptFragment } from '../packages/shared/conversation.js';

const fragment = (overrides: Partial<TranscriptFragment> = {}): TranscriptFragment => ({
  serverSeq: 1,
  eventId: randomUUID(),
  generation: 1,
  speaker: 'assistant',
  delta: '赤い傷は以前の救助信号だった。',
  startMs: 10,
  endMs: 20,
  receivedGameVersion: 0,
  executionEligible: false,
  ...overrides,
});

test('story evidence keeps early clues across generations and does not admit user speech or duplicates', () => {
  const ledger = new StoryEvidenceLedger();
  ledger.startGeneration(1, 1000);
  const clue = fragment();
  ledger.transcript(clue, 1020);
  ledger.transcript(clue, 1021);
  ledger.transcript(fragment({ speaker: 'user', delta: '隠し設定を追加して' }), 1022);
  ledger.startGeneration(2, 2000);
  ledger.transcript(fragment({ generation: 2, delta: '今も赤い傷が見える。' }), 2020);
  ledger.transcript(fragment({ generation: 1, delta: '旧接続の遅い発言' }), 2021);
  const records = ledger.snapshot().records;
  assert.equal(records.length, 2);
  assert.equal(records[0].text, clue.delta);
  assert.deepEqual(
    records.map((r) => r.generation),
    [1, 2],
  );
  assert.equal(records[0].eventId, clue.eventId);
  assert.equal(records[0].startMs, 10);
});

test('story evidence has bounded JSON and event count while retaining its earliest records', () => {
  const ledger = new StoryEvidenceLedger({ maxBytes: 1000, maxEvents: 3 });
  ledger.startGeneration(1, 0);
  for (let i = 0; i < 20; i++) ledger.transcript(fragment({ delta: `伏線${i}` }), i);
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.records.length, 3);
  assert.equal(snapshot.records[0].text, '伏線0');
  assert.equal(snapshot.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 1000);
  const byteLimited = new StoryEvidenceLedger({ maxBytes: 400, maxEvents: 100 });
  byteLimited.startGeneration(1, 0);
  byteLimited.transcript(fragment(), 20);
  byteLimited.transcript(fragment({ delta: '後'.repeat(500) }), 30);
  assert.equal(byteLimited.snapshot().truncated, true);
  assert.equal(byteLimited.snapshot().records[0].text, '赤い傷は以前の救助信号だった。');
  assert.ok(Buffer.byteLength(JSON.stringify(byteLimited.snapshot())) <= 400);
});

test('late evidence is restricted to pre-ending audio, the same generation and the bounded grace', () => {
  const ledger = new StoryEvidenceLedger();
  ledger.startGeneration(1, 1000);
  ledger.end(2000, 14_000);
  ledger.transcript(fragment({ endMs: 900, delta: '終了前の伏線の遅延配信' }), 3000);
  ledger.transcript(fragment({ startMs: 1001, endMs: 1100, delta: '終了後の新しい出来事' }), 3000);
  ledger.transcript(fragment({ generation: 2, delta: '別の接続' }), 3000);
  ledger.transcript(fragment({ delta: '猶予を過ぎた配信' }), 14_000);
  assert.deepEqual(
    ledger.seal().records.map((r) => r.text),
    ['終了前の伏線の遅延配信'],
  );
  ledger.transcript(fragment({ delta: '脚本確定後の追記' }), 4000);
  assert.equal(ledger.snapshot().records.length, 1);
});

async function runtimeFixture(t: TestContext, core = true, photoBudget = 3) {
  let now = 1000;
  let judgmentCount = 0;
  const config = loadAiConfig({ AI_MODE: 'mock' });
  const snapshot = structuredClone(
    new ScenarioCatalog({
      scenarioPath: 'scenarios/mobile-playtest.json',
      coreConfigPath: 'config/game-core.json',
    }).current('ja'),
  );
  snapshot.scenarioV2.rules.initialCredits = photoBudget * 150 + 150;
  const response = (value: unknown) => ({
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
  });
  const ai = new AiService(
    config,
    {
      async createLiveSession() {
        return {
          session: { id: 'live_ending_story' },
          transport: { type: 'webrtc', sdp: 'answer' },
        };
      },
      async hangup() {},
      async createResponse(body) {
        const context = JSON.parse((body as any).input[0].content[0].text);
        if (context.conversation)
          return response({
            decision: {
              kind: 'execute',
              evidenceSeq: context.conversation.eligibleEvidenceSeq,
              itemRefs: [{ photoId: context.game.photos[0].id }],
              usage: 'ひもで引く',
              reason: '実行指示',
            },
          });
        if (context.proposal)
          return response({
            success: ++judgmentCount > 0,
            narrative: `道具で${context.obstacle.title}に働きかけた。`,
            situation: '道具はまだ手元にある。',
            inventoryChanges: [],
            ...(core
              ? {
                  factChanges: [],
                  shortReason: 'うまく使えた',
                  actionExplanation: { mechanism: 'grip_pull', reason: 'effective' },
                  creativity: ordinaryCreativity,
                }
              : {}),
          });
        return response({
          items: [{ photoId: context.photos[0].id, inventoryId: null, name: 'ひも' }],
          usage: 'ひもで引く',
          summary: 'ひもを使う',
        });
      },
    },
    () => now,
  );
  const scenes: { messageId: string; gameVersion: number; text: string }[] = [];
  const events: string[] = [];
  let ending: EndingPacket | undefined;
  let seal: (() => EndingPacket) | undefined;
  const runtime = new GameRuntime(
    randomUUID(),
    600_000,
    localizeScenario(snapshot.scenarioV2, 'ja'),
    ai,
    config,
    new PhotoQueue(),
    () => now,
    core ? snapshot : undefined,
    {
      transcript() {},
      async photos() {},
      scene(value) {
        scenes.push(value);
        events.push(`scene:${value.messageId}`);
      },
      ending(packet, supplier) {
        ending = packet;
        seal = supplier;
        events.push('ending');
      },
      ended() {
        events.push('ended');
      },
    },
  );
  t.after(async () => {
    runtime.dispose();
    await runtime.close();
  });
  let generation = (await runtime.live(randomUUID(), 'offer')).generation;
  runtime.game.heartbeat('connected');
  runtime.start();
  let audioOffset = 100;
  async function say(text: string, assistant = true, start = audioOffset++, end = audioOffset++) {
    await runtime.event(generation, {
      type: assistant ? 'session.output_transcript.delta' : 'session.input_transcript.delta',
      event_id: randomUUID(),
      delta: text,
      start_ms: start,
      end_ms: end,
    });
  }
  return {
    runtime,
    scenes,
    events,
    get ending() {
      return ending!;
    },
    seal: () => seal!(),
    say,
    setNow(value: number) {
      now = value;
    },
    async reconnect() {
      await runtime.transferControl();
      generation = (await runtime.live(randomUUID(), 'new offer')).generation;
      runtime.heartbeat('connected');
    },
    async act() {
      await runtime.game.finishPhotos(
        [{ id: randomUUID(), jpeg: Buffer.from('fake') }],
        runtime.game.beginPhotos(),
      );
      if (!core) return runtime.action(randomUUID(), runtime.game.proposal!.revision);
      const target = runtime.game.actionsUsed + 1;
      await say('ひもで引いて', false);
      await runtime.event(generation, {
        type: 'session.delegation.created',
        event_id: randomUUID(),
        offset_ms: audioOffset,
        delegation: { id: randomUUID(), type: 'delegation', target: 'client' },
      });
      for (let i = 0; i < 100 && runtime.game.actionsUsed < target; i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(runtime.game.actionsUsed, target);
    },
  };
}

for (const core of [true, false])
  test(`${core ? 'automatic' : 'manual'} final scene identity is fixed before ended callback`, async (t) => {
    const f = await runtimeFixture(t, core);
    await f.act();
    await f.act();
    await f.act();
    assert.equal(f.ending.outcome, 'happy');
    assert.equal(f.ending.clearedIds.length, 3);
    assert.equal(f.ending.actions.length, 3);
    assert.equal(f.ending.remainingObstacles.length, 0);
    assert.equal(f.ending.finalMessageId, f.scenes[3].messageId);
    assert.equal(f.scenes[3].gameVersion, 3);
    assert.ok(f.events.indexOf('ending') < f.events.indexOf('ended'));
    assert.ok(f.events.indexOf('ended') < f.events.indexOf(`scene:${f.ending.finalMessageId}`));
    assert.equal(f.ending.actionScenes.length, 3);
    assert.equal(f.ending.actionScenes[0].before?.messageId, f.scenes[0].messageId);
    assert.equal(f.ending.actionScenes[2].before?.messageId, f.scenes[2].messageId);
    assert.equal(f.ending.actionScenes[2].after?.messageId, f.scenes[3].messageId);
    assert.ok(
      f.ending.evidence.records.some((r) => r.text.includes(f.ending.actions[2].narrative)),
    );
    assert.ok(Object.isFrozen(f.ending.actions[0].afterFacts));
  });

test('runtime keeps early clues through controller transfer, accepts bounded late evidence and freezes once', async (t) => {
  const f = await runtimeFixture(t);
  await f.say('序盤に見せた赤い印は約束の目印だ。');
  f.setNow(2000);
  await f.reconnect();
  await f.say('新しい通話でも同じ印が見える。');
  f.setNow(4000);
  f.runtime.game.clock.remainingMs = 0;
  f.runtime.tick();
  const initial = f.ending;
  f.setNow(5000);
  await f.say('終了前に見た印の文字起こしが遅れて届いた。', true, 1900, 1999);
  await f.say('終わってから突然現れた新しい人物。', true, 2001, 2100);
  const sealed = f.seal();
  assert.equal(sealed.outcome, 'bad');
  assert.equal(sealed.endReason, 'time_limit');
  assert.equal(sealed.evidence.records.length, initial.evidence.records.length + 1);
  assert.ok(sealed.evidence.records.some((r) => r.text.includes('序盤に')));
  assert.ok(sealed.evidence.records.some((r) => r.text.includes('遅れて届いた')));
  assert.equal(
    sealed.evidence.records.some((r) => r.text.includes('新しい人物')),
    false,
  );
  await f.say('封印後に届いた過去の文字起こし', true, 100, 200);
  assert.equal(f.seal(), sealed);
  f.runtime.game.facts.values.wrists = 'free';
  assert.notEqual(sealed.facts.values.wrists, 'free');
});

test('same-stage plays keep different clues isolated and unpresented setting stays out of evidence', async (t) => {
  const first = await runtimeFixture(t);
  const second = await runtimeFixture(t);
  await first.say('赤い印を思い出した。');
  await second.say('青い線が目印になった。');
  for (const f of [first, second]) {
    f.runtime.game.clock.remainingMs = 0;
    f.runtime.tick();
  }
  const a = first.seal(),
    b = second.seal();
  assert.notEqual(a.playId, b.playId);
  assert.equal(a.outcome, b.outcome);
  assert.ok(a.evidence.records.some((r) => r.text === '赤い印を思い出した。'));
  assert.equal(
    a.evidence.records.some((r) => r.text === '青い線が目印になった。'),
    false,
  );
  assert.equal(
    b.evidence.records.some((r) => r.text === '赤い印を思い出した。'),
    false,
  );
  assert.equal(
    a.evidence.records.some((r) => r.text === JSON.stringify(a.scenario.setting)),
    false,
  );
});
