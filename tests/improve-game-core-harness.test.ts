import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { GameHarness } from '../apps/local-server/game-harness.js';
import { GameSession } from '../apps/local-server/game.js';
import type { CoreJudgment } from '../apps/local-server/game-ai.js';
import { ScenarioCatalog } from '../apps/server/scenario-catalog.js';
import { localizeScenario } from '../packages/shared/scenario.js';

const response = (value: unknown) => ({
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
});
const partial: CoreJudgment = {
  success: false,
  narrative: 'public result',
  situation: 'public situation',
  inventoryChanges: [],
  factChanges: [{ key: 'wrists', from: 'bound', to: 'loosened' }],
  shortReason: 'PRIVATE JUDGMENT',
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function setup(
  options: {
    respond?: (body: any) => Promise<unknown>;
    judge?: () => Promise<CoreJudgment>;
    risk?: boolean;
    hooks?: boolean;
  } = {},
) {
  const snapshot = structuredClone(
    new ScenarioCatalog({
      scenarioPath: 'scenarios/mobile-playtest.json',
      coreConfigPath: 'config/game-core.json',
    }).current('ja'),
  );
  let judged = 0,
    called = 0,
    sequence = 0;
  const delivered: string[] = [];
  const game = new GameSession(
    localizeScenario(snapshot.scenarioV2, snapshot.locale),
    {
      recognize: async (context) => ({
        items: context.photos.map(({ id }) => ({
          photoId: id,
          inventoryId: null,
          name: 'scissors',
        })),
        usage: '',
        summary: 'scissors',
      }),
      judge: async () => {
        judged++;
        return options.judge ? options.judge() : partial;
      },
    },
    () => 0,
    () => {},
    snapshot,
  );
  game.heartbeat('connected');
  game.start();
  const harness = new GameHarness({
    game,
    snapshot,
    model: 'test-model',
    now: () => 0,
    hooks: options.hooks
      ? {
          speak: (text) => {
            delivered.push(text);
          },
        }
      : undefined,
    client: {
      respond: async (body) => {
        called++;
        if (options.respond) return options.respond(body);
        const request = body as any;
        const input = JSON.parse(request.input[0].content[0].text);
        switch (request.text.format.name) {
          case 'core_intent':
            return response({
              decision: {
                kind: 'consult',
                evidenceSeq: input.conversation.eligibleEvidenceSeq,
                reason: 'PRIVATE REASON',
                answer: 'I am listening.',
              },
            });
          case 'knowledge_selection':
            return response({ ids: [] });
          case 'harness_photo':
            return response({
              decision: options.risk ? 'confirm_risk' : 'execute',
              itemRefs: [{ photoId: input.photos[0] }],
              usage: 'cut rope',
              message: 'This could damage the scissors. Continue?',
              reason: 'PRIVATE PHOTO REASON',
            });
          default:
            throw new Error('unexpected schema');
        }
      },
    },
  });
  const say = (delta = 'What can you see?') => {
    sequence++;
    harness.sync();
    harness.ledger.append({
      eventId: randomUUID(),
      generation: game.generation,
      speaker: 'user',
      delta,
      startMs: sequence * 1000,
      endMs: sequence * 1000 + 1,
    });
    harness.sync();
    return harness.ledger.captureUnconsumedContext();
  };
  const photo = async () => {
    const ticket = harness.beginPhotos(1);
    await game.finishPhotos(
      [{ id: randomUUID(), jpeg: Buffer.from('synthetic recognition input') }],
      ticket,
      true,
    );
    harness.sync(true);
    return { ticket, requestId: randomUUID() };
  };
  return { game, harness, say, photo, delivered, judged: () => judged, called: () => called };
}

test('shared consultation returns public text without scene, and evidence charges once with or without delivery hooks', async () => {
  const outcomes = [];
  for (const hooks of [false, true]) {
    const f = setup({ hooks });
    const context = f.say();
    const result = await f.harness.handleRequest(context);
    assert.equal(result.publicReply, 'I am listening.');
    assert.deepEqual(result.committedPublicEvents, []);
    assert.equal(result.publicState.creditsRemaining, 980);
    assert.equal(f.game.actionsUsed, 0);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|shortReason|mechanism|requestCue/);
    const retry = await f.harness.handleRequest(f.harness.ledger.captureUnconsumedContext());
    assert.equal(retry.publicReply, '');
    assert.equal(f.game.credits.remaining, 980);
    assert.deepEqual(
      f.delivered.map((text) => JSON.parse(text)),
      hooks
        ? [
            {
              type: 'consultation',
              facts: result.publicReply,
              requiresConfirmation: false,
              ambience: [],
            },
          ]
        : [],
    );
    outcomes.push(result);
  }
  assert.deepEqual(outcomes[0], outcomes[1]);
});

test('recognized photo executes once without a second dialogue call or acknowledgment and settles one photo charge', async () => {
  const f = setup({ hooks: true });
  const input = await f.photo();
  const result = await f.harness.handleRecognizedPhoto(input);
  assert.equal(f.judged(), 1);
  assert.equal(f.game.gameVersion, 1);
  assert.equal(f.game.actionsUsed, 1);
  assert.equal(result.publicState.creditsRemaining, 900);
  assert.equal(result.committedPublicEvents.length, 1);
  assert.equal(f.called(), 1, 'photo routing only; Live composes its own result reply');
  assert.equal(f.delivered.length, 1);
  const facts = JSON.parse(f.delivered[0]!);
  assert.equal(facts.type, 'action_result');
  assert.equal(facts.result, 'public result');
  assert.match(result.publicReply, /public result/);
  assert.doesNotMatch(result.publicReply, /action_result|notificationId/);
  assert.doesNotMatch(f.delivered[0]!, /PRIVATE|shortReason/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|shortReason/);
  const retry = await f.harness.handleRecognizedPhoto(input);
  assert.equal(retry.publicReply, '');
  assert.deepEqual(retry.committedPublicEvents, []);
  assert.equal(f.judged(), 1);
  assert.equal(f.game.credits.remaining, 900);
});

test('recognized risk waits for confirmation and still charges the photo', async () => {
  const f = setup({ risk: true });
  const result = await f.harness.handleRecognizedPhoto(await f.photo());
  assert.equal(result.publicState.creditsRemaining, 900);
  assert.equal(f.judged(), 0);
  assert.match(result.publicReply, /damage/);
  assert.equal(f.harness.pendingRisk?.usage, 'cut rope');
  assert.deepEqual(result.committedPublicEvents, []);
});

test('stale context is rejected before AI and stale async classification cannot settle credits', async () => {
  const gate = deferred<unknown>();
  const f = setup({ respond: async () => gate.promise });
  const stale = f.say();
  const current = f.say('Another question');
  await assert.rejects(f.harness.handleRequest(stale), /ACTION_INVALID/);
  assert.equal(f.called(), 0);
  const running = f.harness.handleRequest(current);
  f.say('Actually stop');
  gate.resolve(
    response({
      decision: {
        kind: 'consult',
        evidenceSeq: current.eligibleEvidenceSeq,
        reason: 'private',
        answer: 'stale answer',
      },
    }),
  );
  await assert.rejects(running, /ACTION_INVALID/);
  assert.equal(f.game.credits.remaining, 1000);
  assert.equal(f.game.gameVersion, 0);
});

test('concurrent requests reject and aborted classification cannot answer or charge', async () => {
  const gate = deferred<unknown>();
  const f = setup({ respond: async () => gate.promise });
  const controller = new AbortController();
  const context = f.say();
  const running = f.harness.handleRequest(context, controller.signal);
  await assert.rejects(f.harness.handleRequest(context), /HARNESS_BUSY/);
  controller.abort();
  gate.resolve(
    response({
      decision: {
        kind: 'consult',
        evidenceSeq: context.eligibleEvidenceSeq,
        reason: 'private',
        answer: 'aborted answer',
      },
    }),
  );
  await assert.rejects(running, /abort/i);
  assert.equal(f.game.credits.remaining, 1000);
  assert.equal(f.game.gameVersion, 0);
});

test('abort during automatic judgment cancels its authority and cannot emit a scene', async () => {
  const gate = deferred<CoreJudgment>();
  const f = setup({ judge: () => gate.promise });
  const controller = new AbortController();
  const running = f.harness.handleRecognizedPhoto(await f.photo(), controller.signal);
  for (let i = 0; i < 20 && !f.game.pendingActionId; i++)
    await new Promise<void>((done) => setImmediate(done));
  assert.ok(f.game.pendingActionId);
  controller.abort();
  gate.resolve(partial);
  await assert.rejects(running, /ACTION_INVALID|abort/i);
  assert.equal(f.game.gameVersion, 0);
  assert.equal(f.game.actionsUsed, 0);
});

test('old controller epoch cannot apply a classified consultation', async () => {
  const gate = deferred<unknown>();
  const f = setup({ respond: async () => gate.promise });
  const context = f.say();
  const running = f.harness.handleRequest(context);
  f.game.changeController();
  f.harness.sync();
  gate.resolve(
    response({
      decision: {
        kind: 'consult',
        evidenceSeq: context.eligibleEvidenceSeq,
        reason: 'private',
        answer: 'stale',
      },
    }),
  );
  await assert.rejects(running, /ACTION_INVALID/);
  assert.equal(f.game.credits.remaining, 1000);
});

test('wait classification uses a safe prompt instead of the private classifier reason', async () => {
  const f = setup({
    respond: async () =>
      response({ decision: { kind: 'wait', reason: 'PRIVATE REASON WITH SOLUTION' } }),
  });
  const result = await f.harness.handleRequest(f.say());
  assert.doesNotMatch(result.publicReply, /PRIVATE|SOLUTION/);
  assert.equal(f.game.credits.remaining, 1000);
});

test('recognition boundary rejects unknown references and stale or duplicate commits', async () => {
  const f = setup();
  await f.photo();
  const expected = { generation: f.game.generation, revision: f.game.inputRevision };
  const raw = {
    items: [{ photoId: randomUUID(), inventoryId: null, name: 'invented' }],
    usage: '',
    summary: '',
  };
  assert.equal(f.game.commitRecognizedPhotos(raw, expected), false);
  const ticket = f.harness.beginPhotos(1);
  assert.throws(
    () =>
      f.game.commitRecognizedPhotos(raw, {
        generation: ticket.generation,
        revision: ticket.revision,
      }),
    /Unknown photo/,
  );
  f.game.cancelPhotos();
  assert.equal(f.game.commitRecognizedPhotos(raw, expected), false);
});
