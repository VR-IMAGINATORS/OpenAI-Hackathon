import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseScenarioV2, localizeScenario } from '../packages/shared/scenario.js';
import { parseCoreConfig } from '../packages/shared/core-config.js';
import type { ExecuteIntent } from '../packages/shared/conversation.js';
import type { ScenarioSnapshot } from '../apps/server/scenario-catalog.js';
import { GameSession } from '../apps/local-server/game.js';
import { type GameAI, type CoreJudgment } from '../apps/local-server/game-ai.js';
const coreSnapshot: ScenarioSnapshot = {
  digest: 'test',
  locale: 'ja',
  createdAt: 0,
  scenarioV2: parseScenarioV2(JSON.parse(readFileSync('scenarios/mobile-playtest.json', 'utf8'))),
  coreConfig: parseCoreConfig(JSON.parse(readFileSync('config/game-core.json', 'utf8'))),
};
const partial: CoreJudgment = {
  success: false,
  narrative: '縄が少し緩んだ。',
  situation: '縄が緩んだ。',
  inventoryChanges: [],
  factChanges: [{ key: 'wrists', from: 'bound', to: 'loosened' }],
  shortReason: '結び目が緩んだ。',
};
async function fixture(judge: GameAI['judge'] = async () => partial, snapshot = coreSnapshot) {
  let calls = 0,
    now = 0;
  const ai: GameAI = {
    recognize: async (context) => ({
      items: context.photos.map((photo) => ({
        photoId: photo.id,
        inventoryId: null,
        name: 'はさみ',
      })),
      usage: '',
      summary: 'はさみ',
    }),
    judge: async (...args) => {
      calls++;
      return judge(...args);
    },
  };
  const game = new GameSession(
    localizeScenario(snapshot.scenarioV2, snapshot.locale),
    ai,
    () => now,
    () => {},
    snapshot,
  );
  game.heartbeat('connected');
  game.start();
  const photoId = randomUUID();
  await game.finishPhotos([{ id: photoId, jpeg: Buffer.from('fake') }], game.beginPhotos());
  const intent = (seq = 1): ExecuteIntent => ({
    kind: 'execute',
    evidenceSeq: [seq],
    itemRefs: [{ photoId }],
    usage: '縄を切って',
    reason: '使用指示',
  });
  const reserve = (value = intent()) =>
    game.reserveAction(
      value,
      game.currentContextVersion,
      game.gameVersion,
      game.actionEpoch,
      game.controllerEpoch,
    );
  return {
    game,
    intent,
    reserve,
    calls: () => calls,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const transient = () =>
  Object.assign(new Error('transport'), { code: 'UPSTREAM_FAILED', status: 502 });

test('explicit cancellation before commit drops the old result and preserves received photos', async () => {
  const answer = deferred<CoreJudgment>();
  const f = await fixture(async () => answer.promise);
  const ticket = f.reserve();
  const running = f.game.judgeAction(ticket);
  const rejected = assert.rejects(running, /ACTION_INVALID/);
  f.game.cancelPendingAction(ticket.id);
  answer.resolve(partial);
  await rejected;
  assert.equal(f.game.gameVersion, 0);
  assert.equal(f.game.inventory.length, 0);
  assert.equal(f.game.photos.length, 1);
  assert.equal(f.game.credits.remaining, 850);
  assert.equal(f.game.committedActions.length, 0);
});

test('late finally from cancelled judgment cannot resume the replacement clock', async () => {
  const first = deferred<CoreJudgment>();
  const second = deferred<CoreJudgment>();
  let call = 0;
  const f = await fixture(async () => (++call === 1 ? first.promise : second.promise));
  const ticket = f.reserve();
  const running = f.game.judgeAction(ticket);
  const rejected = assert.rejects(running, /ACTION_INVALID/);
  f.game.cancelPendingAction(ticket.id);
  const replacement = f.reserve(f.intent(2));
  const next = f.game.judgeAction(replacement);
  first.resolve(partial);
  await rejected;
  assert.equal(f.game.pendingActionId, replacement.id);
  assert.equal(f.game.clock.paused, true);
  assert.equal(f.game.status, 'judging');
  second.resolve(partial);
  await next;
  assert.equal(f.game.clock.paused, false);
  assert.equal(f.game.gameVersion, 1);
});

test('one transport retry reuses ticket and materialization IDs without another send', async () => {
  const ids: string[] = [];
  const f = await fixture(async (context) => {
    ids.push(context.inventory[0]!.id);
    assert.equal(context.photos.length, 1);
    if (ids.length === 1) throw transient();
    return partial;
  });
  const ticket = f.reserve();
  const result = await f.game.judgeAction(ticket);
  assert.equal(result.actionId, ticket.id);
  assert.equal(f.calls(), 2);
  assert.equal(ids[0], ids[1]);
  assert.equal(f.game.inventory[0]!.id, ids[0]);
  assert.equal(f.game.credits.remaining, 850);
  assert.equal(f.game.gameVersion, 1);
  await f.game.judgeAction(ticket);
  assert.equal(f.calls(), 2);
});

test('second transport failure ends retry and never commits', async () => {
  const f = await fixture(async () => {
    throw transient();
  });
  const ticket = f.reserve();
  await assert.rejects(f.game.judgeAction(ticket), /ACTION_FAILED/);
  await assert.rejects(f.game.judgeAction(ticket), /ACTION_FAILED/);
  assert.equal(f.calls(), 2);
  assert.equal(f.game.gameVersion, 0);
  assert.equal(f.game.clock.paused, false);
});

test('model schema and fact errors get one repair without committing invalid output', async () => {
  for (const judge of [
    async () => ({ bad: true }) as unknown as CoreJudgment,
    async () => ({ ...partial, factChanges: [{ key: 'invented', from: 'a', to: 'b' }] }),
  ]) {
    const f = await fixture(judge);
    await assert.rejects(f.game.judgeAction(f.reserve()), /ACTION_FAILED/);
    assert.equal(f.calls(), 2);
    assert.equal(f.game.gameVersion, 0);
    assert.equal(f.game.inventory.length, 0);
  }
});

test('limits, refusals, client errors and ordinary physical failure are not retried', async () => {
  for (const [code, status] of [
    ['REQUEST_LIMIT', 429],
    ['AI_OUTPUT_REFUSED', 422],
    ['UPSTREAM_FAILED', 400],
    ['DRAINING', 503],
    ['UNKNOWN_FAILURE', 500],
  ] as const) {
    const f = await fixture(async () => {
      throw Object.assign(new Error(code), { code, status });
    });
    await assert.rejects(f.game.judgeAction(f.reserve()), /ACTION_FAILED/);
    assert.equal(f.calls(), 1);
    assert.equal(f.game.gameVersion, 0);
  }
  const f = await fixture(async () => ({ ...partial, factChanges: [] }));
  await f.game.judgeAction(f.reserve());
  assert.equal(f.calls(), 1);
  assert.equal(f.game.gameVersion, 1);
});

test('terminal invalidation aborts an unfinished judgment without committing', async () => {
  const answer = deferred<CoreJudgment>();
  const f = await fixture(async () => answer.promise);
  const ticket = f.reserve();
  const running = f.game.judgeAction(ticket);
  const rejected = assert.rejects(running, /ACTION_INVALID/);
  await turn();
  f.game.end('expired');
  answer.resolve(partial);
  await rejected;
  assert.equal(f.game.gameVersion, 0);
});

test('photo origin requires the exact recognized owned batch and input revision', async () => {
  const f = await fixture();
  const photoId = f.game.photos[0]!.id;
  const origin = {
    kind: 'photo' as const,
    requestId: 'photo-request',
    photoIds: [photoId],
    photoVersion: f.game.inputRevision,
  };
  for (const changed of [
    { ...origin, photoVersion: origin.photoVersion + 1 },
    { ...origin, photoIds: [randomUUID()] },
    { ...origin, photoIds: [photoId, photoId] },
  ])
    assert.throws(
      () => f.reserve({ ...f.intent(), evidenceSeq: [], origin: changed }),
      /PHOTO_ORIGIN_STALE|Photo action must use an originating photo/,
    );
  const result = await f.game.judgeAction(f.reserve({ ...f.intent(), evidenceSeq: [], origin }));
  assert.equal(result.afterVersion, 1);
  assert.equal(f.game.credits.remaining, 850);
});

test('environment action needs a current declared target, carries its mode to judgment, and creates no inventory', async () => {
  const snapshot = structuredClone(coreSnapshot);
  const current = snapshot.scenarioV2.obstacles[0]!;
  const future = snapshot.scenarioV2.obstacles[1]!;
  snapshot.scenarioV2.observationTargets = [
    { id: current.id, description: current.situationDisplay },
    { id: future.id, description: future.situationDisplay },
  ];
  let observed: unknown;
  const f = await fixture(async (_context, proposal) => {
    observed = proposal;
    return partial;
  }, snapshot);
  const action: ExecuteIntent = {
    kind: 'execute',
    evidenceSeq: [1],
    mode: 'environment',
    environmentTargetIds: [current.id],
    itemRefs: [],
    usage: '目の前の設備を操作して',
    reason: '明示的な操作依頼',
  };
  assert.throws(
    () => f.reserve({ ...action, environmentTargetIds: [future.id] }),
    /ENVIRONMENT_TARGET_UNAVAILABLE/,
  );
  assert.throws(
    () => f.reserve({ ...action, environmentTargetIds: ['unknown'] }),
    /ENVIRONMENT_TARGET_UNAVAILABLE/,
  );
  const ticket = f.reserve(action);
  const result = await f.game.judgeAction(ticket);
  assert.equal(result.success, false);
  assert.equal((observed as any).mode, 'environment');
  assert.deepEqual((observed as any).environmentTargetIds, [current.id]);
  assert.deepEqual((observed as any).items, []);
  assert.equal(f.game.state().inventory.length, 0);
});

test('empty tool action and photo-origin environment action cannot reserve', async () => {
  const f = await fixture();
  assert.throws(() => f.reserve({ ...f.intent(), itemRefs: [] }));
  const photoId = (f.intent().itemRefs[0] as { photoId: string }).photoId;
  assert.throws(() =>
    f.reserve({
      ...f.intent(),
      mode: 'environment',
      environmentTargetIds: [coreSnapshot.scenarioV2.obstacles[0]!.id],
      itemRefs: [],
      evidenceSeq: [],
      origin: {
        kind: 'photo',
        requestId: 'receipt',
        photoIds: [photoId],
        photoVersion: f.game.state().inputRevision,
      },
    }),
  );
});

test('cancellation aborts the judgment signal and still reports invalid rather than technical failure', async () => {
  let signalSeen: AbortSignal | undefined;
  const f = await fixture(async (_context, _proposal, signal) => {
    signalSeen = signal;
    return new Promise((_, reject) =>
      signal!.addEventListener('abort', () => reject(new Error('transport aborted')), {
        once: true,
      }),
    );
  });
  const ticket = f.reserve();
  const running = f.game.judgeAction(ticket);
  const rejected = assert.rejects(running, /ACTION_INVALID/);
  assert.ok(signalSeen);
  f.game.cancelPendingAction(ticket.id);
  await rejected;
  assert.equal(signalSeen!.aborted, true);
  assert.equal(f.calls(), 1);
  assert.equal(f.game.gameVersion, 0);
});
