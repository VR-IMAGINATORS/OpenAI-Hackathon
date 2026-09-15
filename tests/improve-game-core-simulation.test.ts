import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadExpansionConfig } from '../tools/auto-mission/expansion/config.js';
import {
  generateCandidate,
  mockGeneratorClient,
} from '../tools/auto-mission/expansion/generator.js';
import { TextPlayAdapter } from '../tools/auto-mission/expansion/play-adapter.js';
import {
  createMockPlayClient,
  playerRequestSchema,
  requestPlayerTurn,
} from '../tools/auto-mission/expansion/player.js';
import {
  createPlayMatrix,
  pilotRows,
  remainingRows,
  pilot,
  remaining,
  retryPlay,
  runPlay,
  type PilotContext,
} from '../tools/auto-mission/expansion/matrix.js';
import { ExpansionStore, artifactDigest } from '../tools/auto-mission/expansion/store.js';
import {
  ExpansionBudget,
  EXPANSION_LIMITS,
  MeasuredResponsesClient,
} from '../tools/auto-mission/expansion/budget.js';
import { EXPANSION_PRICING } from '../tools/auto-mission/expansion/usage.js';
import type { AIResponsesClient } from '../apps/local-server/game-ai.js';
const input = await loadExpansionConfig('config/auto-mission/expand-default.json');
const generated = await generateCandidate(input, mockGeneratorClient(input.source));
const response = (body: any, value: unknown) => ({
  model: body.model,
  status: 'completed',
  usage: { input_tokens: 1, output_tokens: 1 },
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
});
function adapter(client = createMockPlayClient()) {
  return new TextPlayAdapter({
    scenario: generated.compiled,
    coreConfig: input.coreConfig,
    locale: input.config.locale,
    gameModel: input.config.gameModel,
    catalog: input.config.objectCatalog,
    client,
  });
}
async function fixture(
  work: (ctx: PilotContext, setClient: (client: AIResponsesClient) => void) => Promise<void>,
  turns = 2,
) {
  const root = await mkdtemp(join(tmpdir(), 'expansion-simulation-'));
  const fixed = structuredClone(input);
  fixed.config.maxTurns = turns;
  const limits = EXPANSION_LIMITS.remaining;
  const store = await ExpansionStore.create(
    root,
    {
      schemaVersion: 1,
      kind: 'mission-expansion',
      runId: randomUUID(),
      mode: 'mock',
      parentRunId: null,
      conditions: {
        sourceDigest: fixed.source.sourceDigest,
        candidateDigest: artifactDigest(generated.candidate),
        revision: 1,
        codeRevision: 'unit',
        dirtyDigest: '0'.repeat(64),
        configDigest: fixed.configDigest,
        promptDigests: fixed.promptDigests,
        catalogDigest: fixed.catalogDigest,
        locale: fixed.config.locale,
        rules: generated.compiled.rules,
        initiative: fixed.config.initiative,
        selectedModels: {
          generator: fixed.config.generator.model,
          game: fixed.config.gameModel,
          ...Object.fromEntries(fixed.config.playerModels.map((m, i) => ['player-' + i, m])),
        },
      },
      pricingSnapshot: EXPANSION_PRICING,
      stage: 'static_check',
      budgets: {
        maxCostUsd: null,
        maxCalls: limits.maxCalls,
        maxOutputTokens: limits.maxOutputTokens,
        deadlineMs: limits.deadlineMs,
      },
      playMatrix: createPlayMatrix(fixed.config),
      plays: [],
      callIds: [],
    },
    fixed.source,
    generated.candidate,
  );
  const budget = new ExpansionBudget({ mode: 'mock', pricing: EXPANSION_PRICING, limits });
  let raw = createMockPlayClient();
  const ctx: PilotContext = {
    input: fixed,
    ...generated,
    store,
    budget,
    createClient: (playId, scopeId = playId) => {
      budget.addScope(scopeId, EXPANSION_LIMITS.play);
      return new MeasuredResponsesClient(
        raw,
        budget,
        () => ({ revision: 1, playId, scopeId }),
        (call) => store.saveCall(call),
      );
    },
  };
  try {
    await work(ctx, (client) => {
      raw = client;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test('player request is strict and public view excludes game secrets and internal diagnostics', async () => {
  const a = adapter();
  try {
    const view = a.view();
    assert.deepEqual(Object.keys(view).sort(), ['availableObjects', 'history', 'opening', 'state']);
    assert.doesNotMatch(
      JSON.stringify(view),
      /mechanism|referenceSolutions|shortReason|requestCue|knowledgeMetadata|secretFacts|privateDiagnostics|sourceDigest/,
    );
    let sent: any;
    const mock = createMockPlayClient();
    await requestPlayerTurn({
      client: {
        respond: async (body) => {
          sent = body;
          return mock.respond(body);
        },
      },
      model: input.config.playerModels[0]!,
      persona: 'broad',
      locale: 'ja',
      view,
      prompts: input.playerPrompts,
    });
    assert.deepEqual(JSON.parse(sent.input[0].content[0].text), { view });
    assert.equal(sent.text.format.schema.properties.request.anyOf.length, 2);
    assert.doesNotMatch(JSON.stringify(sent.text.format.schema), /oneOf/);
    for (const bad of [
      { kind: 'ask', text: '?', hidden: 'x' },
      { kind: 'send_items', catalogIds: [], usage: null },
      { kind: 'send_items', catalogIds: ['a', 'b', 'c'], usage: null },
      { kind: 'send_items', catalogIds: ['a'], usage: ' ' },
      { kind: 'execute', usage: 'x' },
    ])
      assert.equal(playerRequestSchema.safeParse(bad).success, false);
    await assert.rejects(
      () => a.turn({ kind: 'send_items', catalogIds: ['unknown'], usage: null }),
      /UNKNOWN_ITEM/,
    );
    const id = input.config.objectCatalog[0]!.id;
    await assert.rejects(
      () => a.turn({ kind: 'send_items', catalogIds: [id, id], usage: null }),
      /DUPLICATE_ITEM/,
    );
    assert.equal(a.game.actionsUsed, 0);
  } finally {
    a.close();
  }
});
test('photo selection reaches common action judge without image bytes and includes ordinary properties', async () => {
  const seen: any[] = [];
  const mock = createMockPlayClient();
  const a = adapter({
    respond: async (body, signal) => {
      const b = body as any;
      seen.push(b);
      const data = JSON.parse(b.input[0].content[0].text);
      if (b.text.format.name === 'harness_photo')
        return response(b, {
          decision: 'execute',
          itemRefs: [{ photoId: data.photos[0] }],
          usage: '試す',
          message: '試す。',
          reason: 'PRIVATE_REASON',
        });
      return mock.respond(body, signal);
    },
  });
  try {
    const before = a.diagnostics();
    const result = await a.turn({
      kind: 'send_items',
      catalogIds: [input.config.objectCatalog[0]!.id],
      usage: null,
    });
    assert.equal(a.game.actionsUsed, 1);
    assert.equal(
      result.publicStateAfter.creditsRemaining,
      result.publicStateBefore.creditsRemaining - 100,
    );
    assert.equal(seen.filter((b) => b.text.format.name === 'game_result').length, 1);
    assert.doesNotMatch(JSON.stringify(seen), /input_image|data:image/);
    const judge = JSON.parse(
      seen.find((b) => b.text.format.name === 'game_result').input[0].content[0].text,
    );
    assert.deepEqual(
      judge.recognizedObjectProperties[0].ordinaryProperties,
      input.config.objectCatalog[0]!.ordinaryProperties,
    );
    assert.equal(a.diagnostics().remainingMs, before.remainingMs);
    assert.equal(a.diagnostics().waitingRemainingMs, before.waitingRemainingMs);
    assert.doesNotMatch(JSON.stringify(a.view()), /PRIVATE_REASON|mock unsuccessful action/);
  } finally {
    a.close();
  }
});
test('three diagonal pilots stop before six remaining unique model/persona pairs', async () =>
  fixture(async (ctx) => {
    const matrix = createPlayMatrix(ctx.input.config);
    assert.equal(matrix.length, 9);
    assert.equal(new Set(matrix.map((r) => r.model + ':' + r.persona)).size, 9);
    assert.deepEqual(
      pilotRows(ctx.input.config).map((r) => r.playId),
      ['play-0-0', 'play-1-1', 'play-2-2'],
    );
    assert.equal(remainingRows(ctx.input.config).length, 6);
    await pilot(ctx);
    assert.equal(ctx.store.snapshot.stage, 'pilot_reported');
    assert.equal((await ctx.store.readPlays()).length, 3);
    await pilot(ctx);
    assert.equal((await ctx.store.readPlays()).length, 3);
    await remaining(ctx);
    assert.equal(ctx.store.snapshot.stage, 'reviewing');
    const plays = await ctx.store.readPlays();
    assert.equal(plays.length, 9);
    assert.ok(
      plays.every(
        (p) =>
          p.status === 'uncleared' && p.terminationReason === 'turn_limit' && p.turns.length === 2,
      ),
    );
    const roles = new Set((await ctx.store.readCalls()).map((c) => c.role));
    assert.ok(roles.has('expansion_player'));
    assert.ok(roles.has('core_intent'));
    assert.ok(roles.has('knowledge_selection'));
    assert.ok(plays.every((p) => p.callIds.length >= 4));
    assert.equal(plays.flatMap((p) => p.callIds).length, (await ctx.store.readCalls()).length);
  }));
test('maximum 25 turns remains uncleared, with checkpoints and fixed game clock', async () =>
  fixture(async (ctx) => {
    const play = await runPlay(ctx, pilotRows(ctx.input.config)[0]!);
    assert.equal(play.status, 'uncleared');
    assert.equal(play.turns.length, 25);
    assert.equal(play.stateVersions.length, 26);
    const versions = play.stateVersions as any[];
    assert.equal(new Set(versions.map((v) => v.remainingMs)).size, 1);
    assert.equal(versions[0].measurementScope.voice, 'not_exercised');
    assert.ok(play.disclosureTrace.length);
  }, 25));
test('communication failure is incomplete and retry starts fresh attempt preserving previous calls', async () =>
  fixture(async (ctx, setClient) => {
    setClient({
      respond: async () => {
        throw new Error('secret transport diagnostic');
      },
    });
    await pilot(ctx);
    let plays = await ctx.store.readPlays();
    assert.equal(ctx.store.snapshot.stage, 'incomplete');
    assert.equal(plays.length, 1);
    assert.equal(plays[0]!.status, 'incomplete');
    assert.equal(plays[0]!.turns.length, 0);
    assert.equal(plays[0]!.terminationReason, 'TRANSPORT_OR_CHECKPOINT_FAILURE');
    const failed = structuredClone(plays[0]);
    setClient(createMockPlayClient());
    await retryPlay(ctx, 'play-0-0');
    assert.equal(ctx.store.snapshot.stage, 'awaiting_pilot');
    plays = await ctx.store.readPlays();
    assert.equal(plays.length, 2);
    assert.deepEqual(plays[0], failed);
    assert.notEqual(plays[0]!.attemptId, plays[1]!.attemptId);
    assert.equal((plays[1]!.turns[0] as any).publicStateBefore.actionsUsed, 0);
    await pilot(ctx);
    assert.equal((await ctx.store.reusablePlays()).length, 3);
    assert.equal(ctx.store.snapshot.stage, 'pilot_reported');
    await assert.rejects(() => retryPlay(ctx, 'play-0-0'), /RETRY_REQUIRES/);
  }));
test('frozen conditions and out-of-order remaining refuse before any API', async () =>
  fixture(async (ctx) => {
    await assert.rejects(() => remaining(ctx), /REMAINING_STAGE_INVALID/);
    const changed = { ...ctx, input: structuredClone(ctx.input) };
    changed.input.config.gameModel = 'gpt-6-astra';
    await assert.rejects(() => pilot(changed), /CONDITIONS_MISMATCH/);
    assert.equal(ctx.budget.calls.length, 0);
  }));

test('photo danger waits and ask confirms through the same classifier and action judge', async () => {
  const mock = createMockPlayClient();
  let judges = 0;
  const a = adapter({
    respond: async (body, signal) => {
      const b = body as any,
        data = JSON.parse(b.input[0].content[0].text);
      if (b.text.format.name === 'harness_photo')
        return response(b, {
          decision: 'confirm_risk',
          itemRefs: [{ photoId: data.photos[0] }],
          usage: '危険を承知で使う',
          message: '壊れるかもしれない。続ける？',
          reason: 'risk',
        });
      if (b.text.format.name === 'core_intent')
        return response(b, {
          decision: {
            kind: 'execute',
            evidenceSeq: data.conversation.eligibleEvidenceSeq,
            itemRefs: data.game.pendingRisk.itemRefs,
            usage: data.game.pendingRisk.usage,
            reason: 'confirmed',
          },
          inferences: [],
        });
      if (b.text.format.name === 'game_result') judges++;
      return mock.respond(body, signal);
    },
  });
  try {
    await a.turn({
      kind: 'send_items',
      catalogIds: [input.config.objectCatalog[0]!.id],
      usage: null,
    });
    assert.equal(a.game.actionsUsed, 0);
    assert.equal(judges, 0);
    const r = await a.turn({ kind: 'ask', text: 'はい、それを実行して' });
    assert.equal(judges, 1);
    assert.equal(r.publicStateAfter.actionsUsed, 1);
    assert.equal(r.publicStateAfter.creditsRemaining, 880);
  } finally {
    a.close();
  }
});
for (const failedJudgment of [false, true])
  test(
    'simulation uses public action facts without narration and preserves API failures: ' +
      failedJudgment,
    async () =>
      fixture(async (ctx, setClient) => {
        const mock = createMockPlayClient();
        const schemas: string[] = [];
        setClient({
          respond: async (body, signal) => {
            const b = body as any,
              data = JSON.parse(b.input[0].content[0].text);
            schemas.push(b.text.format.name);
            if (failedJudgment && b.text.format.name === 'game_result')
              throw new Error('upstream failure');
            if (b.text.format.name === 'expansion_player')
              return response(b, {
                request: {
                  kind: 'send_items',
                  catalogIds: [input.config.objectCatalog[0]!.id],
                  usage: null,
                },
              });
            if (b.text.format.name === 'harness_photo')
              return response(b, {
                decision: 'execute',
                itemRefs: [{ photoId: data.photos[0] }],
                usage: '試す',
                message: '試す',
                reason: 'fixture',
              });
            if (b.text.format.name === 'companion_reply') throw new Error('upstream failure');
            return mock.respond(body, signal);
          },
        });
        const play = await runPlay(ctx, pilotRows(ctx.input.config)[0]!);
        assert.equal(schemas.includes('companion_reply'), false);
        assert.equal(play.status, failedJudgment ? 'incomplete' : 'uncleared');
        assert.equal(play.turns.length, failedJudgment ? 0 : 1);
        assert.equal(
          (await ctx.store.readCalls()).some((c) => c.status !== 'completed'),
          failedJudgment,
        );
        assert.equal((play.stateVersions.at(-1) as any).gameVersion, failedJudgment ? 0 : 1);
        if (!failedJudgment) {
          const reply = (play.turns[0] as { publicReply: string }).publicReply;
          assert.ok(reply.trim());
          assert.doesNotMatch(reply, /action_result|notificationId|shortReason/);
        }
      }, 1),
  );

test('abort before the first call checkpoints incomplete without charging or continuing', async () =>
  fixture(async (ctx) => {
    const controller = new AbortController();
    controller.abort();
    ctx.signal = controller.signal;
    await pilot(ctx);
    const plays = await ctx.store.readPlays();
    assert.equal(plays.length, 1);
    assert.equal(plays[0]!.status, 'incomplete');
    assert.equal(plays[0]!.callIds.length, 0);
    assert.equal(ctx.budget.calls.length, 0);
  }));
