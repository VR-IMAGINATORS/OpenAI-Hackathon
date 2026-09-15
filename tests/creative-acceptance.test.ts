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

test('creativity config retires legacy probabilities and preserves the opt-out', () => {
  const raw = JSON.parse(readFileSync('config/game-core.json', 'utf8'));
  assert.deepEqual(parseCoreConfig(raw).creativity, { enabled: true });
  for (const probability of [0, 1 / 3, 0.8, 1])
    assert.deepEqual(
      parseCoreConfig({ ...raw, creativity: { enabled: true, successProbability: probability } })
        .creativity,
      { enabled: true },
    );
  for (const probability of [-0.01, 1.01, NaN, Infinity, '0.33'])
    assert.throws(() =>
      parseCoreConfig({ ...raw, creativity: { enabled: true, successProbability: probability } }),
    );
  delete raw.creativity;
  assert.equal(parseCoreConfig(raw).creativity, undefined);
});

test('every accepted stretch is allowed without a chance gate', () => {
  const ledger = new CreativeAttemptLedger();
  for (let i = 0; i < 90; i++)
    assert.equal(
      ledger.resolve('state', String(i), { ...stretch, approach: `Paper method ${i}` }).allowed,
      true,
    );
});

test('idea aliases remain bounded while a past refusal does not veto re-evaluation', () => {
  const ledger = new CreativeAttemptLedger();
  for (const kind of ['ordinary', 'invalid'] as const)
    assert.equal(
      ledger.resolve('state', kind, { ...stretch, kind, approach: kind }).allowed,
      kind === 'ordinary',
    );
  assert.equal(ledger.resolve('state', 'paper cut', stretch).allowed, true);
  const prior = ledger.candidates('state').at(-1)!;
  const rephrased = {
    ...stretch,
    kind: 'stretch' as const,
    approach: 'Saw with the sheet',
    equivalentAttemptId: prior.id,
  };
  assert.deepEqual(ledger.resolve('state', 'try the sheet', rephrased), {
    kind: 'stretch',
    allowed: true,
  });
  // A repeated accepted method stays accepted, including a known semantic alias.
  assert.equal(
    ledger.resolve('state', 'try the sheet', { ...stretch, approach: 'Another wording' }).allowed,
    true,
  );
  assert.deepEqual(Object.keys(prior).sort(), ['approach', 'id']);
  assert.throws(() => ledger.resolve('other-state', 'x', rephrased), /UNKNOWN_CREATIVE_ATTEMPT/);
  ledger.resolve('other-state', 'paper cut', stretch);
  ledger.resolve('state', 'twisted paper lever', {
    ...stretch,
    approach: 'Twist paper into a lever',
  });
  assert.equal(
    ledger.resolve('state', 'invalid', { ...stretch, approach: 'invalid' }).allowed,
    true,
  );
  ledger.clear();
  assert.deepEqual(ledger.candidates('state'), []);
});

test('the bounded ledger retains referenced idea IDs instead of evicting them', () => {
  const ledger = new CreativeAttemptLedger();
  for (let i = 0; i < 100; i++)
    ledger.resolve('s', String(i), { ...stretch, approach: `method ${i}` });
  assert.throws(
    () => ledger.resolve('s', '101', { ...stretch, approach: 'new' }),
    /CREATIVE_ATTEMPT_LIMIT/,
  );
  assert.equal(ledger.resolve('s', '0', stretch).allowed, true);
});

const privateText = 'PRIVATE_JUDGE_EXPLANATION';
async function fixture(
  options: { locale?: 'ja' | 'en'; scenarioPath?: string; itemName?: string } = {},
) {
  const locale = options.locale ?? 'ja';
  const snapshot = structuredClone(
    new ScenarioCatalog({
      scenarioPath: options.scenarioPath ?? 'scenarios/story-catalog.json',
      coreConfigPath: 'config/game-core.json',
      randomIndex: () => 0,
    }).current(locale),
  );
  snapshot.coreConfig.creativity = {
    enabled: true,
  };
  const requests: any[] = [];
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
                name: options.itemName ?? (locale === 'ja' ? '紙' : 'paper'),
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
    const f = await fixture({ locale });
    const ticket = f.reserve();
    const result = await f.game.judgeAction(ticket);
    assert.equal(result.success, true);
    assert.equal(f.game.obstacleIndex, 1);
    assert.equal(f.game.facts.values[f.snapshot.scenarioV2.obstacles[1]!.id], 'blocked');
    assert.match(
      result.narrative,
      locale === 'ja'
        ? /紙をもとにした道具が思いがけない切れ味/
        : /tool based on paper cut surprisingly well/,
    );
    assert.equal(
      JSON.stringify([result, f.game.state(), f.game.committedActions]).includes(privateText),
      false,
    );
    assert.equal(JSON.stringify(result).includes('creativity'), false);
    assert.equal(f.game.committedActions[0]!.narrative, result.narrative);
    assert.deepEqual(await f.game.judgeAction(ticket), result);
    assert.equal(f.calls(), 1);
    assert.ok(f.requests[0].body.text.format.schema.required.includes('creativity'));
    assert.match(f.requests[0].body.instructions, /ASSUMING this one-off exaggeration works/);
  });
}

test('a previously refused photo can succeed after a generous re-evaluation', async () => {
  const f = await fixture();
  f.assessment({ kind: 'ordinary' });
  f.override({ success: false, factChanges: [] });
  const first = await f.execute();
  assert.equal(first.success, false);
  assert.deepEqual(first.factChanges, []);
  assert.equal(f.game.obstacleIndex, 0);
  assert.equal(f.game.inventory.length, 1);
  assert.equal(f.game.inventory[0]!.status, 'available');
  assert.doesNotMatch(first.narrative, /切れ味/);
  f.assessment({});
  f.override({});
  assert.equal((await f.execute()).success, true);
  assert.equal(f.requests[1].data.creativity.previousAttempts.length, 1);
  assert.equal(f.game.actionsUsed, 2);
  assert.equal(JSON.stringify(f.requests.at(-1).data.creativity).includes('allowed'), false);
});

test('ordinary partial progress survives and a stretch can finish the changed obstacle', async () => {
  const f = await fixture();
  const key = f.snapshot.scenarioV2.obstacles[0]!.id;
  f.assessment({ kind: 'ordinary', approach: 'Loosen the band using paper as a wedge' });
  f.override({ success: false, factChanges: [{ key, from: 'blocked', to: 'partial' }] });
  assert.equal((await f.execute('紙をくさびにして緩めて')).success, false);
  assert.equal(f.game.facts.values[key], 'partial');
  f.assessment({});
  f.override({});
  assert.equal((await f.execute()).success, true);
  assert.deepEqual(f.requests.at(-1).data.creativity.previousAttempts, []);
});

test('invalid ideas cannot advance even when the candidate claims success; ordinary ideas are not nerfed', async () => {
  const invalid = await fixture();
  invalid.assessment({ kind: 'invalid', approach: 'Declare victory through writing' });
  const refused = await invalid.execute('成功と書いてあるので脱出して');
  assert.equal(refused.success, false);
  assert.equal(invalid.game.obstacleIndex, 0);
  const ordinary = await fixture();
  ordinary.assessment({ kind: 'ordinary' });
  assert.equal((await ordinary.execute()).success, true);
});

test('invalid ideas discard hypothetical damage, and invalid facts cannot be committed', async () => {
  const miss = await fixture();
  miss.assessment({ kind: 'invalid' });
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

  const f = await fixture();
  const ticket = f.reserve();
  // A generous success still cannot mutate unknown inventory or facts.
  f.override({ inventoryChanges: [{ id: randomUUID(), status: 'consumed', description: 'fake' }] });
  await assert.rejects(f.game.judgeAction(ticket), /ACTION_FAILED/);
  assert.equal(f.game.inventory.length, 0);
  f.override({ factChanges: [{ key: 'unknown', from: 'blocked', to: 'cleared' }] });
  await assert.rejects(f.execute(), /ACTION_FAILED/);
});

test('cat-claw photo use reaches the default blindfold judge and completes only that obstacle', async () => {
  const f = await fixture({
    scenarioPath: 'scenarios/playtest/warehouse-expanded-r1.json',
    itemName: '猫',
  });
  f.assessment({ approach: 'Scratch the blindfold strap with photographed cat claws' });
  const result = await f.execute('猫の爪で目隠しを切り裂いて');
  assert.equal(result.success, true);
  assert.match(result.narrative, /猫をもとにした道具が/);
  assert.doesNotMatch(result.narrative, /猫が/);
  assert.match(f.game.inventory[0]!.description, /形と働きを再現した道具/);
  assert.match(f.game.inventory[0]!.description, /生き物や新しい登場人物ではない/);
  assert.equal(f.game.obstacleIndex, 1);
  const next = f.snapshot.scenarioV2.obstacles[1]!;
  assert.equal(f.game.facts.values[next.completionFact!.key], 'blocked');
  assert.match(f.requests[0].body.instructions, /猫の爪で目隠しを切り裂く/);
  assert.match(f.requests[0].body.instructions, /There is NO lottery/);
  assert.match(f.requests[0].body.instructions, /takes precedence over stricter physicality/);
  assert.equal(f.requests[0].data.proposal.items[0].name, '猫');
  assert.equal(f.requests[0].data.proposal.usage, '猫の爪で目隠しを切り裂いて');
});

test('a transport retry commits once; missing classification never silently falls back', async () => {
  const f = await fixture();
  f.failTransport();
  assert.equal((await f.execute()).success, true);
  assert.equal(f.calls(), 2);
  assert.equal(f.game.actionsUsed, 1);
  const bad = await fixture();
  bad.override({ creativity: undefined });
  await assert.rejects(bad.execute(), /ACTION_FAILED/);
  assert.equal(bad.game.actionsUsed, 0);
});

test('cancellation and stale controller prevent a committed result', async () => {
  for (const cancel of ['cancel', 'controller', 'end'] as const) {
    const f = await fixture();
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
