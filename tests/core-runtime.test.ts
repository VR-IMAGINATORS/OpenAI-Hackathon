import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { GameRuntime } from '../apps/local-server/hosted-runtime.js';
import { ScenarioCatalog } from '../apps/server/scenario-catalog.js';
import { PhotoQueue } from '../apps/server/photo-queue.js';
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
        const parts = (body as any).input[0].content;
        const context = JSON.parse(parts.find((part: any) => part.type === 'input_text').text);
        if (context.conversation) {
          calls.classify++;
          return response({ decision: await classify(context) });
        }
        if (context.proposal) {
          calls.judge++;
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
  const snapshot = new ScenarioCatalog({
    scenarioPath: 'scenarios/mobile-playtest.json',
    coreConfigPath: 'config/game-core.json',
  }).current('ja');
  const queue = new PhotoQueue();
  const runtime = new GameRuntime(
    randomUUID(),
    600000,
    localizeScenario(snapshot.scenarioV2, 'ja'),
    ai,
    config,
    queue,
    () => now,
    snapshot,
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

test('runtime accepts correction while classification is pending and discards the old execute result', async (t) => {
  const pending = deferred<unknown>();
  const contexts: any[] = [];
  const h = await setup(t, (context) => {
    contexts.push(context);
    if (contexts.length === 1) return pending.promise;
    return {
      kind: 'consult',
      evidenceSeq: context.conversation.eligibleEvidenceSeq,
      reason: 'まだ切らずに相談する',
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
  assert.equal(h.runtime.state().actionsRemaining, 4);
});

test('runtime consult consumes no action and a subsequent directive executes once', async (t) => {
  const h = await setup(t, (context) =>
    context.conversation.fragments.some((f: any) => f.delta === '切って')
      ? execute(context)
      : {
          kind: 'consult',
          evidenceSeq: context.conversation.eligibleEvidenceSeq,
          reason: '切れるか相談中',
        },
  );
  await h.runtime.photos(randomUUID(), [h.photo]);
  await h.say('このハサミで切れるかな？');
  await h.delegate();
  await until(() =>
    h.runtime.pollCommands(h.generation, 0).commands.some((c) => c.content === '切れるか相談中'),
  );
  assert.equal(h.calls.judge, 0);
  assert.equal(h.runtime.state().actionsRemaining, 4);
  await h.say('切って');
  const id = randomUUID();
  await h.delegate(id);
  await until(() => h.runtime.state().actionsRemaining === 3);
  await h.delegate(id);
  for (let i = 0; i < 3; i++) await tick();
  assert.equal(h.calls.judge, 1);
  assert.equal(h.runtime.state().actionsRemaining, 3);
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
