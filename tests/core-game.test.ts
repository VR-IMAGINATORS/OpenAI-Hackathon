import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseScenarioV2, localizeScenario } from '../packages/shared/scenario.js';
import { parseCoreConfig } from '../packages/shared/core-config.js';
import type { ExecuteIntent } from '../packages/shared/conversation.js';
import type { ScenarioSnapshot } from '../apps/server/scenario-catalog.js';
import { GameSession } from '../apps/local-server/game.js';
import { createGameAI, type GameAI, type CoreJudgment } from '../apps/local-server/game-ai.js';
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

test('core partial progress commits once, retains facts and enables inventory reuse without a photo', async () => {
  let seenFacts = '';
  const f = await fixture(async (context) => {
    seenFacts = context.facts!.values.wrists;
    assert.ok(Buffer.isBuffer(context.photos[0]?.jpeg) || context.photos.length === 0);
    return { ...partial, factChanges: seenFacts === 'bound' ? partial.factChanges : [] };
  });
  const ticket = f.reserve();
  const result = await f.game.judgeAction(ticket);
  assert.deepEqual(await f.game.judgeAction(ticket), result);
  assert.equal(f.calls(), 1);
  assert.equal(f.game.gameVersion, 1);
  assert.equal(f.game.facts.values.wrists, 'loosened');
  assert.equal(f.game.obstacleIndex, 0);
  assert.equal(f.game.clock.paused, false);
  assert.equal(f.game.inventory.length, 1);
  assert.equal(f.game.photos.length, 0);
  const second = f.reserve({ ...f.intent(2), itemRefs: [{ inventoryId: f.game.inventory[0].id }] });
  await f.game.judgeAction(second);
  assert.equal(seenFacts, 'loosened');
  assert.equal(f.game.actionsUsed, 2);
  assert.equal(f.game.inventory.length, 1);
});

test('core reservation rejects stale context/game/action/controller, unavailable items and disconnected audio', async () => {
  const f = await fixture();
  for (const versions of [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ])
    assert.throws(
      () => f.game.reserveAction(f.intent(), ...(versions as [number, number, number, number])),
      /ACTION_CONTEXT_STALE/,
    );
  assert.throws(
    () => f.reserve({ ...f.intent(), itemRefs: [{ photoId: randomUUID() }] }),
    /PHOTO_NOT_RECOGNIZED/,
  );
  assert.throws(
    () => f.reserve({ ...f.intent(), itemRefs: [{ inventoryId: randomUUID() }] }),
    /ITEM_UNAVAILABLE/,
  );
  f.game.heartbeat('disconnected');
  assert.throws(() => f.reserve(), /ACTION_CONTEXT_STALE/);
  assert.equal(f.calls(), 0);
});

test('core reservation is atomic and same evidence cannot retry after technical failure', async () => {
  let reject!: (error: Error) => void;
  const f = await fixture(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
  );
  const ticket = f.reserve();
  assert.throws(() => f.reserve(f.intent(2)), { status: 409 });
  const pending = f.game.judgeAction(ticket);
  await assert.rejects(f.game.judgeAction(ticket), /ACTION_PENDING/);
  reject(new Error('network'));
  await assert.rejects(pending, /ACTION_FAILED/);
  await assert.rejects(f.game.judgeAction(ticket), /ACTION_FAILED/);
  assert.throws(() => f.reserve(), /EVIDENCE_ALREADY_RESERVED/);
  assert.equal(f.calls(), 1);
  assert.equal(f.game.actionsUsed, 0);
  assert.equal(f.game.inventory.length, 0);
  assert.equal(f.game.facts.values.wrists, 'bound');
  assert.equal(f.game.clock.paused, false);
  assert.ok(f.reserve(f.intent(2)));
});

for (const changes of [
  [{ key: 'unknown', from: 'bound', to: 'loosened' }],
  [{ key: 'door', from: 'latched', to: 'open' }],
  [{ key: 'wrists', from: 'free', to: 'loosened' }],
  [{ key: 'wrists', from: 'bound', to: 'magic' }],
  [{ key: 'wrists', from: 'bound', to: 'bound' }],
  [...partial.factChanges, ...partial.factChanges],
])
  test(
    'core rejects undeclared/foreign/reversed/duplicate fact mutation: ' + JSON.stringify(changes),
    async () => {
      const snapshot = structuredClone(coreSnapshot);
      snapshot.scenarioV2.obstacles[0].factKeys = ['wrists'];
      const f = await fixture(async () => ({ ...partial, factChanges: changes }), snapshot);
      await assert.rejects(f.game.judgeAction(f.reserve()), /ACTION_FAILED/);
      assert.equal(f.game.gameVersion, 0);
      assert.equal(f.game.actionsUsed, 0);
      assert.equal(f.game.facts.values.wrists, 'bound');
      assert.equal(f.game.inventory.length, 0);
    },
  );

test('core unknown inventory causes no partial fact commit', async () => {
  const f = await fixture(async () => ({
    ...partial,
    inventoryChanges: [{ id: randomUUID(), status: 'consumed', description: 'lost' }],
  }));
  await assert.rejects(f.game.judgeAction(f.reserve()), /ACTION_FAILED/);
  assert.equal(f.game.facts.values.wrists, 'bound');
  assert.equal(f.game.actionsUsed, 0);
});

test('core consumed item is not reusable, and ticket input cannot be rewritten', async () => {
  const f = await fixture(async (_context, proposal) => ({
    ...partial,
    inventoryChanges: [
      { id: proposal.items[0].inventoryId!, status: 'consumed', description: 'used' },
    ],
  }));
  const ticket = f.reserve();
  const changed = structuredClone(ticket);
  changed.intent.usage = 'changed';
  await assert.rejects(f.game.judgeAction(changed), /INVALID_TICKET/);
  assert.equal(f.calls(), 0);
  await f.game.judgeAction(ticket);
  assert.throws(
    () => f.reserve({ ...f.intent(2), itemRefs: [{ inventoryId: f.game.inventory[0].id }] }),
    /ITEM_UNAVAILABLE/,
  );
});

for (const mode of ['controller', 'end', 'timeout'] as const)
  test('core discards a late judgment after ' + mode, async () => {
    let resolve!: (value: CoreJudgment) => void;
    const f = await fixture(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const ticket = f.reserve();
    const pending = f.game.judgeAction(ticket);
    if (mode === 'controller') f.game.changeController();
    else if (mode === 'end') f.game.end();
    else {
      f.advance(60001);
      f.game.check();
    }
    resolve(partial);
    await assert.rejects(pending, /ACTION_INVALID/);
    assert.equal(f.game.actionsUsed, 0);
    assert.equal(f.game.facts.values.wrists, 'bound');
  });

test('core winning action preserves Live generation, expires actions and returns committed result on retry', async () => {
  const snapshot = structuredClone(coreSnapshot);
  snapshot.scenarioV2.obstacles.splice(1);
  snapshot.scenarioV2.events = [];
  const f = await fixture(
    async () => ({
      ...partial,
      success: true,
      factChanges: [{ key: 'wrists', from: 'bound', to: 'free' }],
    }),
    snapshot,
  );
  const generation = f.game.generation,
    epoch = f.game.actionEpoch,
    ticket = f.reserve();
  const result = await f.game.judgeAction(ticket);
  assert.equal(f.game.status, 'won');
  assert.equal(f.game.generation, generation);
  assert.equal(f.game.actionEpoch, epoch + 1);
  assert.equal(f.game.actionsUsed, 1);
  assert.deepEqual(await f.game.judgeAction(ticket), result);
  assert.equal(f.calls(), 1);
  await assert.rejects(f.game.commit(randomUUID(), 0), /LEGACY_ACTION_DISABLED/);
});

test('core AI sends fact constraints and locale, with correct photo bytes and strict structured fields', async () => {
  let request: any;
  const snapshot = { ...coreSnapshot, locale: 'en' as const };
  const ai = createGameAI(
    {
      respond: async (body) => {
        request = body;
        return {
          output: [
            { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(partial) }] },
          ],
        };
      },
    },
    () => 'test-model',
    snapshot,
  );
  const photo = { id: randomUUID(), jpeg: Buffer.from('fake') };
  await ai.judge(
    {
      scenario: localizeScenario(snapshot.scenarioV2, 'en'),
      obstacleIndex: 0,
      situation: 'bound',
      inventory: [],
      photos: [photo],
      transcript: 'cut',
      facts: { obstacleId: 'wrists', values: { wrists: 'bound' } },
    },
    { items: [], usage: 'cut', summary: 'cut' },
  );
  assert.match(request.instructions, /in en/);
  const data = JSON.parse(request.input[0].content[0].text);
  assert.equal(data.facts.values.wrists, 'bound');
  assert.ok(data.declaredFacts.length);
  assert.ok(data.factKeys.includes('wrists'));
  assert.equal(
    request.input[0].content[1].image_url,
    'data:image/jpeg;base64,' + photo.jpeg.toString('base64'),
  );
  assert.ok(request.text.format.schema.required.includes('factChanges'));
  assert.ok(request.text.format.schema.required.includes('shortReason'));
});
