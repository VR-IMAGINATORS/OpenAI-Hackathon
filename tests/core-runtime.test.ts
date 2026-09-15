import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { GameRuntime } from '../apps/local-server/hosted-runtime.js';
import { ScenarioCatalog } from '../apps/server/scenario-catalog.js';
import { PhotoQueue } from '../apps/server/photo-queue.js';
import { ResultStore } from '../apps/server/result-store.js';
import { AiService } from '../packages/server/ai-service.js';
import { loadAiConfig } from '../packages/server/ai-config.js';
import { localizeScenario } from '../packages/shared/scenario.js';

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
  locale: 'ja' | 'en' = 'ja',
) {
  let now = 1000;
  const calls = { classify: 0, judge: 0, recognize: 0 };
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
      async createResponse(body) {
        assert.equal((body as any).model, 'gpt-5.6-sol');
        assert.deepEqual((body as any).reasoning, { effort: 'low' });
        const parts = (body as any).input[0].content;
        const context = JSON.parse(parts.find((part: any) => part.type === 'input_text').text);
        if (context.conversation) {
          calls.classify++;
          return response({ decision: await classify(context) });
        }
        if (context.proposal) {
          calls.judge++;
          await judgeGate;
          return response({
            success: false,
            narrative: 'ロープは切れなかった。',
            situation: 'ロープはまだつながっている。',
            inventoryChanges: [],
            factChanges: [],
            shortReason: '届かなかった',
          });
        }
        calls.recognize++;
        await recognizeGate;
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
  assert.equal(h.runtime.state().photoSendsRemaining, 4);
  assert.equal(h.calls.judge, 0);
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
      .commands.some((c) => c.content === 'まだ切らずに相談する'),
  );
  assert.equal(contexts.length, 2);
  assert.equal(h.calls.judge, 0);
  assert.equal(h.runtime.state().photoSendsRemaining, 3);
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
  await h.say('このハサミで切れるかな？');
  await h.delegate();
  await until(() =>
    h.runtime.pollCommands(h.generation, 0).commands.some((c) => c.content === '切れるか相談中'),
  );
  assert.equal(h.calls.judge, 0);
  assert.equal(h.runtime.state().photoSendsRemaining, 3);
  await h.say('実行して');
  const id = randomUUID();
  await h.delegate(id);
  await until(() => h.runtime.state().actionsUsed === 1);
  await h.delegate(id);
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(h.calls.judge, 1);
  assert.equal(h.runtime.state().photoSendsRemaining, 3);
});

test('execution adds no server acknowledgement while judging and still delivers its result once', async (t) => {
  const gate = deferred<void>();
  const h = await setup(t, execute, undefined, false, gate.promise);
  t.after(() => gate.resolve());
  await h.runtime.photos(randomUUID(), [h.photo]);
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
    newCommands().some(
      (c) =>
        c.type === 'session.commentary.append' && c.content.startsWith('ロープは切れなかった。'),
    ),
  );
  await h.delegate(delegationId);
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(h.calls.judge, 1);
  assert.equal(h.runtime.state().photoSendsRemaining, 3);
  assert.deepEqual(
    newCommands()
      .filter((c) => c.type === 'session.commentary.append')
      .map((c) => c.content),
    ['ロープは切れなかった。\n現在の状況: ' + h.runtime.game.situation],
  );
  assert.equal(newCommands().filter((c) => c.type === 'session.thinking.append').length, 0);
});

test('photo use question arrives only after recognition and an upload retry does not repeat it', async (t) => {
  const gate = deferred<void>();
  const h = await setup(t, () => ({ kind: 'wait', reason: 'まだ指示なし' }), gate.promise);
  const requestId = randomUUID();
  const upload = h.runtime.photos(requestId, [h.photo]);
  await until(() => h.calls.recognize === 1);
  assert.equal(h.runtime.pollCommands(h.generation, 0).commands.length, 0);
  gate.resolve();
  await upload;
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

test('terminal voice grace retains generation, rejects stale polls and closes at the deadline', async (t) => {
  const h = await setup(t, () => ({ kind: 'wait', reason: '未完了' }));
  await h.runtime.photos(randomUUID(), [h.photo]);
  h.runtime.game.end('won');
  assert.equal(h.runtime.state().generation, h.generation);
  assert.ok(h.runtime.pollCommands(h.generation, 0).commands.length);
  assert.throws(() => h.runtime.pollCommands(h.generation - 1, 0));
  await assert.rejects(
    () => h.runtime.event(h.generation - 1, {}),
    (e: any) => e.status === 409,
  );
  h.setNow(12999);
  assert.doesNotThrow(() => h.runtime.pollCommands(h.generation, 0));
  h.setNow(13000);
  assert.throws(
    () => h.runtime.pollCommands(h.generation, 0),
    (e: any) => e.status === 410,
  );
  await assert.rejects(
    () => h.say('終了後の指示'),
    (e: any) => e.status === 410,
  );
});

test('diagnostics distinguish missing delegation, wait and expiration without raw speech or photos', async (t) => {
  const h = await setup(t, () => ({ kind: 'wait', reason: '未完了' }), undefined, true);
  await h.runtime.photos(randomUUID(), [h.photo]);
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

test('time warning sends silent context once and survives reconnect without repetition', async (t) => {
  const h = await setup(t, () => ({ kind: 'wait', reason: 'none' }));
  h.runtime.game.clock.remainingMs = 60000;
  h.runtime.tick();
  assert.equal(h.notices.length, 0);
  h.setNow(1001);
  h.runtime.tick();
  assert.equal(h.notices.length, 1);
  const commands = h.runtime.pollCommands(h.generation, 0).commands;
  assert.ok(commands.length > 0);
  assert.ok(commands.every((c) => c.type === 'session.thinking.append' && c.delegation_id === null));
  assert.deepEqual(JSON.parse(commands.map((c) => c.content).join('')), {
    type: 'time_warning',
    message: 'おっと、残り時間が少なくなってきた。',
  });
  h.runtime.tick();
  assert.equal(h.notices.length, 1);
  await h.runtime.live(randomUUID(), 'new offer');
  h.runtime.heartbeat('connected');
  h.runtime.tick();
  assert.equal(h.notices.length, 1);
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
    h.runtime.game.clock.remainingMs = 59999;
    h.runtime.tick();
    const commands = h.runtime.pollCommands(h.generation, 0).commands;
    assert.ok(commands.length > 0);
    assert.ok(commands.every((c) => c.type === 'session.thinking.append'));
    await h.runtime.event(h.generation, {
      type: `session.${speaker}_transcript.delta`,
      event_id: randomUUID(),
      delta: 'まだ続きを話している。',
      start_ms: 21,
      end_ms: 30,
    });
    h.runtime.tick();
    assert.deepEqual(h.runtime.pollCommands(h.generation, 0).commands, commands);
    assert.equal(h.calls.classify, 0);
    assert.equal(h.calls.judge, 0);
  });
}

test('time warning respects pause, disabled setting, configured message and terminal state', async (t) => {
  const h = await setup(t, () => ({ kind: 'wait', reason: 'none' }));
  const warning = h.snapshot.coreConfig.timeWarning!;
  warning.thresholdSeconds = 30;
  warning.message.ja = 'あと{thresholdSeconds}秒未満です';
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
  assert.deepEqual(h.notices, ['あと30秒未満です']);
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
    'en',
  );
  const message = 'We are running short on time. '.repeat(40) + 'Less than {thresholdSeconds}s.';
  h.snapshot.coreConfig.timeWarning!.message.en = message;
  h.runtime.game.clock.remainingMs = 59999;
  h.runtime.heartbeat('disconnected');
  h.runtime.tick();
  assert.deepEqual(h.notices, []);
  h.runtime.heartbeat('connected');
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
  await h.say('今どういう状況？');
  await h.delegate();
  await until(() =>
    h.runtime
      .pollCommands(h.generation, 0)
      .commands.some((c) => c.content === '手首はまだ縄で縛られているよ。'),
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
  assert.ok(
    h.runtime
      .pollCommands(h.generation, 0)
      .commands.some(
        (c) =>
          c.type === 'session.commentary.append' &&
          c.content.includes('現在の状況: ' + h.runtime.game.situation),
      ),
  );
  assert.equal(h.scenes.length, 2);
  assert.equal(h.scenes[1].situation, h.runtime.game.situation);
});

test('runtime missing delegation requests recovery but never judges, then announces timeout', async (t) => {
  const h = await setup(t, execute);
  await h.runtime.photos(randomUUID(), [h.photo]);
  await h.say('切って');
  h.setNow(4001);
  h.runtime.tick();
  await until(() =>
    h.runtime
      .pollCommands(h.generation, 0)
      .commands.some((c) => c.type === 'session.instructions.append'),
  );
  assert.equal(h.calls.judge, 0);
  assert.equal(h.runtime.state().photoSendsRemaining, 3);
  h.setNow(24002);
  h.runtime.tick();
  assert.equal(h.notices.length, 1);
  assert.equal(h.calls.judge, 0);
});
