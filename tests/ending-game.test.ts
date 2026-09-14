import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { GameSession } from '../apps/local-server/game.js';
import { ScenarioCatalog } from '../apps/server/scenario-catalog.js';
import { localizeScenario } from '../packages/shared/scenario.js';
import type { CoreJudgment, GameAI } from '../apps/local-server/game-ai.js';

function fixture(core: boolean, maxActions = 4, judgment?: GameAI['judge']) {
  let now = 0;
  let success = true;
  let calls = 0;
  const snapshot = structuredClone(
    new ScenarioCatalog({
      scenarioPath: 'scenarios/mobile-playtest.json',
      coreConfigPath: 'config/game-core.json',
    }).current('ja'),
  );
  snapshot.scenarioV2.rules.maxActions = maxActions;
  const scenario = localizeScenario(snapshot.scenarioV2, 'ja');
  const endingStates: unknown[] = [];
  const game = new GameSession(
    scenario,
    {
      async recognize(context) {
        return {
          items: context.photos.map((photo) => ({
            photoId: photo.id,
            inventoryId: null,
            name: '赤いひも',
          })),
          usage: 'ひもで引く',
          summary: 'ひもを使う',
        };
      },
      async judge(...args) {
        calls++;
        const value = judgment
          ? await judgment(...args)
          : {
              success,
              narrative: success ? 'ひもを引くと通れるようになった。' : '少し動いたが通れない。',
              situation: 'ひもは手元に残っている。',
              factChanges: [],
              inventoryChanges: [],
              shortReason: '実行した結果',
            };
        return core
          ? value
          : {
              success: value.success,
              narrative: value.narrative,
              situation: value.situation,
              inventoryChanges: value.inventoryChanges,
            };
      },
    },
    () => now,
    () =>
      endingStates.push({ state: game.state(), actions: structuredClone(game.committedActions) }),
    core ? snapshot : undefined,
  );
  game.heartbeat('connected');
  game.start();
  async function prepare() {
    const photoId = randomUUID();
    await game.finishPhotos([{ id: photoId, jpeg: Buffer.from('fake') }], game.beginPhotos());
    if (!core) {
      const actionId = randomUUID();
      const revision = game.proposal!.revision;
      return () => game.commit(actionId, revision);
    }
    const ticket = game.reserveAction(
      {
        kind: 'execute',
        evidenceSeq: [game.actionsUsed + 1],
        itemRefs: [{ photoId }],
        usage: 'ひもで引く',
        reason: 'プレイヤーの実行指示',
      },
      game.currentContextVersion,
      game.gameVersion,
      game.actionEpoch,
      game.controllerEpoch,
    );
    return () => game.judgeAction(ticket);
  }
  return {
    game,
    endingStates,
    prepare,
    act: async () => (await prepare())(),
    setSuccess(value: boolean) {
      success = value;
    },
    advance(ms: number) {
      now += ms;
    },
    calls: () => calls,
  };
}

for (const core of [true, false]) {
  const path = core ? 'automatic' : 'manual';
  for (const count of [0, 1, 2]) {
    test(`${path}: time limit uses explicit ${count} cleared obstacles`, async () => {
      const f = fixture(core);
      for (let i = 0; i < count; i++) await f.act();
      f.advance(1_000_000);
      const state = f.game.state();
      assert.equal(state.status, 'lost');
      assert.equal(state.endReason, 'time_limit');
      assert.equal(state.endingOutcome, count === 2 ? 'normal' : 'bad');
      assert.equal(state.clearedCount, count);
      assert.deepEqual(
        f.game.clearedIds,
        f.game.scenario.obstacles.slice(0, count).map((o) => o.id),
      );
    });
  }
  test(`${path}: last permitted action records second clearance before normal ending callback`, async () => {
    const f = fixture(core, 3);
    f.setSuccess(false);
    await f.act();
    f.setSuccess(true);
    await f.act();
    const repeat = await f.prepare();
    const result = await repeat();
    assert.deepEqual(await repeat(), result);
    assert.equal(f.calls(), 3);
    assert.equal(f.game.state().endingOutcome, 'normal');
    assert.equal(f.game.endReason, 'action_limit');
    assert.equal(f.game.committedActions.length, 3);
    assert.equal(f.game.committedActions[2].cleared, true);
    assert.equal(f.game.committedActions[2].afterVersion, 3);
    assert.equal(f.endingStates.length, 1);
    assert.equal((f.endingStates[0] as any).actions.length, 3);
    assert.equal((f.endingStates[0] as any).state.clearedCount, 2);
  });
  test(`${path}: final obstacle wins even on the final permitted action`, async () => {
    const f = fixture(core, 3);
    await f.act();
    await f.act();
    await f.act();
    assert.equal(f.game.status, 'won');
    assert.equal(f.game.endReason, 'escaped');
    assert.equal(f.game.state().endingOutcome, 'happy');
    assert.equal(f.game.clearedIds.length, 3);
  });
  test(`${path}: partial progress does not count as clearance`, async () => {
    const f = fixture(core, 3);
    await f.act();
    f.setSuccess(false);
    await f.act();
    await f.act();
    assert.equal(f.game.state().endingOutcome, 'bad');
    assert.equal(f.game.clearedIds.length, 1);
    assert.deepEqual(
      f.game.committedActions.map((a) => a.cleared),
      [true, false, false],
    );
  });
  test(`${path}: interruption discards late judgment and produces no normal outcome`, async () => {
    let complete!: (value: CoreJudgment) => void;
    const f = fixture(
      core,
      4,
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const execute = await f.prepare();
    const pending = execute();
    f.advance(60_001);
    f.game.check();
    complete({
      success: true,
      narrative: '間に合わなかった結果',
      situation: '遅い結果',
      inventoryChanges: [],
      factChanges: [],
      shortReason: '期限後',
    });
    await assert.rejects(pending, { status: 410 });
    assert.equal(f.game.status, 'expired');
    assert.equal(f.game.endReason, 'interrupted');
    assert.equal(f.game.state().endingOutcome, null);
    assert.equal(f.game.committedActions.length, 0);
    assert.equal(f.game.clearedIds.length, 0);
  });
  test(`${path}: action history preserves tool state before it is consumed`, async () => {
    const f = fixture(core, 4, async (_context, proposal) => ({
      success: false,
      narrative: 'ひもが切れた。',
      situation: '切れたひもが落ちた。',
      factChanges: [],
      shortReason: 'ひもが切れた',
      inventoryChanges: [
        { id: proposal.items[0].inventoryId!, status: 'consumed', description: '切断' },
      ],
    }));
    await f.act();
    assert.equal(f.game.committedActions[0].items[0].beforeStatus, 'available');
    assert.equal(f.game.committedActions[0].items[0].afterStatus, 'consumed');
    assert.equal(f.game.committedActions[0].usage, 'ひもで引く');
  });
}

test('declared partial fact transition and old action history remain independent of later state', async () => {
  const f = fixture(true, 4, async () => ({
    success: false,
    narrative: '縄が緩んだ。',
    situation: '縄が緩んだ状態。',
    factChanges: [{ key: 'wrists', from: 'bound', to: 'loosened' }],
    inventoryChanges: [],
    shortReason: 'まだ完全解除ではない',
  }));
  await f.act();
  const action = f.game.committedActions[0];
  assert.equal(action.beforeFacts.values.wrists, 'bound');
  assert.equal(action.afterFacts.values.wrists, 'loosened');
  assert.equal(action.cleared, false);
  f.game.facts.values.wrists = 'free';
  assert.equal(action.afterFacts.values.wrists, 'loosened');
});
