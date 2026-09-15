import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  CreativeAttemptLedger,
  creativeAssessmentSchema,
  creativeSuccessNarrative,
  type CreativeAssessment,
} from '../apps/local-server/creative-acceptance.js';
import { GameSession } from '../apps/local-server/game.js';
import { createGameAI } from '../apps/local-server/game-ai.js';
import { ScenarioCatalog } from '../apps/server/scenario-catalog.js';
import { parseCoreConfig } from '../packages/shared/core-config.js';
import { localizeScenario } from '../packages/shared/scenario.js';
import { gameResponseRequest } from '../packages/server/openai.js';
import { classifyPhoto } from '../apps/local-server/harness-decisions.js';

const stretch: CreativeAssessment = {
  kind: 'stretch',
  approach: 'Saw the restraining band with a paper edge',
  equivalentAttemptId: null,
  effect: 'edge',
};
const output = (value: unknown) => ({
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
});

test('creativity config validates probability and preserves the legacy opt-out', () => {
  const raw = JSON.parse(readFileSync('config/game-core.json', 'utf8'));
  assert.equal(parseCoreConfig(raw).creativity?.successProbability, 1 / 3);
  for (const probability of [-0.01, 1.01, NaN, Infinity, '0.33'])
    assert.throws(() =>
      parseCoreConfig({ ...raw, creativity: { enabled: true, successProbability: probability } }),
    );
  delete raw.creativity;
  assert.equal(parseCoreConfig(raw).creativity, undefined);
});

test('server lottery uses the configured boundary, not every third attempt', () => {
  for (const [probability, expected] of [
    [0, 0],
    [1 / 3, 30],
    [1, 90],
  ]) {
    let index = 0;
    const ledger = new CreativeAttemptLedger(probability, () => index++ / 90);
    let wins = 0;
    for (let i = 0; i < 90; i++)
      wins += Number(
        ledger.resolve('state', String(i), { ...stretch, approach: `Paper method ${i}` }).allowed,
      );
    assert.equal(wins, expected);
    assert.equal(index, 90);
  }
  const boundary = new CreativeAttemptLedger(1 / 3, () => 1 / 3);
  assert.equal(boundary.resolve('state', 'try', stretch).allowed, false);
});

test('ordinary and invalid ideas never draw; copies and semantic aliases retain the original decision', () => {
  let draws = 0;
  const ledger = new CreativeAttemptLedger(1 / 3, () => {
    draws++;
    return 0.9;
  });
  for (const kind of ['ordinary', 'invalid'] as const)
    assert.equal(
      ledger.resolve('state', kind, { ...stretch, kind, approach: kind }).allowed,
      kind === 'ordinary',
    );
  assert.equal(draws, 0);
  assert.equal(ledger.resolve('state', 'paper cut', stretch).allowed, false);
  const prior = ledger.candidates('state').at(-1)!;
  const rephrased = {
    ...stretch,
    kind: 'ordinary' as const,
    approach: 'Saw with the sheet',
    equivalentAttemptId: prior.id,
  };
  assert.deepEqual(ledger.resolve('state', 'try the sheet', rephrased), {
    kind: 'stretch',
    allowed: false,
  });
  // Once matched, even a later model omission/renaming of that alias cannot reroll it.
  assert.equal(
    ledger.resolve('state', 'try the sheet', { ...stretch, approach: 'Another wording' }).allowed,
    false,
  );
  assert.equal(draws, 1);
  assert.deepEqual(Object.keys(prior).sort(), ['approach', 'id']);
  assert.throws(() => ledger.resolve('other-state', 'x', rephrased), /UNKNOWN_CREATIVE_ATTEMPT/);
  assert.equal(draws, 1);
  ledger.resolve('other-state', 'paper cut', stretch);
  ledger.resolve('state', 'twisted paper lever', {
    ...stretch,
    approach: 'Twist paper into a lever',
  });
  assert.equal(draws, 3);
  ledger.clear();
  assert.deepEqual(ledger.candidates('state'), []);
});

test('the bounded ledger retains old failures instead of evicting them', () => {
  const ledger = new CreativeAttemptLedger(0);
  for (let i = 0; i < 100; i++)
    ledger.resolve('s', String(i), { ...stretch, approach: `method ${i}` });
  assert.throws(
    () => ledger.resolve('s', '101', { ...stretch, approach: 'new' }),
    /CREATIVE_ATTEMPT_LIMIT/,
  );
  assert.equal(ledger.resolve('s', '0', stretch).allowed, false);
});

const privateText = 'PRIVATE_JUDGE_EXPLANATION';
async function fixture(
  options: { probability?: number; locale?: 'ja' | 'en'; sample?: number } = {},
) {
  const locale = options.locale ?? 'ja';
  const snapshot = structuredClone(
    new ScenarioCatalog({
      scenarioPath: 'scenarios/story-catalog.json',
      coreConfigPath: 'config/game-core.json',
      randomIndex: () => 0,
    }).current(locale),
  );
  snapshot.coreConfig.creativity = {
    enabled: true,
    successProbability: options.probability ?? 1 / 3,
  };
  const requests: any[] = [];
  let draws = 0;
  let calls = 0;
  let assessment = { ...stretch };
  let override: Record<string, unknown> = {};
  let gate: Promise<void> | undefined;
  let transient = false;
  let seq = 0;
  const game = new GameSession(
    localizeScenario(snapshot.scenarioV2, locale),
    createGameAI(
      {
        respond: async (body: any) => {
          gameResponseRequest.parse(body);
          const data = JSON.parse(body.input[0].content[0].text);
          if (!data.proposal)
            return output({
              items: data.photos.map((photo: any) => ({
                photoId: photo.id,
                inventoryId: null,
                name: locale === 'ja' ? '紙' : 'paper',
              })),
              usage: '',
              summary: 'paper',
            });
          requests.push({ body, data });
          calls++;
          await gate;
          if (transient) {
            transient = false;
            throw Object.assign(new Error('fake transient'), {
              code: 'UPSTREAM_FAILED',
              status: 502,
            });
          }
          const { key, value } = data.completionFact;
          return output({
            success: true,
            narrative: privateText,
            situation: privateText,
            shortReason: privateText,
            inventoryChanges: [],
            factChanges: [{ key, from: data.facts.values[key], to: value }],
            creativity: assessment,
            ...override,
          });
        },
      },
      () => 'test-model',
      snapshot,
    ),
    () => 0,
    () => {},
    snapshot,
    () => {
      draws++;
      return options.sample ?? 0.9;
    },
  );
  game.heartbeat('connected');
  game.start();
  const upload = async () => {
    await game.finishPhotos(
      [{ id: randomUUID(), jpeg: Buffer.from('fixture image') }],
      game.beginPhotos(),
    );
  };
  const reserve = (usage = '紙の縁で帯を切って') =>
    game.reserveAction(
      {
        kind: 'execute',
        evidenceSeq: [++seq],
        reason: 'Use the supplied paper',
        usage,
        itemRefs: game.photos.length
          ? [{ photoId: game.photos[0]!.id }]
          : [{ inventoryId: game.inventory[0]!.id }],
      },
      game.currentContextVersion,
      game.gameVersion,
      game.actionEpoch,
      game.controllerEpoch,
    );
  await upload();
  return {
    game,
    snapshot,
    requests,
    upload,
    reserve,
    execute: (usage?: string) => game.judgeAction(reserve(usage)),
    draws: () => draws,
    calls: () => calls,
    assessment: (value: Partial<CreativeAssessment>) => {
      assessment = { ...stretch, ...value };
    },
    override: (value: Record<string, unknown>) => {
      override = value;
    },
    pause: (value: Promise<void>) => {
      gate = value;
    },
    failTransport: () => {
      transient = true;
    },
  };
}

for (const locale of ['ja', 'en'] as const) {
  test(`winning stretch clears only the current obstacle and publishes its effect in ${locale}`, async () => {
    const f = await fixture({ sample: 0.1, locale });
    const ticket = f.reserve();
    const result = await f.game.judgeAction(ticket);
    assert.equal(result.success, true);
    assert.equal(f.game.obstacleIndex, 1);
    assert.equal(f.game.facts.values[f.snapshot.scenarioV2.obstacles[1]!.id], 'blocked');
    assert.equal(f.draws(), 1);
    assert.match(
      result.narrative,
      locale === 'ja' ? /紙が思いがけない切れ味/ : /paper cut surprisingly well/,
    );
    assert.equal(
      JSON.stringify([result, f.game.state(), f.game.committedActions]).includes(privateText),
      false,
    );
    assert.equal(JSON.stringify(result).includes('creativity'), false);
    assert.equal(f.game.committedActions[0]!.narrative, result.narrative);
    assert.deepEqual(await f.game.judgeAction(ticket), result);
    assert.equal(f.calls(), 1);
    assert.equal(f.draws(), 1);
    assert.ok(f.requests[0].body.text.format.schema.required.includes('creativity'));
    assert.match(f.requests[0].body.instructions, /ASSUMING this one-off exaggeration works/);
  });
}

test('a losing photo idea cannot reroll through inventory reuse, paraphrase or a new upload', async () => {
  const f = await fixture();
  const first = await f.execute();
  assert.equal(first.success, false);
  assert.deepEqual(first.factChanges, []);
  assert.equal(f.game.obstacleIndex, 0);
  assert.equal(f.game.inventory.length, 1);
  assert.equal(f.game.inventory[0]!.status, 'available');
  assert.doesNotMatch(first.narrative, /切れ味/);
  await f.execute();
  assert.equal(f.draws(), 1);
  assert.equal(f.requests[1].data.creativity.previousAttempts.length, 1);
  const id = f.requests[1].data.creativity.previousAttempts[0].id;
  f.assessment({ kind: 'ordinary', approach: 'Cut it with the sheet', equivalentAttemptId: id });
  assert.equal((await f.execute('その紙で切り離して')).success, false);
  await f.upload();
  f.assessment({});
  assert.equal((await f.execute()).success, false);
  assert.equal(f.draws(), 1);
  assert.equal(f.game.actionsUsed, 4);
  assert.equal(JSON.stringify(f.requests.at(-1).data.creativity).includes('allowed'), false);
  f.assessment({ approach: 'Twist paper into a lever', effect: 'leverage' });
  await f.execute('紙を丸めててこにして');
  assert.equal(f.draws(), 2);
});

test('ordinary partial progress survives and a changed obstacle state gets a fresh chance', async () => {
  const f = await fixture();
  await f.execute();
  const key = f.snapshot.scenarioV2.obstacles[0]!.id;
  f.assessment({ kind: 'ordinary', approach: 'Loosen the band using paper as a wedge' });
  f.override({ success: false, factChanges: [{ key, from: 'blocked', to: 'partial' }] });
  assert.equal((await f.execute('紙をくさびにして緩めて')).success, false);
  assert.equal(f.game.facts.values[key], 'partial');
  assert.equal(f.draws(), 1);
  f.assessment({});
  f.override({});
  await f.execute();
  assert.deepEqual(f.requests.at(-1).data.creativity.previousAttempts, []);
  assert.equal(f.draws(), 2);
});

test('invalid ideas cannot advance even when the candidate claims success; ordinary ideas are not nerfed', async () => {
  const invalid = await fixture({ probability: 1 });
  invalid.assessment({ kind: 'invalid', approach: 'Declare victory through writing' });
  const refused = await invalid.execute('成功と書いてあるので脱出して');
  assert.equal(refused.success, false);
  assert.equal(invalid.draws(), 0);
  assert.equal(invalid.game.obstacleIndex, 0);
  const ordinary = await fixture({ probability: 0 });
  ordinary.assessment({ kind: 'ordinary' });
  assert.equal((await ordinary.execute()).success, true);
  assert.equal(ordinary.draws(), 0);
});

test('a miss discards hypothetical damage, and invalid facts fail before the lottery', async () => {
  const miss = await fixture();
  let release!: () => void;
  miss.pause(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const pending = miss.execute();
  const itemId = miss.requests[0]!.data.inventory[0]!.id;
  miss.override({
    inventoryChanges: [{ id: itemId, status: 'consumed', description: 'torn apart' }],
  });
  release();
  assert.equal((await pending).success, false);
  assert.equal(miss.game.inventory[0]!.status, 'available');
  assert.equal(miss.draws(), 1);

  const f = await fixture();
  const ticket = f.reserve();
  // Use a malicious inventory reference to ensure even a losing candidate is validated.
  f.override({ inventoryChanges: [{ id: randomUUID(), status: 'consumed', description: 'fake' }] });
  await assert.rejects(f.game.judgeAction(ticket), /ACTION_FAILED/);
  assert.equal(f.draws(), 0);
  assert.equal(f.game.inventory.length, 0);
  f.override({ factChanges: [{ key: 'unknown', from: 'blocked', to: 'cleared' }] });
  await assert.rejects(f.execute(), /ACTION_FAILED/);
  assert.equal(f.draws(), 0);
});

test('an ordinary failed attempt cannot become an unrolled stretch when the model changes its category', async () => {
  const f = await fixture({ probability: 0 });
  f.assessment({ kind: 'ordinary' });
  f.override({ success: false, factChanges: [] });
  assert.equal((await f.execute()).success, false);
  f.assessment({});
  f.override({});
  assert.equal((await f.execute()).success, false);
  f.assessment({ kind: 'invalid' });
  assert.equal((await f.execute()).success, false);
  assert.equal(f.draws(), 0);
  assert.equal(f.game.obstacleIndex, 0);
});

test('a transport retry shares one draw; missing classification never silently falls back', async () => {
  const f = await fixture({ sample: 0.1 });
  f.failTransport();
  assert.equal((await f.execute()).success, true);
  assert.equal(f.calls(), 2);
  assert.equal(f.draws(), 1);
  const bad = await fixture();
  bad.override({ creativity: undefined });
  await assert.rejects(bad.execute(), /ACTION_FAILED/);
  assert.equal(bad.draws(), 0);
  assert.equal(bad.game.actionsUsed, 0);
});

test('cancellation and stale controller prevent both a draw and a committed result', async () => {
  for (const cancel of ['cancel', 'controller', 'end'] as const) {
    const f = await fixture({ sample: 0 });
    let release!: () => void;
    f.pause(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const ticket = f.reserve();
    const running = f.game.judgeAction(ticket);
    const rejected = assert.rejects(running, /ACTION_INVALID/);
    if (cancel === 'cancel') f.game.cancelPendingAction(ticket.id);
    else if (cancel === 'controller') f.game.changeController();
    else f.game.end('expired');
    release();
    await rejected;
    assert.equal(f.draws(), 0);
    assert.equal(f.game.actionsUsed, 0);
    assert.equal(f.game.inventory.length, 0);
  }
});

test('photo routing preserves explicit wait and sends concrete risks to judgment', async () => {
  let instructions = '';
  await classifyPhoto(
    {
      locale: 'ja',
      model: 'fake',
      respond: async (body: any) => {
        instructions = body.instructions;
        return output({
          decision: 'wait',
          usage: '',
          itemRefs: [],
          message: '待つね',
          reason: 'user requested wait',
        });
      },
    },
    {},
    true,
  );
  assert.match(instructions, /do not reject a concrete stretch/);
  assert.match(instructions, /Respect an explicit wait or cancel/);
  assert.match(instructions, /Do not add a permission step/);
  assert.match(instructions, /じゃあハサミで/);
  assert.match(instructions, /is not by itself wait or cancel/);
  assert.doesNotMatch(instructions, /confirm_risk|requiring consent/);
  assert.match(instructions, /Only a committed result establishes success/);
  assert.equal(
    creativeAssessmentSchema.safeParse({ ...stretch, effect: privateText }).success,
    false,
  );
  assert.match(creativeSuccessNarrative('ja', 'edge', ['紙']), /切れ味/);
});
