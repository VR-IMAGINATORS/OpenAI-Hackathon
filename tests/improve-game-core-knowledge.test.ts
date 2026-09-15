import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { GameHarness } from '../apps/local-server/game-harness.js';
import { GameSession } from '../apps/local-server/game.js';
import { KnowledgeStore, buildCompanionContext } from '../apps/local-server/companion-knowledge.js';
import { ScenarioCatalog } from '../apps/server/scenario-catalog.js';
import { parseCoreConfig, type CompanionInitiative } from '../packages/shared/core-config.js';
import { localizeScenario } from '../packages/shared/scenario.js';
import { knowledgeStateSchema } from '../packages/shared/harness.js';
import { storyOpeningBriefing } from '../apps/local-server/story.js';
import { liveInstructions } from '../apps/local-server/live.js';

const local = (text: string) => ({ ja: text, en: text });
const response = (value: unknown) => ({
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function fixture(
  options: {
    initiative?: CompanionInitiative;
    selection?: {
      scope: 'overview' | 'detail' | 'hint' | 'other';
      ids: string[];
      ambienceSlotIds: string[];
    };
    onCall?: (schema: string, data: any) => void | Promise<void>;
    inference?: boolean;
  } = {},
) {
  const snapshot = structuredClone(
    new ScenarioCatalog({
      scenarioPath: 'scenarios/mobile-playtest.json',
      coreConfigPath: 'config/game-core.json',
    }).current('ja'),
  );
  snapshot.coreConfig.companionInitiative = options.initiative ?? 'observations';
  const obstacle = snapshot.scenarioV2.obstacles[0]!;
  snapshot.scenarioV2.story = {
    aiName: local('Mei'),
    world: local('Public world'),
    mystery: local('PRIVATE_MYSTERY'),
    openingClue: local('OLD_DETAIL_CANARY'),
    phases: {
      opening: local('PRIVATE_PHASE'),
      middle: local('PRIVATE_PHASE'),
      final: local('PRIVATE_PHASE'),
    },
  };
  obstacle.hints = [local('STAGED_HINT_CANARY')];
  snapshot.scenarioV2.knowledge.push(
    {
      id: 'known-anchor',
      kind: 'known',
      localizedText: local('PUBLIC_ANCHOR'),
      revealMode: 'automatic',
      prerequisites: [],
      requestCue: local('initial premise'),
    },
    {
      id: 'target-overview',
      kind: 'observable',
      localizedText: local('OVERVIEW_CANARY'),
      revealMode: 'on_request',
      prerequisites: [],
      requestCue: local('surroundings and current visible target'),
    },
    {
      id: 'target-detail',
      kind: 'observable',
      localizedText: local('DETAIL_CANARY'),
      revealMode: 'on_request',
      prerequisites: [],
      requestCue: local('closer look at the knot'),
    },
    {
      id: 'arbitrary-signal',
      kind: 'hidden',
      localizedText: local('STAGED_HINT_CANARY'),
      revealMode: 'on_request',
      prerequisites: [],
      requestCue: local('explicit hint'),
    },
  );
  snapshot.scenarioV2.investigation = {
    initialOverview: local('INITIAL_OVERVIEW_CANARY'),
    knowledgeMetadata: [
      { knowledgeId: 'target-overview', targetId: obstacle.id, layer: 'overview' },
      { knowledgeId: 'target-detail', targetId: obstacle.id, layer: 'detail' },
      { knowledgeId: 'arbitrary-signal', targetId: obstacle.id, layer: 'hint' },
    ],
    ambienceSlots: [
      {
        id: 'cosmetic-shade',
        targetId: obstacle.id,
        attribute: 'cosmetic-shade',
        allowedValues: [local('beige'), local('gray')],
        nonGameplayRationale: local('The cosmetic finish does not affect any puzzle.'),
      },
    ],
    publicVisuals: [],
    sourceRef: { sourceDigest: 'a'.repeat(64), candidateId: 'test', revision: 1 },
  };
  const game = new GameSession(
    localizeScenario(snapshot.scenarioV2, 'ja'),
    {
      recognize: async () => ({ items: [], summary: '', usage: '' }),
      judge: async () => {
        throw new Error('Investigation must not judge');
      },
    },
    () => 0,
    () => {},
    snapshot,
  );
  game.heartbeat('connected');
  game.start();
  const calls: { schema: string; data: any; instructions: string; wire: any }[] = [];
  const harness = new GameHarness({
    game,
    snapshot,
    model: 'fixture',
    now: () => 0,
    client: {
      respond: async (raw) => {
        const body = raw as any,
          schema = body.text.format.name,
          data = JSON.parse(body.input[0].content[0].text);
        calls.push({
          schema,
          data,
          instructions: body.instructions,
          wire: body.text.format.schema,
        });
        await options.onCall?.(schema, data);
        if (schema === 'core_intent')
          return response({
            decision: {
              kind: 'consult',
              evidenceSeq: data.conversation.eligibleEvidenceSeq,
              reason: 'PRIVATE_REASON',
              answer: 'Initial public answer',
            },
          });
        if (schema === 'knowledge_selection')
          return response(
            options.selection ?? { scope: 'detail', ids: ['target-detail'], ambienceSlotIds: [] },
          );
        if (schema === 'investigation_reply')
          return response({
            answer: [
              data.scope === 'overview' ? data.publicContext.initialOverview : '',
              data.stagedHint?.hint ?? '',
              ...data.publicContext.knownFacts.map((entry: any) => entry.text),
              ...data.publicContext.ambience.map((entry: any) => entry.value),
            ]
              .filter(Boolean)
              .join(' ')
              .slice(0, 2000),
            inferences: options.inference
              ? [
                  {
                    id: 'tentative-guess',
                    text: 'A possibility',
                    supportingKnownIds: ['known-anchor'],
                    status: 'tentative',
                  },
                ]
              : [],
          });
        throw new Error('Unexpected schema');
      },
    },
  });
  let seq = 0;
  const say = (text: string) => {
    seq++;
    harness.ledger.append({
      eventId: randomUUID(),
      generation: game.generation,
      speaker: 'user',
      delta: text,
      startMs: seq * 1000,
      endMs: seq * 1000 + 1,
    });
    harness.sync();
    return harness.ledger.captureUnconsumedContext();
  };
  return { snapshot, game, harness, calls, say };
}

test('a concrete paraphrased question directly reveals its detail in one finite consultation', async () => {
  const f = fixture();
  const result = await f.harness.handleRequest(f.say('結び目をもっと近くで見てみて'));
  assert.deepEqual(
    f.calls.map((call) => call.schema),
    ['core_intent', 'knowledge_selection', 'investigation_reply'],
  );
  assert.match(result.publicReply, /DETAIL_CANARY/);
  assert.doesNotMatch(result.publicReply, /OVERVIEW_CANARY|STAGED_HINT_CANARY|PRIVATE/);
  assert.deepEqual(result.committedPublicEvents, []);
  assert.equal(f.game.actionsUsed, 0);
  assert.equal(f.game.credits.remaining, 980);
  const selected = f.calls.find((call) => call.schema === 'knowledge_selection')!;
  assert.doesNotMatch(
    JSON.stringify(selected.data),
    /DETAIL_CANARY|OVERVIEW_CANARY|STAGED_HINT_CANARY|PRIVATE_MYSTERY/,
  );
  assert(
    selected.data.candidates.some(
      (entry: any) => entry.id === 'target-detail' && entry.layer === 'detail',
    ),
  );
  assert.deepEqual(selected.wire.required.sort(), ['scope', 'ids', 'ambienceSlotIds'].sort());
  assert.deepEqual(f.calls.at(-1)!.wire.required.sort(), ['answer', 'inferences'].sort());
});

test('a broad investigation lists overview without disclosing a detail selected by mistake', async () => {
  const f = fixture({
    selection: {
      scope: 'overview',
      ids: ['target-overview', 'target-detail'],
      ambienceSlotIds: ['cosmetic-shade'],
    },
  });
  const result = await f.harness.handleRequest(f.say('周りの様子をざっと見回して'));
  assert.match(result.publicReply, /INITIAL_OVERVIEW_CANARY/);
  assert.match(result.publicReply, /OVERVIEW_CANARY/);
  assert.doesNotMatch(result.publicReply, /DETAIL_CANARY|STAGED_HINT_CANARY/);
  assert(!f.harness.knowledge!.snapshot().revealedIds.includes('target-detail'));
  assert.deepEqual(f.harness.knowledge!.snapshot().ambience, []);
});

test('explicit staged hint uses declared metadata despite an arbitrary knowledge ID; denied hint never does', async () => {
  const explicit = fixture();
  const result = await explicit.harness.handleRequest(explicit.say('ヒントを教えて'));
  assert.match(result.publicReply, /STAGED_HINT_CANARY/);
  assert.deepEqual(
    explicit.calls.map((call) => call.schema),
    ['core_intent', 'investigation_reply'],
  );
  assert(!JSON.stringify(explicit.calls[0].data).includes('STAGED_HINT_CANARY'));
  const denied = fixture({ selection: { scope: 'hint', ids: [], ambienceSlotIds: [] } });
  const safe = await denied.harness.handleRequest(
    denied.say('ヒントはいらない。結び目の様子だけ教えて'),
  );
  assert.doesNotMatch(safe.publicReply, /STAGED_HINT_CANARY/);
  assert(!denied.harness.knowledge!.snapshot().revealedIds.includes('arbitrary-signal'));
});

for (const initiative of ['observations', 'hypotheses', 'suggestions'] as const)
  test(
    'initiative policy stays explicit and inferences remain separate: ' + initiative,
    async () => {
      const f = fixture({ initiative, inference: true });
      await f.harness.handleRequest(f.say('結び目を見て'));
      assert(f.calls.at(-1)!.instructions.includes('Initiative: ' + initiative));
      const state = f.harness.knowledge!.snapshot();
      assert.equal(state.inferences.length, initiative === 'observations' ? 0 : 1);
      assert(!state.revealedIds.includes('tentative-guess'));
      if (state.inferences.length) assert.equal(state.inferences[0].status, 'tentative');
    },
  );

test('cosmetic completion is allowlisted, fixed within a play, and absent from another play', async () => {
  const f = fixture({
    selection: { scope: 'detail', ids: [], ambienceSlotIds: ['cosmetic-shade'] },
  });
  await f.harness.handleRequest(f.say('見えている仕上げの色は？'));
  const first = f.harness.knowledge!.snapshot().ambience[0];
  assert.ok(first);
  assert(['beige', 'gray'].includes(first.value));
  await f.harness.handleRequest(f.say('さっきの色をもう一度教えて'));
  assert.deepEqual(f.harness.knowledge!.snapshot().ambience, [first]);
  assert(!f.harness.knowledge!.knownFacts().some((entry) => entry.text === first.value));
  const next = fixture();
  assert.deepEqual(next.harness.knowledge!.snapshot().ambience, []);
  const store = f.harness.knowledge!;
  const version = store.snapshot().version;
  assert.equal(store.addAmbience('undeclared-key', 0, version, 'request'), false);
  assert.equal(store.addAmbience('cosmetic-shade', 100, version, 'request'), false);
  const other = first.value === 'beige' ? 1 : 0;
  assert.equal(store.addAmbience('cosmetic-shade', other, version, 'request'), false);
  const context = buildCompanionContext(f.snapshot, store, f.game.state());
  assert.doesNotMatch(JSON.stringify(context), /nonGameplayRationale|PRIVATE_MYSTERY/);
  assert.match(
    liveInstructions(f.game.state(), f.snapshot, f.game.facts, context, store.prompts),
    /Only state fixed ambience/,
  );
});

test('cosmetic store enforces thirty slots and legacy knowledge state receives an empty default', () => {
  const f = fixture();
  f.snapshot.scenarioV2.investigation!.ambienceSlots = Array.from({ length: 31 }, (_, i) => ({
    id: 'slot-' + i,
    targetId: f.game.facts.obstacleId,
    attribute: 'shade-' + i,
    allowedValues: [local('gray')],
    nonGameplayRationale: local('cosmetic only'),
  }));
  const store = new KnowledgeStore(f.snapshot);
  for (let i = 0; i < 30; i++)
    assert.equal(store.addAmbience('slot-' + i, 0, store.snapshot().version, 'request'), true);
  assert.equal(store.addAmbience('slot-30', 0, store.snapshot().version, 'request'), false);
  assert.equal(store.snapshot().ambience.length, 30);
  assert.deepEqual(
    knowledgeStateSchema.parse({ version: 0, revealedIds: [], reveals: [], inferences: [] })
      .ambience,
    [],
  );
});

for (const mutation of ['game', 'knowledge', 'conversation', 'epoch', 'abort'] as const)
  test(
    'stale ' + mutation + ' during the final reply cannot commit disclosure, ambience or credits',
    async () => {
      const ready = deferred<void>(),
        gate = deferred<void>();
      const f = fixture({
        selection: { scope: 'detail', ids: ['target-detail'], ambienceSlotIds: ['cosmetic-shade'] },
        onCall: async (schema) => {
          if (schema === 'investigation_reply') {
            ready.resolve();
            await gate.promise;
          }
        },
      });
      const controller = new AbortController();
      const running = f.harness.handleRequest(
        f.say('結び目と仕上げの色を調べて'),
        controller.signal,
      );
      await ready.promise;
      assert(!f.harness.knowledge!.snapshot().revealedIds.includes('target-detail'));
      if (mutation === 'game') f.game.gameVersion++;
      if (mutation === 'knowledge')
        f.harness.knowledge!.addInference(
          {
            id: 'another-update',
            text: 'Possible',
            supportingKnownIds: ['known-anchor'],
            status: 'tentative',
            updatedAtVersion: 0,
          },
          f.harness.knowledge!.snapshot().version,
        );
      if (mutation === 'conversation') f.say('やっぱりやめて');
      if (mutation === 'epoch') {
        f.game.changeController();
        f.harness.sync();
      }
      if (mutation === 'abort') controller.abort();
      gate.resolve();
      await assert.rejects(running, /ACTION_INVALID|INVESTIGATION_STALE|abort/i);
      assert(!f.harness.knowledge!.snapshot().revealedIds.includes('target-detail'));
      assert.deepEqual(f.harness.knowledge!.snapshot().ambience, []);
      assert.equal(f.game.credits.remaining, 1000);
    },
  );

test('initial briefing uses the approved overview and investigation invitation without hidden detail', () => {
  const f = fixture();
  const text = storyOpeningBriefing(f.snapshot);
  assert.match(text, /INITIAL_OVERVIEW_CANARY/);
  assert.match(text, /調べる/);
  assert.doesNotMatch(text, /OLD_DETAIL_CANARY|DETAIL_CANARY|STAGED_HINT_CANARY|PRIVATE/);
  const raw = { ...f.snapshot.coreConfig } as any;
  delete raw.companionInitiative;
  assert.equal(parseCoreConfig(raw).companionInitiative, 'observations');
  assert.throws(() => parseCoreConfig({ ...raw, companionInitiative: 'invent-anything' }));
});

test('failed answer discards staged disclosures and a model cannot select an undeclared cosmetic attribute', async () => {
  const outage = fixture({
    onCall: (schema) => {
      if (schema === 'investigation_reply') throw new Error('UPSTREAM_FAILED');
    },
  });
  await assert.rejects(
    outage.harness.handleRequest(outage.say('結び目を調べて')),
    /UPSTREAM_FAILED/,
  );
  assert(!outage.harness.knowledge!.snapshot().revealedIds.includes('target-detail'));
  assert.equal(outage.game.credits.remaining, 1000);
  const unknown = fixture({
    selection: { scope: 'detail', ids: [], ambienceSlotIds: ['undeclared-key-material'] },
  });
  await assert.rejects(
    unknown.harness.handleRequest(unknown.say('鍵の材質を教えて')),
    /INVESTIGATION_SELECTION_INVALID/,
  );
  assert.deepEqual(unknown.harness.knowledge!.snapshot().ambience, []);
  assert.equal(unknown.game.credits.remaining, 1000);
});

test('declared source hints cannot be reclassified as ordinary detail by expansion metadata', () => {
  const f = fixture();
  f.snapshot.scenarioV2.investigation!.knowledgeMetadata.find(
    (entry) => entry.knowledgeId === 'arbitrary-signal',
  )!.layer = 'detail';
  assert.equal(
    f.harness
      .knowledge!.eligibleRevealCandidates()
      .candidates.find((entry) => entry.id === 'arbitrary-signal')!.layer,
    'hint',
  );
});
