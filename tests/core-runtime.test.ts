import { liveBriefings } from './fixtures/live-briefings.js';
import { LiveOutbox } from '../apps/local-server/live-outbox.js';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { ordinaryCreativity } from './fixtures/ordinary-creativity.js';
import { GameRuntime } from '../apps/local-server/hosted-runtime.js';
import { ScenarioCatalog } from '../apps/server/scenario-catalog.js';
import { PhotoQueue } from '../apps/server/photo-queue.js';
import { ResultStore } from '../apps/server/result-store.js';
import { AiService } from '../packages/server/ai-service.js';
import { loadAiConfig } from '../packages/server/ai-config.js';
import { localizeScenario } from '../packages/shared/scenario.js';
import { parseCoreConfig } from '../packages/shared/core-config.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const response = (value: unknown) => ({
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), 'background work did not reach expected state');
}
function execute(context: any) {
  return {
    kind: 'execute',
    evidenceSeq: context.conversation.eligibleEvidenceSeq,
    itemRefs: [{ photoId: context.game.photos[0].id }],
    usage: 'ハサミでロープを切って',
    reason: '実行指示',
  };
}
async function setup(
  t: TestContext,
  classify: (context: any) => unknown | Promise<unknown>,
  recognizeGate?: Promise<void>,
  traceEnabled = false,
  judgeGate?: Promise<void>,
  photoDecision?: (input: any) => unknown | Promise<unknown>,
  judgeResponse?: (input: any, signal?: AbortSignal) => unknown | Promise<unknown>,
  locale: 'ja' | 'en' = 'ja',
  initialCredits = 1000,
  creativeProbability?: number,
  recognizeResponse?: (input: any) => unknown,
) {
  let now = 1000;
  const calls = {
    classify: 0,
    judge: 0,
    recognize: 0,
    photo: 0,
    reply: 0,
    schemas: [] as string[],
  };
  const config = loadAiConfig({ AI_MODE: 'mock' });
  const ai = new AiService(
    config,
    {
      async createLiveSession() {
        return {
          session: { id: 'live_runtime_test' },
          transport: { type: 'webrtc', sdp: 'answer' },
        };
      },
      async hangup() {},
      async createResponse(body, signal) {
        assert.equal((body as any).model, 'gpt-5.6-sol');
        assert.deepEqual((body as any).reasoning, { effort: 'low' });
        const parts = (body as any).input[0].content;
        const context = JSON.parse(parts.find((part: any) => part.type === 'input_text').text);
        const schemaName = (body as any).text.format.name;
        calls.schemas.push(schemaName);
        if (schemaName === 'harness_photo') {
          calls.photo++;
          return response(
            photoDecision
              ? await photoDecision(context)
              : {
                  decision: 'clarify',
                  usage: '',
                  itemRefs: [],
                  message: '写真が届いたよ。これをどう使う？',
                  reason: 'Mock photo has ambiguous intended use',
                },
          );
        }
        if (schemaName === 'companion_reply') {
          calls.reply++;
          return response({ reply: context.result.narrative + '\n' + context.context.situation });
        }
        if (schemaName === 'knowledge_selection') return response({ ids: [] });
        if (schemaName === 'core_intent') {
          calls.classify++;
          return response({ decision: await classify(context) });
        }
        if (context.proposal) {
          calls.judge++;
          if (judgeResponse)
            return response({
              creativity: ordinaryCreativity,
              ...((await judgeResponse(context, signal)) as object),
            });
          await judgeGate;
          return response({
            success: false,
            creativity: ordinaryCreativity,
            narrative: 'ロープは切れなかった。',
            situation: 'ロープはまだつながっている。',
            inventoryChanges: [],
            factChanges: [],
            shortReason: '届かなかった',
          });
        }
        calls.recognize++;
        await recognizeGate;
        if (recognizeResponse) return response(recognizeResponse(context));
        return response({
          items: [{ photoId: context.photos[0].id, inventoryId: null, name: 'ハサミ' }],
          usage: '',
          summary: 'ハサミの用途待ち',
        });
      },
    },
    () => now,
  );
  const snapshot = structuredClone(
    new ScenarioCatalog({
      scenarioPath: 'scenarios/mobile-playtest.json',
      coreConfigPath: 'config/game-core.json',
    }).current(locale),
  );
  const queue = new PhotoQueue();
  snapshot.scenarioV2.rules.initialCredits = initialCredits;
  if (creativeProbability !== undefined)
    snapshot.coreConfig.creativity = parseCoreConfig({
      ...snapshot.coreConfig,
      creativity: { enabled: true, successProbability: creativeProbability },
    }).creativity;
  const notices: string[] = [];
  const scenes: any[] = [];
  const results = new ResultStore();
  const playId = randomUUID();
  results.create({ playId, ownerDigest: 'test', locale });
  const runtime = new GameRuntime(
    playId,
    600000,
    localizeScenario(snapshot.scenarioV2, locale),
    ai,
    config,
    queue,
    () => now,
    snapshot,
    {
      transcript(fragment, messageId) {
        results.appendTranscript(playId, fragment, messageId);
      },
      async photos() {},
      scene(input) {
        scenes.push(input);
        results.appendMessage(playId, {
          id: input.messageId,
          side: 'assistant',
          kind: 'result',
          text: input.awaitTranscript ? '' : input.text,
          liveGeneration: input.generation,
          imageSlot: {
            status: 'queued',
            assetId: null,
            errorCode: null,
            deadline: new Date(Date.now() + 150_000).toISOString(),
          },
        });
      },
      ended() {},
      notice(text) {
        notices.push(text);
      },
    },
    traceEnabled,
  );
  t.after(async () => {
    runtime.dispose();
    await runtime.close();
  });
  const live = await runtime.live(randomUUID(), 'offer');
  runtime.game.heartbeat('connected');
  runtime.start();
  const photo = (
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#888' } })
      .png()
      .toBuffer()
  ).toString('base64');
  let time = 10;
  return {
    runtime,
    snapshot,
    notices,
    scenes,
    feed: () => results.feed('test', playId),
    calls,
    quiet: (sequence = 1) =>
      runtime.reportVoiceActivity({
        generation: live.generation,
        sequence,
        input: 'quiet',
        output: 'quiet',
        playbackReady: true,
      }),
    generation: live.generation,
    photo,
    setNow: (value: number) => {
      now = value;
    },
    say: (delta: string) =>
      runtime.event(live.generation, {
        type: 'session.input_transcript.delta',
        event_id: randomUUID(),
        delta,
        start_ms: time++,
        end_ms: time++,
      }),
    delegate: (id = randomUUID()) =>
      runtime.event(live.generation, {
        type: 'session.delegation.created',
        event_id: randomUUID(),
        offset_ms: time,
        delegation: { id, type: 'delegation', target: 'client' },
      }),
  };
}

test('call check updates its image bubble across pauses and retries, then reply and introduction form separate turns', async (t) => {
  const h = await setup(t, () => ({ kind: 'wait', reason: 'waiting' }));
  const opening = h.feed().upserts[0]!;
  assert.equal(opening.text, '');
  assert.ok(opening.imageSlot);
  const first = {
    type: 'session.output_transcript.delta',
    event_id: randomUUID(),
    delta: '聞こえる？',
    start_ms: 10,
    end_ms: 100,
  };
  await h.runtime.event(h.generation, first);
  await h.runtime.event(h.generation, first);
  assert.equal(h.feed().upserts.length, 1);
  assert.equal(h.feed().upserts[0]!.text, first.delta);
  await h.runtime.event(h.generation, {
    ...first,
    event_id: randomUUID(),
    delta: '聞こえたら返事をして。',
    start_ms: 5000,
    end_ms: 6000,
  });
  const updated = h.feed().upserts[0]!;
  assert.equal(h.feed().upserts.length, 1);
  assert.equal(updated.id, opening.id);
  assert.equal(updated.createdOrder, opening.createdOrder);
  assert.deepEqual(updated.imageSlot, opening.imageSlot);
  assert.equal(updated.text, '聞こえる？聞こえたら返事をして。');
  assert.ok(updated.updatedVersion > opening.updatedVersion);
  await h.say('うん、聞こえるよ');
  await h.runtime.event(h.generation, {
    ...first,
    event_id: randomUUID(),
    delta: 'よかった、つながった。私は未来のあなたを助けるAI。',
    start_ms: 6100,
    end_ms: 6200,
  });
  const messages = h.feed().upserts;
  assert.equal(messages.length, 3);
  assert.equal(messages[0]!.text, updated.text);
  assert.equal(messages[1]!.text, 'うん、聞こえるよ');
  assert.equal(messages[2]!.text, 'よかった、つながった。私は未来のあなたを助けるAI。');
  assert.equal(messages[2]!.kind, 'transcript');
  assert.equal(h.runtime.state().creditsRemaining, 1000);
  assert.equal(h.calls.judge, 0);
});

test('credits: transcript fragments and duplicate delegations form one paid consultation; corrections are free', async (t) => {
  const h = await setup(t, (context) => ({
    kind: 'consult',
    evidenceSeq: context.conversation.eligibleEvidenceSeq,
    reason: 'Answer the user',
    answer: 'わかったよ。',
    responseKind: context.conversation.fragments.some((f: any) => f.delta.includes('聞き間違い'))
      ? 'correction'
      : 'answer',
  }));
  await h.say('いま');
  await h.say('どんな状況？');
  const delegation = randomUUID();
  await h.delegate(delegation);
  await until(() => h.runtime.state().creditsRemaining === 980);
  await h.delegate(delegation);
  await tick();
  assert.equal(h.runtime.state().creditsRemaining, 980);
  assert.equal(h.runtime.state().lastCreditCharge?.amount, 20);
  await h.say('今のは聞き間違いです');
  await h.delegate();
  await until(() => h.calls.classify >= 2);
  await tick();
  assert.equal(h.runtime.state().creditsRemaining, 980);
});

test('credits: final consultation ends through existing result outcome with the exact exhaustion notice', async (t) => {
  const h = await setup(
    t,
    (context) => ({
      kind: 'consult',
      evidenceSeq: context.conversation.eligibleEvidenceSeq,
      reason: 'Question',
      answer: 'ロープがあるよ。',
    }),
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    'ja',
    20,
  );
  await h.say('何がある？');
  await h.delegate();
  await until(() => h.runtime.game.terminal);
  const state = h.runtime.state();
  assert.equal(state.creditsRemaining, 0);
  assert.equal(state.status, 'lost');
  assert.equal(state.endReason, 'credits_exhausted');
  assert.equal(state.endingOutcome, 'bad');
  assert.deepEqual(h.notices, ['クレジットを使い切りました。']);
  assert.ok(
    h.runtime
      .pollCommands(h.generation, 0)
      .commands.some((c) => c.content.includes('ロープがあるよ。')),
  );
});

test('credits: last photo reserves its full cost and completes the winning automatic action before exhaustion', async (t) => {
  const gate = deferred<void>();
  const h = await setup(
    t,
    () => ({ kind: 'wait', reason: 'No speech' }),
    undefined,
    false,
    undefined,
    (context) => ({
      decision: 'execute',
      usage: 'Use the scissors',
      itemRefs: [{ photoId: context.photos[0] }],
      message: '使ってみる。',
      reason: 'Obvious tool',
    }),
    async () => {
      await gate.promise;
      return {
        success: true,
        narrative: '出口が開いた。',
        situation: '外に出た。',
        inventoryChanges: [],
        factChanges: [],
        shortReason: '解除',
      };
    },
    'ja',
    100,
  );
  h.runtime.game.obstacleIndex = 2;
  h.runtime.game.facts.obstacleId = h.runtime.game.scenario.obstacles[2].id;
  const requestId = randomUUID();
  await h.runtime.photos(requestId, [h.photo]);
  await until(() => h.calls.judge === 1);
  assert.equal(h.runtime.state().creditsRemaining, 0);
  assert.equal(h.runtime.state().status, 'judging');
  await assert.rejects(async () => h.runtime.photos(randomUUID(), [h.photo]));
  gate.resolve();
  await until(() => h.runtime.game.terminal);
  assert.equal(h.runtime.state().status, 'won');
  assert.equal(h.runtime.state().endReason, 'escaped');
  assert.equal(h.runtime.state().creditsRemaining, 0);
  assert.equal(h.calls.judge, 1);
  await h.runtime.photos(requestId, [h.photo]);
  assert.equal(h.calls.recognize, 1);
  assert.ok(!h.notices.includes('クレジットを使い切りました。'));
});

test('credits: failed photo processing releases the reservation without ending or charging', async (t) => {
  const h = await setup(
    t,
    () => ({ kind: 'wait', reason: 'No speech' }),
    undefined,
    false,
    undefined,
    () => {
      throw new Error('Upstream unavailable');
    },
    undefined,
    'ja',
    100,
  );
  await h.runtime.photos(randomUUID(), [h.photo]);
  await until(() => !h.runtime.game.credits.pending);
  assert.equal(h.runtime.state().creditsRemaining, 100);
  assert.equal(h.runtime.state().status, 'playing');
  assert.equal(h.runtime.state().lastCreditCharge, null);
});

test('credits: missing-delegation consultation and a later real delegation never charge twice', async (t) => {
  const h = await setup(t, (context) => ({
    kind: 'consult',
    evidenceSeq: context.conversation.eligibleEvidenceSeq,
    reason: 'Small talk',
    answer: '一緒にがんばろう。',
  }));
  await h.say('応援して');
  h.setNow(5000);
  h.runtime.tick();
  await until(() => h.runtime.state().creditsRemaining === 980);
  await h.delegate();
  await tick();
  assert.equal(h.runtime.state().creditsRemaining, 980);
  assert.equal(h.runtime.state().lastCreditCharge?.sequence, 1);
});

test('social admission lets Live compose its reply and charges once, including recovery and retries', async (t) => {
  const h = await setup(t, (context) => ({
    kind: 'consult',
    evidenceSeq: context.conversation.eligibleEvidenceSeq,
    responseKind: 'social',
    answer: '',
    reason: 'INTERNAL_SOCIAL_REASON',
  }));
  await h.say('応援して');
  h.setNow(5000);
  h.runtime.tick();
  await until(() => h.runtime.state().creditsRemaining === 980);
  const before = h.runtime.pollCommands(h.generation, 0).commands;
  assert.equal(before.length, 1);
  assert.deepEqual(
    liveBriefings(before).map((c) => JSON.parse(c.facts)),
    [{ type: 'social' }],
  );
  const id = randomUUID();
  await h.delegate(id);
  await h.delegate(id);
  await tick();
  assert.deepEqual(h.runtime.pollCommands(h.generation, 0).commands, before);
  assert.equal(h.runtime.state().creditsRemaining, 980);
  assert.equal(h.calls.reply, 0);
  assert.equal(h.calls.judge, 0);
  // A later request is a new conversation, even with identical wording.
  await h.say('応援して');
  await h.delegate();
  await until(() => h.runtime.state().creditsRemaining === 960);
  const after = liveBriefings(h.runtime.pollCommands(h.generation, 0).commands);
  assert.equal(after.length, 2);
  assert.notEqual(after[0]!.notificationId, after[1]!.notificationId);
});

test('long consultation produces one complete briefing and one speech trigger without a state echo', async (t) => {
  const facts = 'ロープはまだつながっている。'.repeat(80);
  const h = await setup(t, (context) => ({
    kind: 'consult',
    evidenceSeq: context.conversation.eligibleEvidenceSeq,
    answer: facts,
    reason: 'INTERNAL_LONG_REASON',
  }));
  await h.say('今の状態を教えて');
  const id = randomUUID();
  await h.delegate(id);
  await until(() => h.runtime.state().creditsRemaining === 980);
  const commands = h.runtime.pollCommands(h.generation, 0).commands;
  assert.ok(commands.length > 2);
  assert.equal(commands.filter((c) => c.type === 'session.commentary.append').length, 1);
  assert.equal(commands.at(-1)!.type, 'session.commentary.append');
  const briefings = liveBriefings(commands);
  assert.equal(briefings.length, 1);
  assert.deepEqual(JSON.parse(briefings[0]!.facts), {
    type: 'consultation',
    facts,
    requiresConfirmation: false,
    ambience: [],
  });
  assert.ok(
    commands.every((c) => JSON.parse(c.content).notificationId === briefings[0]!.notificationId),
  );
  assert.doesNotMatch(JSON.stringify(commands), /INTERNAL_LONG_REASON/);
  await h.delegate(id);
  await tick();
  assert.deepEqual(h.runtime.pollCommands(h.generation, 0).commands, commands);
  assert.equal(h.runtime.state().creditsRemaining, 980);
});

test('partially queued facts never trigger speech or charge the failed consultation', async (t) => {
  const h = await setup(t, (context) => ({
    kind: 'consult',
    evidenceSeq: context.conversation.eligibleEvidenceSeq,
    answer: '扉が閉まっている。'.repeat(100),
    reason: 'long facts',
  }));
  (h.runtime as unknown as { outbox: LiveOutbox }).outbox = new LiveOutbox(
    h.generation,
    h.runtime.game.controllerEpoch,
    Date.now,
    { maxCommands: 1, maxBytes: 64 * 1024 },
  );
  await h.say('状態を教えて');
  await h.delegate();
  await until(() => !!h.runtime.state().error);
  const commands = h.runtime.pollCommands(h.generation, 0).commands;
  assert.equal(commands.length, 1);
  assert.equal(commands[0]!.type, 'session.thinking.append');
  assert.deepEqual(liveBriefings(commands), []);
  assert.equal(h.runtime.state().creditsRemaining, 1000);
  assert.equal(h.runtime.game.credits.remaining, 1000);
  assert.equal(h.calls.judge, 0);
});

test('credits: Pro permits fifty short exchanges and keeps its credit notices out of Live', async (t) => {
  const h = await setup(t, (context) => ({
    kind: 'consult',
    evidenceSeq: context.conversation.eligibleEvidenceSeq,
    reason: 'Small talk',
    answer: '聞いているよ。',
  }));
  for (let i = 1; i <= 50; i++) {
    await h.say('応援して');
    await h.delegate();
    await until(() => h.runtime.state().creditsRemaining === 1000 - i * 20);
    const commands = h.runtime.pollCommands(h.generation, 0).commands;
    assert.doesNotMatch(
      commands.map((c) => c.content).join(''),
      /creditsRemaining|クレジット|credits/i,
    );
    assert.ok(liveBriefings(commands).every((c) => JSON.parse(c.facts).facts === '聞いているよ。'));
  }
  assert.equal(h.runtime.state().status, 'lost');
  assert.equal(h.runtime.state().endReason, 'credits_exhausted');
  assert.equal(h.runtime.state().lastCreditCharge?.sequence, 50);
  assert.deepEqual(h.notices, [
    'ご利用可能クレジットが残りわずかです',
    'クレジットを使い切りました。',
  ]);
});

test('reconnection keeps the original opening and puts new speech in a separate bubble', async (t) => {
  const h = await setup(t, () => ({ kind: 'wait', reason: 'waiting' }));
  const opening = h.feed().upserts[0]!;
  const live = await h.runtime.live(randomUUID(), 'new-offer');
  assert.equal(live.opening, null);
  h.runtime.heartbeat('connected');
  await h.runtime.event(live.generation, {
    type: 'session.output_transcript.delta',
    event_id: randomUUID(),
    delta: '戻ったよ。',
    start_ms: 10,
    end_ms: 100,
  });
  assert.equal(h.feed().upserts.length, 2);
  assert.deepEqual(h.feed().upserts[0], opening);
});

test('runtime accepts correction while classification is pending and discards the old execute result', async (t) => {
  const pending = deferred<unknown>();
  const contexts: any[] = [];
  const h = await setup(t, (context) => {
    contexts.push(context);
    if (contexts.length === 1) return pending.promise;
    return {
      kind: 'consult',
      evidenceSeq: context.conversation.eligibleEvidenceSeq,
      reason: '質問の分類理由',
      answer: 'まだ切らずに相談する',
    };
  });
  await h.runtime.photos(randomUUID(), [h.photo]);
  await until(() => h.calls.photo === 1);
  await tick();
  await h.say('ロープを切って');
  // The delegation call must resolve without waiting for the classifier's promise.
  await h.delegate();
  await until(() => contexts.length === 1);
  await h.say('いや、まだ切らないで。切れるかだけ教えて');
  assert.match(h.runtime.state().transcript, /まだ切らないで/);
  pending.resolve(execute(contexts[0]));
  await until(() =>
    h.runtime
      .pollCommands(h.generation, 0)
      .commands.some((c) => c.content.includes('まだ切らずに相談する')),
  );
  assert.equal(contexts.length, 2);
  assert.equal(h.calls.judge, 0);
  assert.equal(h.runtime.state().creditsRemaining, 880);
});

test('runtime consult consumes no action and a subsequent directive executes once', async (t) => {
  const h = await setup(t, (context) =>
    context.conversation.fragments.some((f: any) => f.delta === '実行して')
      ? execute(context)
      : {
          kind: 'consult',
          evidenceSeq: context.conversation.eligibleEvidenceSeq,
          reason: '質問の分類理由',
          answer: '切れるか相談中',
        },
  );
  await h.runtime.photos(randomUUID(), [h.photo]);
  await until(() => h.calls.photo === 1);
  await tick();
  await h.say('このハサミで切れるかな？');
  await h.delegate();
  await until(() =>
    h.runtime
      .pollCommands(h.generation, 0)
      .commands.some((c) => c.content.includes('切れるか相談中')),
  );
  assert.equal(h.calls.judge, 0);
  assert.equal(h.runtime.state().creditsRemaining, 880);
  await h.say('実行して');
  const id = randomUUID();
  await h.delegate(id);
  await until(() => h.runtime.state().actionsUsed === 1);
  await h.delegate(id);
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(h.calls.judge, 1);
  assert.equal(h.runtime.state().creditsRemaining, 860);
});

test('execution adds no server acknowledgement while judging and still delivers its result once', async (t) => {
  const gate = deferred<void>();
  const h = await setup(t, execute, undefined, false, gate.promise);
  t.after(() => gate.resolve());
  await h.runtime.photos(randomUUID(), [h.photo]);
  await until(() => h.calls.photo === 1);
  await tick();
  const before = h.runtime.pollCommands(h.generation, 0).commands;
  const lastSeq = before.at(-1)?.seq ?? 0;
  const newCommands = () =>
    h.runtime.pollCommands(h.generation, 0).commands.filter((c) => c.seq > lastSeq);
  await h.say('これでこじあけて');
  await h.runtime.event(h.generation, {
    type: 'session.output_transcript.delta',
    event_id: randomUUID(),
    delta: '受け取ったよ。',
    start_ms: 100,
    end_ms: 200,
  });
  const delegationId = randomUUID();
  await h.delegate(delegationId);
  await until(() => h.calls.judge === 1);
  assert.equal(h.runtime.state().busy, true);
  assert.equal(newCommands().filter((c) => c.type === 'session.commentary.append').length, 0);
  gate.resolve();
  await until(() =>
    liveBriefings(newCommands()).some((c) => JSON.parse(c.facts).type === 'action_result'),
  );
  await h.delegate(delegationId);
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(h.calls.judge, 1);
  assert.equal(h.runtime.state().creditsRemaining, 880);
  const briefings = liveBriefings(newCommands());
  assert.equal(briefings.length, 1);
  assert.equal(newCommands().filter((c) => c.type === 'session.commentary.append').length, 1);
  assert.equal(JSON.parse(briefings[0]!.facts).result, h.runtime.game.lastResult!.narrative);
  assert.equal(JSON.parse(briefings[0]!.facts).situation, h.runtime.game.situation);
  assert.equal(h.calls.reply, 0);
});

test('ambiguous photo use question arrives only after recognition and an upload retry does not repeat it', async (t) => {
  const gate = deferred<void>();
  const h = await setup(t, () => ({ kind: 'wait', reason: 'まだ指示なし' }), gate.promise);
  const requestId = randomUUID();
  const upload = h.runtime.photos(requestId, [h.photo]);
  await until(() => h.calls.recognize === 1);
  assert.equal(h.runtime.pollCommands(h.generation, 0).commands.length, 0);
  gate.resolve();
  await upload;
  await until(() => h.calls.photo === 1);
  await tick();
  const commands = h.runtime.pollCommands(h.generation, 0).commands;
  assert.equal(
    commands.filter(
      (c) => c.type === 'session.commentary.append' && c.content.includes('これをどう使う'),
    ).length,
    1,
  );
  await h.runtime.photos(requestId, [h.photo]);
  assert.deepEqual(h.runtime.pollCommands(h.generation, 0).commands, commands);
  assert.equal(h.calls.recognize, 1);
});

test('terminal voice retains generation and waits beyond 12 seconds for the final playback', async (t) => {
  const h = await setup(t, () => ({ kind: 'wait', reason: '未完了' }));
  await h.runtime.photos(randomUUID(), [h.photo]);
  await until(() => h.calls.photo === 1);
  await tick();
  h.runtime.game.end('won');
  assert.equal(h.runtime.state().generation, h.generation);
  const commands = h.runtime.pollCommands(h.generation, 0).commands;
  assert.ok(commands.length);
  const ack = commands.at(-1)!.seq;
  h.runtime.pollCommands(h.generation, ack);
  assert.throws(() => h.runtime.pollCommands(h.generation - 1, 0));
  await assert.rejects(
    () => h.runtime.event(h.generation - 1, {}),
    (e: any) => e.status === 409,
  );
  const before = h.calls.classify;
  await h.say('終了後の指示');
  await h.delegate();
  assert.equal(h.calls.classify, before);
  assert.doesNotMatch(JSON.stringify(h.feed()), /終了後の指示/);
  let sequence = 0;
  const report = (output: 'active' | 'quiet') =>
    h.runtime.reportVoiceActivity({
      generation: h.generation,
      sequence: ++sequence,
      input: 'unknown',
      output,
      playbackReady: true,
      inputStopped: true,
    });
  for (let now = 1000; now <= 21000; now += 1000) {
    h.setNow(now);
    report('active');
    assert.doesNotThrow(() => h.runtime.pollCommands(h.generation, ack));
  }
  h.setNow(22000);
  report('quiet');
  h.setNow(23000);
  report('quiet');
  h.setNow(24000);
  assert.throws(
    () => h.runtime.pollCommands(h.generation, 0),
    (e: any) => e.status === 410,
  );
  await assert.rejects(
    () => h.say('終了後の指示'),
    (e: any) => e.status === 410,
  );
});

test('terminal playback cannot extend the absolute play deadline or wait forever without telemetry', async (t) => {
  const h = await setup(t, () => ({ kind: 'wait', reason: 'none' }));
  h.runtime.game.end('won');
  assert.equal(h.runtime.closingAt, 61000);
  h.setNow(61000);
  assert.throws(
    () => h.runtime.pollCommands(h.generation, 0),
    (e: any) => e.status === 410,
  );
  const nearDeadline = await setup(t, () => ({ kind: 'wait', reason: 'none' }));
  nearDeadline.setNow(599000);
  nearDeadline.runtime.game.end('won');
  assert.equal(nearDeadline.runtime.closingAt, 600000);
});

test('diagnostics distinguish missing delegation, wait and expiration without raw speech or photos', async (t) => {
  const h = await setup(t, () => ({ kind: 'wait', reason: '未完了' }), undefined, true);
  await h.runtime.photos(randomUUID(), [h.photo]);
  await until(() => h.calls.photo === 1);
  await tick();
  await h.say('ハサミで切って');
  let trace = h.runtime.trace();
  assert.equal(trace.photoCount, 1);
  assert.equal(trace.recognizedItemCount, 1);
  assert.equal(trace.userFragmentCount, 1);
  assert.equal(trace.delegations?.length, 0);
  assert.ok(trace.diagnostics?.some((d) => d.stage === 'user_transcript_received'));
  await h.delegate();
  await until(
    () => h.runtime.trace().diagnostics?.some((d) => d.stage === 'decision_accepted') ?? false,
  );
  trace = h.runtime.trace();
  assert.ok(
    trace.diagnostics?.some((d) => d.stage === 'classification_returned' && d.code === 'wait'),
  );
  assert.equal(trace.delegations?.[0].status, 'pending');
  assert.equal(JSON.stringify(trace).includes('ハサミで切って'), false);
  assert.equal(JSON.stringify(trace).includes(h.photo), false);
  h.setNow(22000);
  assert.equal(h.runtime.trace().delegations?.[0].status, 'expired');
  h.runtime.game.end('expired');
  assert.deepEqual(h.runtime.trace(), { entries: [] });
});

test('diagnostics are absent when not enabled', async (t) => {
  const h = await setup(t, () => ({ kind: 'wait', reason: '未完了' }));
  await h.say('ハサミで切って');
  assert.equal(h.runtime.state().diagnosticsAvailable, undefined);
  assert.deepEqual(h.runtime.trace(), { entries: [] });
});

test('time warning waits for quiet, sends silent context once and survives reconnect without repetition', async (t) => {
  const h = await setup(t, () => ({ kind: 'wait', reason: 'none' }));
  h.runtime.game.clock.remainingMs = 60001;
  h.runtime.tick();
  assert.equal(h.notices.length, 0);
  h.setNow(1002);
  h.runtime.tick();
  assert.equal(h.notices.length, 0);
  h.quiet();
  h.runtime.tick();
  assert.equal(h.notices.length, 0);
  const commands = h.runtime.pollCommands(h.generation, 0).commands;
  assert.ok(commands.length > 0);
  assert.ok(
    commands.every((c) => c.type === 'session.thinking.append' && c.delegation_id === null),
  );
  assert.ok(
    commands.every((c) => c.noticeKind === 'time-warning' && Number.isSafeInteger(c.validUntil)),
  );
  assert.deepEqual(JSON.parse(commands.map((c) => c.content).join('')), {
    type: 'time_warning',
    message: 'おっと、残り時間が少なくなってきた。',
  });
  h.runtime.tick();
  assert.equal(h.notices.length, 0);
  await h.runtime.live(randomUUID(), 'new offer');
  h.runtime.heartbeat('connected');
  h.runtime.tick();
  assert.equal(h.notices.length, 0);
  assert.equal(h.runtime.pollCommands(h.runtime.game.generation, 0).commands.length, 0);
});

for (const speaker of ['input', 'output'] as const) {
  test(`time warning during ${speaker} speech adds no speak-now command or action`, async (t) => {
    const h = await setup(t, () => ({ kind: 'wait', reason: 'unfinished' }));
    await h.runtime.event(h.generation, {
      type: `session.${speaker}_transcript.delta`,
      event_id: randomUUID(),
      delta: 'この道具を使うと、',
      start_ms: 10,
      end_ms: 20,
    });
    h.runtime.reportVoiceActivity({
      generation: h.generation,
      sequence: 1,
      input: speaker === 'input' ? 'active' : 'quiet',
      output: speaker === 'output' ? 'active' : 'quiet',
      playbackReady: true,
    });
    h.runtime.game.clock.remainingMs = 59999;
    h.runtime.tick();
    assert.deepEqual(h.runtime.pollCommands(h.generation, 0).commands, []);
    await h.runtime.event(h.generation, {
      type: `session.${speaker}_transcript.delta`,
      event_id: randomUUID(),
      delta: 'まだ続きを話している。',
      start_ms: 21,
      end_ms: 30,
    });
    h.runtime.tick();
    assert.deepEqual(h.runtime.pollCommands(h.generation, 0).commands, []);
    // Even a quiet estimate is not proof that this unfinished sentence ended.
    h.quiet(2);
    h.runtime.tick();
    const commands = h.runtime.pollCommands(h.generation, 0).commands;
    assert.ok(commands.length > 0);
    assert.ok(commands.every((c) => c.type === 'session.thinking.append'));
    h.runtime.tick();
    assert.deepEqual(h.runtime.pollCommands(h.generation, 0).commands, commands);
    assert.equal(h.calls.classify, 0);
    assert.equal(h.calls.judge, 0);
  });
}

test('time warning respects pause, disabled setting, configured message and terminal state', async (t) => {
  const h = await setup(t, () => ({ kind: 'wait', reason: 'none' }));
  const warning = h.snapshot.coreConfig.warnings;
  warning.milestones[0]!.thresholdSeconds = 30;
  warning.milestones[0]!.message.ja = 'あと{thresholdSeconds}秒未満です';
  h.quiet();
  h.runtime.game.clock.remainingMs = 29999;
  h.runtime.game.clock.pause('test');
  h.setNow(2000);
  h.runtime.tick();
  assert.equal(h.notices.length, 0);
  assert.equal(h.runtime.game.clock.remainingMs, 29999);
  h.runtime.game.clock.resume('test');
  warning.enabled = false;
  h.runtime.tick();
  assert.equal(h.notices.length, 0);
  warning.enabled = true;
  h.runtime.tick();
  assert.deepEqual(h.notices, []);
  const commands = h.runtime.pollCommands(h.generation, 0).commands;
  assert.ok(commands.every((c) => c.type === 'session.thinking.append'));
  assert.equal(JSON.parse(commands.map((c) => c.content).join('')).message, 'あと30秒未満です');
  const ended = await setup(t, () => ({ kind: 'wait', reason: 'none' }));
  ended.runtime.game.clock.remainingMs = 0;
  ended.runtime.tick();
  assert.equal(ended.runtime.state().status, 'lost');
  assert.deepEqual(ended.notices, []);
});

test('time warning waits for connection recovery and preserves long localized messages', async (t) => {
  const h = await setup(
    t,
    () => ({ kind: 'wait', reason: 'none' }),
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    'en',
  );
  const message = 'We are running short on time. '.repeat(40) + 'Less than {thresholdSeconds}s.';
  h.snapshot.coreConfig.warnings.milestones[0]!.message.en = message;
  h.runtime.game.clock.remainingMs = 59999;
  h.runtime.heartbeat('disconnected');
  h.runtime.tick();
  assert.deepEqual(h.notices, []);
  h.runtime.heartbeat('connected');
  h.quiet();
  h.runtime.tick();
  const commands = h.runtime.pollCommands(h.generation, 0).commands;
  assert.ok(commands.length > 1);
  assert.ok(commands.every((c) => c.type === 'session.thinking.append'));
  assert.ok(commands.every((c) => Buffer.byteLength(c.content) <= 480));
  assert.deepEqual(JSON.parse(commands.map((c) => c.content).join('')), {
    type: 'time_warning',
    message: message.replaceAll('{thresholdSeconds}', '60'),
  });
});

test('final warning supersedes pending normal context and speaks after the bounded wait', async (t) => {
  const h = await setup(t, () => ({ kind: 'wait', reason: 'none' }));
  h.runtime.game.clock.remainingMs = 59999;
  h.runtime.tick();
  assert.deepEqual(h.runtime.pollCommands(h.generation, 0).commands, []);
  h.runtime.game.clock.remainingMs = 15000;
  h.runtime.tick();
  h.setNow(3999);
  h.runtime.tick();
  assert.deepEqual(h.runtime.pollCommands(h.generation, 0).commands, []);
  h.setNow(4000);
  h.runtime.tick();
  const commands = h.runtime.pollCommands(h.generation, 0).commands;
  assert.equal(commands.length, 1);
  assert.equal(commands[0]!.type, 'session.commentary.append');
  assert.equal(
    liveBriefings(commands)[0]!.facts,
    h.snapshot.coreConfig.warnings.milestones[1]!.transitionMessage.ja,
  );
  assert.equal(commands[0]!.noticeKind, 'time-warning');
  h.quiet();
  h.runtime.tick();
  assert.deepEqual(h.runtime.pollCommands(h.generation, 0).commands, commands);
});

test('consult speaks answer rather than classification reason and action speaks latest situation with image', async (t) => {
  const contexts: any[] = [];
  const h = await setup(t, (context) => {
    contexts.push(context);
    return context.conversation.fragments.some((f: any) => f.delta === '切って')
      ? execute(context)
      : {
          kind: 'consult',
          evidenceSeq: context.conversation.eligibleEvidenceSeq,
          reason: 'INTERNAL_ROUTING_REASON',
          answer: '手首はまだ縄で縛られているよ。',
        };
  });
  await h.runtime.photos(randomUUID(), [h.photo]);
  await until(() => h.calls.photo === 1);
  await tick();
  await h.say('今どういう状況？');
  await h.delegate();
  await until(() =>
    h.runtime
      .pollCommands(h.generation, 0)
      .commands.some((c) => c.content.includes('手首はまだ縄で縛られているよ。')),
  );
  assert.equal(contexts[0].game.publicState.situation, h.runtime.game.situation);
  assert.equal(contexts[0].game.obstacle, undefined);
  assert.equal(
    JSON.stringify(h.runtime.pollCommands(h.generation, 0)).includes('INTERNAL_ROUTING_REASON'),
    false,
  );
  await h.say('切って');
  await h.delegate();
  await until(() => h.calls.judge === 1 && h.runtime.state().actionsUsed === 1);
  const actionFacts = liveBriefings(h.runtime.pollCommands(h.generation, 0).commands)
    .map((briefing) => JSON.parse(briefing.facts))
    .find((facts) => facts.type === 'action_result');
  assert.equal(
    actionFacts.situation,
    `${actionFacts.currentObstacleGuide.explanation}\n\n${actionFacts.currentObstacleGuide.hint}`,
  );
  assert.equal(h.scenes.length, 2);
  assert.equal(h.scenes[1].situation, h.runtime.game.situation);
  assert.equal(h.scenes[0].action, null);
  assert.equal(h.scenes[1].action.success, false);
  assert.equal(h.scenes[1].action.usage, 'ハサミでロープを切って');
  assert.equal(h.scenes[1].action.items[0].name, 'ハサミ');
});

test('runtime missing delegation requests recovery but never judges, then announces timeout', async (t) => {
  const h = await setup(t, execute);
  await h.runtime.photos(randomUUID(), [h.photo]);
  await until(() => h.calls.photo === 1);
  await tick();
  await h.say('切って');
  h.setNow(4001);
  h.runtime.tick();
  await until(() =>
    h.runtime
      .pollCommands(h.generation, 0)
      .commands.some((c) => c.type === 'session.instructions.append'),
  );
  assert.equal(h.calls.judge, 0);
  assert.equal(h.runtime.state().creditsRemaining, 900);
  h.setNow(24002);
  h.runtime.tick();
  assert.equal(h.notices.length, 1);
  assert.equal(h.calls.judge, 0);
});

const obviousPhoto = (input: any) => ({
  decision: 'execute',
  usage: 'ハサミでロープを切って',
  itemRefs: [{ photoId: input.photos[0] }],
  message: 'やってみる。',
  reason: '切る道具を求めているため',
});

const recoveredJudgment = {
  success: false,
  narrative: 'ロープが少し緩んだ。',
  situation: '結び目が緩んでいる。',
  shortReason: '結び目を動かした',
  inventoryChanges: [],
  factChanges: [{ key: 'wrists', from: 'bound', to: 'loosened' }],
};

for (const stage of ['recognize', 'photo', 'classify', 'judge'] as const) {
  test(`a malformed ${stage} response recovers inside the full voice flow without an error notice`, async (t) => {
    const attempts = { recognize: 0, photo: 0, classify: 0, judge: 0 };
    const h = await setup(
      t,
      (context) => {
        if (++attempts.classify === 1 && stage === 'classify') return { kind: 'INVALID' };
        return execute(context);
      },
      undefined,
      false,
      undefined,
      () => {
        if (++attempts.photo === 1 && stage === 'photo') return {};
        return {
          decision: 'clarify',
          usage: '',
          itemRefs: [],
          message: '使い方を待っている。',
          reason: 'No directive yet',
        };
      },
      () => {
        if (++attempts.judge === 1 && stage === 'judge') return {};
        return recoveredJudgment;
      },
      'ja',
      1000,
      undefined,
      (context) => {
        if (++attempts.recognize === 1 && stage === 'recognize') return { items: null };
        return {
          items: context.photos.map((p: any) => ({
            photoId: p.id,
            inventoryId: null,
            name: 'ハサミ',
          })),
          usage: '',
          summary: 'ハサミ',
        };
      },
    );
    await h.runtime.photos(randomUUID(), [h.photo]);
    await until(() => h.calls.photo === (stage === 'photo' ? 2 : 1));
    await tick();
    await h.say('そのハサミでロープを切って');
    await h.delegate();
    await until(() => h.runtime.game.actionsUsed === 1 && h.scenes.length === 2);
    assert.equal(attempts[stage], 2);
    assert.equal(h.runtime.game.credits.remaining, 880);
    assert.equal(h.runtime.game.inventory.length, 1);
    assert.equal(h.runtime.game.error, null);
    assert.equal(h.runtime.game.retainedRequest, null);
    const briefings = liveBriefings(h.runtime.pollCommands(h.generation, 0).commands).map((c) =>
      JSON.parse(c.facts),
    );
    assert.equal(briefings.filter((b) => b.type === 'action_result').length, 1);
    assert.equal(briefings.filter((b) => b.type === 'request_unavailable').length, 0);
  });
}

test('runtime repairs malformed judgment silently, then publishes and charges once', async (t) => {
  const judgments: any[] = [];
  const h = await setup(t, execute, undefined, false, undefined, undefined, (context) => {
    judgments.push(context);
    return judgments.length === 1 ? { success: 'invalid' } : recoveredJudgment;
  });
  await h.runtime.photos(randomUUID(), [h.photo]);
  await until(() => h.calls.photo === 1);
  await tick();
  const lastSeq = h.runtime.pollCommands(h.generation, 0).commands.at(-1)?.seq ?? 0;
  await h.say('これでロープを切って');
  const delegation = randomUUID();
  await h.delegate(delegation);
  await until(() => h.runtime.game.actionsUsed === 1 && h.scenes.length === 2);
  await h.delegate(delegation);
  await tick();
  assert.equal(h.calls.judge, 2);
  assert.equal(h.runtime.game.credits.remaining, 880);
  assert.equal(h.runtime.game.retainedRequest, null);
  assert.equal(h.runtime.game.error, null);
  assert.deepEqual(judgments[0].proposal, judgments[1].proposal);
  assert.equal(judgments[1].judgmentRepair, 'AI_OUTPUT_INVALID');
  const briefings = liveBriefings(
    h.runtime.pollCommands(h.generation, 0).commands.filter((c) => c.seq > lastSeq),
  );
  assert.equal(briefings.length, 1);
  assert.equal(JSON.parse(briefings[0]!.facts).type, 'action_result');
});

test('exhausted classification reports once, preserves user evidence and does not repeat the error at expiry', async (t) => {
  let allow = false;
  const h = await setup(t, (context) => (allow ? execute(context) : { kind: 'INVALID' }));
  await h.runtime.photos(randomUUID(), [h.photo]);
  await until(() => h.calls.photo === 1);
  await tick();
  await h.say('ハサミでロープを切って');
  await h.delegate();
  const unavailable = () =>
    liveBriefings(h.runtime.pollCommands(h.generation, 0).commands)
      .map((c) => JSON.parse(c.facts))
      .filter((c) => c.type === 'request_unavailable');
  await until(() => unavailable().length === 1);
  assert.equal(h.calls.classify, 2);
  h.setNow(24002);
  h.runtime.tick();
  await tick();
  assert.equal(unavailable().length, 1);
  assert.equal(h.calls.classify, 2);
  allow = true;
  await h.delegate();
  await until(() => h.runtime.game.actionsUsed === 1);
  assert.equal(h.calls.classify, 3);
  assert.equal(h.runtime.game.credits.remaining, 880);
});

for (const origin of ['photo', 'voice'] as const) {
  test(`failed ${origin} request resumes from new evidence without another explanation or duplicate charge`, async (t) => {
    let attempt = 0;
    const contexts: any[] = [];
    const judgments: any[] = [];
    const h = await setup(
      t,
      (context) => {
        contexts.push(context);
        return context.game.retainedRequest
          ? {
              kind: 'retry_request',
              evidenceSeq: context.conversation.eligibleEvidenceSeq,
              reason: 'Explicit request to resume',
            }
          : execute(context);
      },
      undefined,
      false,
      undefined,
      origin === 'photo' ? obviousPhoto : undefined,
      (context) => {
        judgments.push(context);
        return ++attempt <= 2 ? { success: 'invalid' } : recoveredJudgment;
      },
    );
    await h.runtime.photos(randomUUID(), [h.photo]);
    if (origin === 'voice') {
      await until(() => h.calls.photo === 1);
      await tick();
      await h.say('これでロープを切って');
      await h.delegate();
    }
    await until(() => !!h.runtime.game.retainedRequest && !h.runtime.game.credits.pending);
    await tick();
    const retained = h.runtime.game.retainedRequest!;
    assert.equal(h.calls.judge, 2);
    assert.equal(h.runtime.game.actionsUsed, 0);
    assert.equal(h.runtime.game.credits.remaining, origin === 'photo' ? 1000 : 900);
    assert.equal(h.runtime.game.inventory.length, 0);
    assert.equal(h.runtime.game.photos.length, 1);
    const notices = liveBriefings(h.runtime.pollCommands(h.generation, 0).commands)
      .map((c) => JSON.parse(c.facts))
      .filter((c) => c.type === 'request_unavailable');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].requestRetained, true);
    assert.equal(notices[0].requiresRestatement, false);
    assert.doesNotMatch(notices[0].facts, /もう一度|教えて|確認でき/);
    await h.say('もう一度やって');
    const delegation = randomUUID();
    await h.delegate(delegation);
    await until(() => h.runtime.game.actionsUsed === 1 && h.scenes.length === 2);
    await h.delegate(delegation);
    await tick();
    assert.equal(h.calls.judge, 3);
    assert.equal(h.calls.recognize, 1);
    assert.equal(h.calls.photo, 1);
    assert.equal(h.runtime.game.inventory.length, 1);
    assert.equal(h.runtime.game.credits.remaining, origin === 'photo' ? 900 : 880);
    assert.equal(h.runtime.game.retainedRequest, null);
    assert.equal(h.runtime.game.error, null);
    assert.equal(judgments[2].proposal.usage, judgments[0].proposal.usage);
    const supplied = contexts.at(-1).game.retainedRequest;
    assert.deepEqual(supplied.itemRefs, retained.intent.itemRefs);
    assert.equal(supplied.usage, retained.intent.usage);
    assert.equal(supplied.actionId, undefined);
    assert.equal(supplied.origin, undefined);
    assert.equal(supplied.reason, undefined);
  });
}

test('explicit cancellation clears the failed request without an action or charge', async (t) => {
  const h = await setup(
    t,
    (context) => ({
      kind: 'cancel_request',
      evidenceSeq: context.conversation.eligibleEvidenceSeq,
      reason: 'User abandoned the request',
    }),
    undefined,
    false,
    undefined,
    obviousPhoto,
    () => ({ success: 'invalid' }),
  );
  await h.runtime.photos(randomUUID(), [h.photo]);
  await until(() => !!h.runtime.game.retainedRequest && !h.runtime.game.credits.pending);
  await h.say('やっぱりその道具は使わないで');
  await h.delegate();
  await until(() => h.runtime.game.retainedRequest === null);
  await tick();
  assert.equal(h.calls.judge, 2);
  assert.equal(h.runtime.game.actionsUsed, 0);
  assert.equal(h.runtime.game.credits.remaining, 1000);
});

test('obvious photo starts one action without a usage question or fabricated delegation', async (t) => {
  const h = await setup(t, execute, undefined, false, undefined, obviousPhoto);
  const requestId = randomUUID();
  await h.runtime.photos(requestId, [h.photo]);
  await until(() => h.runtime.state().actionsUsed === 1 && h.scenes.length === 2);
  await h.runtime.photos(requestId, [h.photo]);
  await tick();
  assert.equal(h.calls.photo, 1);
  assert.equal(h.calls.classify, 0);
  assert.equal(h.calls.judge, 1);
  assert.equal(h.runtime.state().creditsRemaining, 900);
  const spoken = h.runtime
    .pollCommands(h.generation, 0)
    .commands.filter((c) => c.type === 'session.commentary.append');
  assert.ok(spoken.length > 0);
  assert.ok(spoken.every((c) => c.delegation_id === null));
  assert.ok(spoken.every((c) => !c.content.includes('これをどう使う')));
});

test('split explicit stop cancels an automatic photo action without a control model call', async (t) => {
  const gate = deferred<void>();
  const h = await setup(t, execute, undefined, false, gate.promise, obviousPhoto);
  t.after(() => gate.resolve());
  await h.runtime.photos(randomUUID(), [h.photo]);
  await until(() => h.calls.judge === 1);
  await h.say('ちょっと');
  assert.ok(h.runtime.game.pendingActionId);
  await h.say('待って');
  await until(() => h.runtime.game.pendingActionId === null);
  gate.resolve();
  await tick();
  await tick();
  assert.equal(h.runtime.state().actionsUsed, 0);
  assert.equal(h.runtime.game.gameVersion, 0);
  assert.equal(h.scenes.length, 1);
  assert.equal(h.runtime.state().creditsRemaining, 900);
  assert.equal(h.calls.schemas.includes('harness_control'), false);
  assert.ok(
    h.runtime
      .pollCommands(h.generation, 0)
      .commands.some((command) => command.content.includes('止める')),
  );
});

for (const phrase of ['ちょっと待って。', 'もうやめて！', '一旦止めて。']) {
  test(`a common explicit stop phrase cancels in one subtitle: ${phrase}`, async (t) => {
    const gate = deferred<void>();
    const h = await setup(t, execute, undefined, false, gate.promise, obviousPhoto);
    t.after(() => gate.resolve());
    await h.runtime.photos(randomUUID(), [h.photo]);
    await until(() => h.calls.judge === 1);
    await h.say(phrase);
    await until(() => h.runtime.game.pendingActionId === null);
    gate.resolve();
    await tick();
    assert.equal(h.runtime.game.actionsUsed, 0);
    assert.equal(h.calls.judge, 1);
  });
}

test('an explicit English stop cancels the current action once', async (t) => {
  const gate = deferred<void>();
  const h = await setup(t, execute, undefined, false, gate.promise, obviousPhoto, undefined, 'en');
  t.after(() => gate.resolve());
  await h.runtime.photos(randomUUID(), [h.photo]);
  await until(() => h.calls.judge === 1);
  await h.say('please stop!');
  await until(() => h.runtime.game.pendingActionId === null);
  await h.say('stop');
  gate.resolve();
  await tick();
  assert.equal(h.runtime.game.actionsUsed, 0);
  assert.equal(h.calls.judge, 1);
  assert.equal(h.calls.schemas.includes('harness_control'), false);
});

test('repeated and corrected instructions do not interrupt an automatic action', async (t) => {
  const gate = deferred<void>();
  const h = await setup(t, execute, undefined, false, gate.promise, obviousPhoto);
  t.after(() => gate.resolve());
  await h.runtime.photos(randomUUID(), [h.photo]);
  await until(() => h.calls.judge === 1);
  await h.say('ハサミでロープを切って');
  await h.delegate();
  await h.say('じゃあハサミで');
  await h.delegate();
  await h.say('いや、ドライバーで外そう');
  await h.delegate();
  await h.say('止めないで、続けて');
  await h.delegate();
  assert.ok(h.runtime.game.pendingActionId);
  gate.resolve();
  await until(() => h.runtime.state().actionsUsed === 1 && h.scenes.length === 2);
  await h.delegate();
  await tick();
  assert.equal(h.calls.judge, 1);
  assert.equal(h.calls.schemas.includes('harness_control'), false);
  assert.equal(h.runtime.game.gameVersion, 1);
});

test('a correction during judgment does not abort or replace the reserved action', async (t) => {
  const gate = deferred<void>();
  const correction = '切る場所を変えて。手首から離れたロープの端を切って';
  const h = await setup(t, execute, undefined, false, gate.promise, obviousPhoto);
  t.after(() => gate.resolve());
  await h.runtime.photos(randomUUID(), [h.photo]);
  await until(() => h.calls.judge === 1);
  await h.say(correction);
  await h.delegate();
  assert.ok(h.runtime.game.pendingActionId);
  gate.resolve();
  await until(() => h.runtime.game.gameVersion === 1 && h.scenes.length === 2);
  assert.equal(h.calls.judge, 1);
  assert.equal(h.calls.schemas.includes('harness_control'), false);
  assert.equal(h.runtime.game.actionsUsed, 1);
  assert.equal(h.runtime.game.committedActions.length, 1);
  assert.equal(h.runtime.game.committedActions[0]!.usage, 'ハサミでロープを切って');
  assert.equal(h.runtime.game.credits.remaining, 900);
});

for (const origin of ['photo', 'voice'] as const) {
  for (const probability of [0, 1]) {
    test(`creative ${origin} action ignores retired probability ${probability} and succeeds once`, async (t) => {
      const h = await setup(
        t,
        execute,
        undefined,
        false,
        undefined,
        origin === 'photo' ? obviousPhoto : undefined,
        async () => ({
          success: true,
          narrative: 'PRIVATE_CREATIVE_CANDIDATE',
          situation: 'PRIVATE_CREATIVE_CANDIDATE',
          shortReason: 'PRIVATE_CREATIVE_CANDIDATE',
          inventoryChanges: [],
          factChanges: [{ key: 'wrists', from: 'bound', to: 'free' }],
          creativity: {
            kind: 'stretch',
            approach: 'Use scissors with implausible cutting strength',
            equivalentAttemptId: null,
            effect: 'edge',
          },
        }),
        'ja',
        1000,
        probability,
      );
      const photoRequest = randomUUID();
      await h.runtime.photos(photoRequest, [h.photo]);
      if (origin === 'voice') {
        await until(() => h.calls.photo === 1);
        await h.say('その道具で切って');
        await h.delegate();
      }
      await until(() => h.runtime.game.actionsUsed === 1 && h.scenes.length === 2);
      await tick();
      assert.equal(h.calls.judge, 1);
      assert.equal(h.runtime.game.obstacleIndex, 1);
      assert.equal(h.runtime.game.facts.values.wrists, 'free');
      assert.equal(h.runtime.game.lastResult!.success, true);
      assert.equal(h.runtime.game.credits.remaining, origin === 'photo' ? 900 : 880);
      const scene = h.scenes[1]!;
      const sceneCommands = h.runtime
        .pollCommands(h.generation, 0)
        .commands.filter((command) => command.messageId === scene.messageId);
      const commands = sceneCommands.filter(
        (command) => command.type === 'session.commentary.append',
      );
      assert.equal(commands.length, 1);
      const published = JSON.stringify([scene, commands, h.runtime.game.state()]);
      assert.equal(published.includes('PRIVATE_CREATIVE_CANDIDATE'), false);
      assert.equal(published.includes('equivalentAttemptId'), false);
      assert.match(scene.text, /思いがけない切れ味/);
      const spoken = liveBriefings(sceneCommands);
      assert.equal(spoken.length, 1);
      assert.match(spoken[0]!.facts, /思いがけない切れ味/);
      await h.runtime.photos(photoRequest, [h.photo]);
      assert.equal(h.calls.judge, 1);
      assert.equal(h.runtime.game.actionsUsed, 1);
    });
  }
}
