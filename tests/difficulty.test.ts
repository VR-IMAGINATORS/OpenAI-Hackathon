import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ScenarioCatalog } from '../apps/server/scenario-catalog.js';
import { loadHostedConfig } from '../apps/server/config.js';
import { createHostedApp } from '../apps/server/app.js';
import { GameSession } from '../apps/local-server/game.js';
import { localizeScenario } from '../packages/shared/scenario.js';
import type { Difficulty } from '../packages/shared/difficulty.js';
import { creditCosts } from '../packages/shared/credits.js';

const cases = [
  ['normal', 300, 1000],
  ['hard', 240, 750],
  ['nightmare', 180, 500],
] as const;
const catalog = () =>
  new ScenarioCatalog({
    scenarioPath: 'scenarios/story-catalog.json',
    coreConfigPath: 'config/game-core.json',
    randomIndex: () => 0,
  });

test('HTTP difficulty is validated, isolated, retained and part of request identity', async (t) => {
  const config = loadHostedConfig({
    HOSTED_NO_ENV_FILE: '1',

    AI_MODE: 'mock',
  });
  const hosted = createHostedApp(config, { log: () => {} });
  const server = hosted.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  config.allowedHosts.add(new URL(origin).host);
  config.allowedOrigins.add(origin);
  t.after(async () => {
    await hosted.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const post = (path: string, body: unknown, cookie = '') =>
    fetch(origin + path, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body),
    });
  for (const [difficulty, seconds, credits] of cases) {
    const cookie = (await post('/api/auth', {})).headers.get('set-cookie')!.split(';')[0];
    const body = { requestId: randomUUID(), clientId: randomUUID(), locale: 'en', difficulty };
    for (const invalid of ['hell', '', null, 3, {}])
      assert.equal(
        (await post('/api/plays', { ...body, difficulty: invalid }, cookie)).status,
        400,
      );
    for (const forged of [{ initialCredits: 100000 }, { creditsRemaining: 100000 }])
      assert.equal((await post('/api/plays', { ...body, ...forged }, cookie)).status, 400);
    const created = await post('/api/plays', body, cookie);
    assert.equal(created.status, 201);
    const value = await created.json();
    assert.equal(value.state.difficulty, difficulty);
    assert.equal(value.state.remainingMs, seconds * 1000);
    assert.equal(value.state.creditsRemaining, credits);
    assert.equal(value.state.initialCredits, credits);
    assert.equal(value.state.lastCreditCharge, null);
    assert.equal('photoSendsRemaining' in value.state, false);
    const repeated = await post('/api/plays', body, cookie);
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).playId, value.playId);
    assert.equal(
      (
        await post(
          '/api/plays',
          { ...body, difficulty: difficulty === 'normal' ? 'hard' : 'normal' },
          cookie,
        )
      ).status,
      409,
    );
    const restored = await fetch(origin + '/api/play/state', {
      headers: { Cookie: cookie, 'X-Play-Id': value.playId },
    });
    assert.equal(restored.status, 200);
    const restoredState = (await restored.json()).state;
    assert.equal(restoredState.difficulty, difficulty);
    assert.equal(restoredState.creditsRemaining, credits);
  }
  assert.equal(hosted.registry.occupied, 3);
});

function gameFor(difficulty: Difficulty) {
  let now = 0;
  let success = true;
  const snapshot = catalog().current('en', difficulty);
  const game = new GameSession(
    localizeScenario(snapshot.scenarioV2, 'en'),
    {
      async recognize(context) {
        return {
          items: context.photos.map((photo) => ({
            photoId: photo.id,
            inventoryId: null,
            name: 'Tool',
          })),
          usage: 'Use the tool',
          summary: 'Use the tool',
        };
      },
      async judge(context) {
        const completion = snapshot.scenarioV2.obstacles.find(
          (o) => o.id === context.facts!.obstacleId,
        )!.completionFact!;
        return {
          success,
          narrative: 'Result',
          situation: 'Changed',
          factChanges: success
            ? [
                {
                  key: completion.key,
                  from: context.facts!.values[completion.key],
                  to: completion.value,
                },
              ]
            : [],
          inventoryChanges: [],
          shortReason: 'Result',
        };
      },
    },
    () => now,
    () => {},
    snapshot,
  );
  game.heartbeat('connected');
  game.start();
  return {
    game,
    advance(ms: number) {
      now += ms;
    },
    fail() {
      success = false;
    },
    async act(reuse = false) {
      const photoId = randomUUID();
      if (!reuse)
        await game.finishPhotos([{ id: photoId, jpeg: Buffer.from('test') }], game.beginPhotos());
      const creditId = randomUUID();
      game.reserveCredits(creditId, 'conversation', creditCosts.conversation);
      const ticket = game.reserveAction(
        {
          kind: 'execute',
          evidenceSeq: [game.actionsUsed + 1],
          itemRefs: reuse ? [{ inventoryId: game.inventory[0].id }] : [{ photoId }],
          usage: 'Use the tool',
          reason: 'Player instruction',
        },
        game.currentContextVersion,
        game.gameVersion,
        game.actionEpoch,
        game.controllerEpoch,
      );
      try {
        const result = await game.judgeAction(ticket);
        game.settleCredits(creditId);
        return result;
      } catch (error) {
        game.credits.cancel(creditId);
        throw error;
      }
    },
  };
}
for (const [difficulty, seconds, credits] of cases) {
  test(`${difficulty}: timer ends exactly at selected limit`, () => {
    const f = gameFor(difficulty);
    f.advance(seconds * 1000 - 1);
    assert.equal(f.game.state().status, 'playing');
    f.advance(1);
    assert.equal(f.game.state().endReason, 'time_limit');
  });
  test(`${difficulty}: photos can exceed the former send limit and exhaustion ends play`, async () => {
    const f = gameFor(difficulty);
    const affordablePhotos = Math.floor(credits / creditCosts.photo);
    for (let sent = 1; sent <= affordablePhotos; sent++) {
      await f.game.finishPhotos(
        [{ id: randomUUID(), jpeg: Buffer.from('test') }],
        f.game.beginPhotos(1),
      );
      assert.equal(f.game.state().creditsRemaining, credits - sent * creditCosts.photo);
      assert.equal(
        f.game.status,
        f.game.credits.remaining < creditCosts.conversation ? 'lost' : 'playing',
      );
    }
    while (f.game.credits.remaining >= creditCosts.conversation) {
      const creditId = randomUUID();
      f.game.reserveCredits(creditId, 'conversation', creditCosts.conversation);
      f.game.settleCredits(creditId);
    }
    assert.equal(f.game.endReason, 'credits_exhausted');
    assert.ok(f.game.state().remainingMs > 0);
    assert.throws(() => f.game.beginPhotos(1));
  });
  test(`${difficulty}: reusing an existing tool costs only its spoken instruction`, async () => {
    const f = gameFor(difficulty);
    f.fail();
    await f.act();
    assert.equal(
      f.game.state().creditsRemaining,
      credits - creditCosts.photo - creditCosts.conversation,
    );
    await f.act(true);
    assert.equal(f.game.actionsUsed, 2);
    assert.equal(
      f.game.state().creditsRemaining,
      credits - creditCosts.photo - creditCosts.conversation * 2,
    );
    assert.equal(f.game.state().status, 'playing');
  });
  test(`${difficulty}: three successful actions permit complete escape`, async () => {
    const f = gameFor(difficulty);
    for (let i = 0; i < 3; i++) await f.act(i > 0);
    assert.equal(f.game.state().status, 'won');
    assert.equal(f.game.state().endingOutcome, 'happy');
    assert.equal(
      f.game.state().creditsRemaining,
      credits - creditCosts.photo - creditCosts.conversation * 3,
    );
  });
  test(`${difficulty}: escaping with the last conversation credits takes priority over exhaustion`, async () => {
    const f = gameFor(difficulty);
    await f.act();
    await f.act(true);
    while (f.game.credits.remaining >= creditCosts.conversation * 2) {
      const creditId = randomUUID();
      f.game.reserveCredits(creditId, 'conversation', creditCosts.conversation);
      f.game.settleCredits(creditId);
    }
    await f.act(true);
    assert.ok(f.game.state().creditsRemaining < creditCosts.conversation);
    assert.equal(f.game.state().status, 'won');
    assert.equal(f.game.state().endReason, 'escaped');
    assert.equal(f.game.state().endingOutcome, 'happy');
  });
}
test('snapshot is immutable and selected limits are checked against deployment budgets', () => {
  const c = catalog();
  const normal = c.current('en', 'normal');
  const hard = c.current('en', 'hard');
  assert.notEqual(normal.digest, hard.digest);
  assert.equal(normal.scenarioV2.rules.initialCredits, 1000);
  assert.ok(Object.isFrozen(hard.scenarioV2.rules));
  assert.throws(() => c.current('en', 'invalid' as Difficulty));
  const limited = new ScenarioCatalog({
    scenarioPath: 'scenarios/mobile-playtest.json',
    coreConfigPath: 'config/game-core.json',
    playTtlMs: 350_000,
  });
  assert.throws(() => limited.current('en', 'normal'));
});
