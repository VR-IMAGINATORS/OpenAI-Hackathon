import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseCoreConfig } from '../packages/shared/core-config.js';
import { parseStoryCatalog, compileStoryScenario } from '../packages/shared/story-catalog.js';
import { parseScenarioV2, publicScenarioV2 } from '../packages/shared/scenario.js';
import {
  voiceActivitySchema,
  warningPolicySchema,
  actionOriginSchema,
} from '../packages/shared/harness.js';
import { KnowledgeStore, buildCompanionContext } from '../apps/local-server/companion-knowledge.js';
import { storyNarration } from '../apps/local-server/story.js';
import { gimmickGuidance } from '../apps/local-server/gimmick-guidance.js';
import type { ScenarioSnapshot } from '../apps/server/scenario-catalog.js';
import type { PublicGameState } from '../packages/shared/game.js';
const raw = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const snapshot = (): ScenarioSnapshot => ({
  digest: 'test',
  locale: 'ja',
  createdAt: 0,
  scenarioV2: compileStoryScenario(parseStoryCatalog(raw('scenarios/story-catalog.json')), 0),
  coreConfig: parseCoreConfig(raw('config/game-core.json')),
});

test('legacy config normalizes one warning explicitly and new warnings enforce ordering and bounded wait', () => {
  const value = raw('config/game-core.json');
  value.schemaVersion = 1;
  delete value.acceptancePolicy;
  delete value.recovery;
  delete value.warnings;
  const normalized = parseCoreConfig(value);
  assert.equal(normalized.schemaVersion, 2);
  assert.equal(normalized.warnings.milestones.length, 1);
  assert.equal(normalized.warnings.milestones[0]!.kind, 'normal');
  const warnings = raw('config/game-core.json').warnings;
  warnings.milestones.reverse();
  assert.equal(warningPolicySchema.safeParse(warnings).success, false);
  warnings.milestones.reverse();
  warnings.milestones[1].maxWaitMs = 15000;
  assert.equal(warningPolicySchema.safeParse(warnings).success, false);
});
test('all eighteen compositions validate knowledge references and never project hidden entries publicly', () => {
  const source = raw('scenarios/story-catalog.json');
  delete source.schemaVersion;
  for (const scene of source.scenes) delete scene.knowledge;
  const catalog = parseStoryCatalog(source);
  for (let i = 0; i < 18; i++) {
    const scenario = compileStoryScenario(catalog, i);
    assert(scenario.knowledge.some((entry) => entry.kind === 'known'));
    assert(!('knowledge' in publicScenarioV2(scenario)));
    const invalid = structuredClone(scenario);
    invalid.knowledge[0]!.observationTargetId = 'missing';
    assert.throws(() => parseScenarioV2(invalid));
  }
});
test('activity is bounded advisory data and speech requires actual evidence', () => {
  assert.equal(
    voiceActivitySchema.safeParse({
      generation: 1,
      sequence: 1,
      input: 'quiet',
      output: 'unknown',
      playbackReady: false,
    }).success,
    true,
  );
  assert.equal(
    voiceActivitySchema.safeParse({
      generation: 1,
      sequence: 0,
      input: 'quiet',
      output: 'quiet',
      playbackReady: true,
    }).success,
    false,
  );
  assert.equal(
    actionOriginSchema.safeParse({ kind: 'speech', delegationId: 'actual', evidenceSeq: [] })
      .success,
    false,
  );
});
test('reveal candidates hide body, validate state versions and support only grounded tentative inference', () => {
  const source = snapshot();
  const first = source.scenarioV2.obstacles[0]!;
  source.scenarioV2.knowledge.push({
    id: 'secret',
    kind: 'hidden',
    localizedText: { ja: 'SECRET_CANARY', en: 'SECRET_CANARY' },
    requestCue: { ja: '音について調べる', en: 'Investigate the sound' },
    prerequisites: [{ factKey: first.id, value: 'cleared' }],
    revealMode: 'on_request',
  });
  const store = new KnowledgeStore(source);
  const before = store.eligibleRevealCandidates();
  assert(!JSON.stringify(before).includes('SECRET_CANARY'));
  assert.equal(store.applyReveals(['secret'], before.version), false);
  const values = Object.fromEntries(
    source.scenarioV2.core.facts.map((fact) => [fact.key, fact.initial]),
  );
  values[first.id] = 'cleared';
  store.advance({ obstacleId: source.scenarioV2.obstacles[1]!.id, values });
  const candidates = store.eligibleRevealCandidates();
  assert(candidates.candidates.some((entry) => entry.id === 'secret'));
  assert(!JSON.stringify(candidates).includes('SECRET_CANARY'));
  assert.equal(store.applyReveals(['secret'], before.version), false);
  assert.equal(store.applyReveals(['secret'], candidates.version), true);
  assert(store.knownFacts().some((entry) => entry.text === 'SECRET_CANARY'));
  const inference = {
    id: 'guess',
    text: 'Perhaps more than one person',
    supportingKnownIds: ['missing'],
    status: 'tentative',
    updatedAtVersion: 0,
  };
  assert.equal(store.addInference(inference, store.snapshot().version), false);
  inference.supportingKnownIds = ['secret'];
  assert.equal(store.addInference(inference, store.snapshot().version), true);
  assert.equal(
    store.addInference({ ...inference, status: 'confirmed' }, store.snapshot().version),
    false,
  );
});
test('companion projection excludes mystery, directions and untrusted judgment prose', () => {
  const source = snapshot();
  source.scenarioV2.story!.mystery = { ja: 'SECRET_CANARY', en: 'SECRET_CANARY' };
  source.scenarioV2.story!.phases.opening = { ja: 'SECRET_CANARY', en: 'SECRET_CANARY' };
  const state = {
    obstacle: { title: 'goal' },
    situation: 'SECRET_CANARY',
    lastResult: { narrative: 'SECRET_CANARY' },
    inventory: [],
  } as unknown as PublicGameState;
  assert(
    !JSON.stringify(buildCompanionContext(source, new KnowledgeStore(source), state)).includes(
      'SECRET_CANARY',
    ),
  );
  assert(!JSON.stringify(storyNarration(source, 0)).includes('SECRET_CANARY'));
});
import { classifyCoreIntent } from '../apps/local-server/core-intent-ai.js';
import { ConversationLedger } from '../apps/local-server/conversation.js';

test('consult selection sends only eligible cues and rebuilds answer after authorized reveal', async () => {
  const source = snapshot();
  source.coreConfig.companionInitiative = 'hypotheses';
  source.scenarioV2.knowledge.push({
    id: 'sound',
    kind: 'hidden',
    localizedText: { ja: 'REVEALED_SOUND_CANARY', en: 'REVEALED_SOUND_CANARY' },
    requestCue: { ja: '物音を聞く', en: 'Listen to the sound' },
    prerequisites: [],
    revealMode: 'on_request',
  });
  const store = new KnowledgeStore(source);
  const ledger = new ConversationLedger({ generation: 1 });
  ledger.append({
    eventId: 'sound-question',
    generation: 1,
    speaker: 'user',
    delta: '何の音？',
    startMs: 1,
    endMs: 2,
  });
  const state = {
    obstacle: { title: 'goal' },
    inventory: [],
    creditsRemaining: 2,
    remainingMs: 120000,
  } as unknown as PublicGameState;
  const seen: string[] = [];
  const output = (value: unknown) => ({
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }],
  });
  const decision = await classifyCoreIntent({
    snapshot: source,
    knowledge: store,
    gameState: state,
    model: 'fake',
    photos: [],
    game: { status: 'playing', inventory: [] },
    conversation: ledger.captureUnconsumedContext(),
    respond: async (body: any) => {
      const text = body.input[0].content[0].text;
      seen.push(body.text.format.name);
      if (body.text.format.name === 'knowledge_selection') {
        assert(!text.includes('REVEALED_SOUND_CANARY'));
        assert(text.includes('物音を聞く'));
        return output({ ids: ['sound'] });
      }
      if (body.text.format.name === 'investigation_reply') {
        assert(text.includes('REVEALED_SOUND_CANARY'));
        assert(
          !store.snapshot().revealedIds.includes('sound'),
          'disclosure remains draft until answer completes',
        );
        return output({
          answer: '音が聞こえる。',
          inferences: [
            {
              id: 'sound-guess',
              text: '誰かいるかもしれない',
              supportingKnownIds: ['sound'],
              status: 'tentative',
            },
          ],
        });
      }
      const revealed = store.snapshot().revealedIds.includes('sound');
      assert.equal(text.includes('REVEALED_SOUND_CANARY'), revealed);
      return output({
        decision: {
          kind: 'consult',
          evidenceSeq: [1],
          reason: 'question',
          answer: revealed ? '音が聞こえる。' : 'まだ分からない。',
        },
        inferences: revealed
          ? [
              {
                id: 'sound-guess',
                text: '誰かいるかもしれない',
                supportingKnownIds: ['sound'],
                status: 'tentative',
              },
            ]
          : [],
      });
    },
  });
  assert.deepEqual(seen, ['core_intent', 'knowledge_selection', 'investigation_reply']);
  assert.equal(decision.kind, 'consult');
  assert.equal(store.snapshot().inferences[0]!.status, 'tentative');
});

test('greeting classified wait never requests knowledge selection', async () => {
  const source = snapshot();
  const ledger = new ConversationLedger({ generation: 1 });
  ledger.append({
    eventId: 'hello',
    generation: 1,
    speaker: 'user',
    delta: '聞こえてる？',
    startMs: 1,
    endMs: 2,
  });
  let calls = 0;
  await classifyCoreIntent({
    snapshot: source,
    knowledge: new KnowledgeStore(source),
    gameState: { obstacle: { title: 'goal' }, inventory: [] } as unknown as PublicGameState,
    model: 'fake',
    photos: [],
    game: { status: 'playing' },
    conversation: ledger.captureUnconsumedContext(),
    respond: async () => {
      calls++;
      return {
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  decision: { kind: 'wait', reason: 'greeting' },
                  inferences: [],
                }),
              },
            ],
          },
        ],
      };
    },
  });
  assert.equal(calls, 1);
});

test('recognition correction requires eligible speech and an existing photo ID', async () => {
  const source = snapshot();
  const ledger = new ConversationLedger({ generation: 1 });
  ledger.append({
    eventId: 'risk-question',
    generation: 1,
    speaker: 'user',
    delta: 'この道具で試したい',
    startMs: 1,
    endMs: 2,
  });
  const photoId = '11111111-1111-4111-8111-111111111111';
  let corrected: unknown;
  const run = (extra: Record<string, unknown>) =>
    classifyCoreIntent({
      snapshot: source,
      model: 'fake',
      conversation: ledger.captureUnconsumedContext(),
      game: { status: 'playing', inventory: [] },
      photos: [{ id: photoId, jpeg: Buffer.from('fake') }],
      onRecognitionCorrection: (value) => {
        corrected = value;
      },
      respond: async () => ({
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  decision: {
                    kind: 'consult',
                    evidenceSeq: [1],
                    reason: 'request',
                    answer: '確認するね',
                    recognitionCorrection: null,
                    ...extra,
                  },
                  inferences: [],
                }),
              },
            ],
          },
        ],
      }),
    });
  await run({ recognitionCorrection: { photoId, name: 'カッター' } });
  assert.deepEqual(corrected, { photoId, name: 'カッター' });
  await assert.rejects(
    run({
      recognitionCorrection: { photoId: '22222222-2222-4222-8222-222222222222', name: 'カッター' },
    }),
    /Unknown correction photo/,
  );
  await assert.rejects(
    run({ recognitionCorrection: { photoId, name: 'カッター', power: 'magic' } }),
  );
});

test('legacy empty knowledge uses only public scenario observation, never raw judge situation', () => {
  const source = snapshot();
  source.scenarioV2.knowledge = [];
  const state = {
    obstacle: { title: 'goal', index: 0 },
    situation: 'JUDGE_SECRET_CANARY',
    inventory: [],
  } as unknown as PublicGameState;
  const context = buildCompanionContext(source, new KnowledgeStore(source), state);
  assert.equal(context.situation, gimmickGuidance(source, 0)!.text);
  assert(!JSON.stringify(context).includes('JUDGE_SECRET_CANARY'));
});

test('environment intent exposes only the current declared target and parses without tool references', async () => {
  const source = snapshot();
  const ledger = new ConversationLedger({ generation: 1 });
  ledger.append({
    eventId: 'environment-request',
    generation: 1,
    speaker: 'user',
    delta: '目の前の装置を操作して',
    startMs: 1,
    endMs: 2,
  });
  const currentId = source.scenarioV2.obstacles[0]!.id;
  const result = await classifyCoreIntent({
    snapshot: source,
    model: 'fake',
    conversation: ledger.captureUnconsumedContext(),
    photos: [],
    game: { status: 'playing' },
    respond: async (body: any) => {
      const input = JSON.parse(body.input[0].content[0].text);
      assert.deepEqual(
        input.game.environmentTargets.map((target: any) => target.id),
        [currentId],
      );
      return {
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  decision: {
                    kind: 'execute',
                    evidenceSeq: [1],
                    mode: 'environment',
                    environmentTargetIds: [currentId],
                    itemRefs: [],
                    usage: '目の前の装置を操作する',
                    reason: '直接の依頼',
                  },
                  inferences: [],
                }),
              },
            ],
          },
        ],
      };
    },
  });
  assert.equal(result.kind, 'execute');
  if (result.kind === 'execute') assert.equal(result.mode, 'environment');
});
import { liveInstructions, openingCommand } from '../apps/local-server/live.js';

test('initial and reconnect Live payloads exclude hidden scenario and raw judgment prose', () => {
  const source = snapshot();
  const secret = 'UNREVEALED_LIVE_CANARY';
  source.scenarioV2.story!.mystery = { ja: secret, en: secret };
  source.scenarioV2.story!.phases.opening = { ja: secret, en: secret };
  source.scenarioV2.obstacles[0]!.mechanism = { ja: secret, en: secret };
  source.scenarioV2.obstacles[0]!.hints = [
    { ja: '公開された最初のヒント', en: 'Public beginner hint' },
  ];
  source.scenarioV2.obstacles[1]!.hints = [{ ja: secret, en: secret }];
  source.scenarioV2.knowledge.push({
    id: 'never-revealed',
    kind: 'hidden',
    localizedText: { ja: secret, en: secret },
    requestCue: { ja: '調査', en: 'Investigate' },
    prerequisites: [],
    revealMode: 'on_request',
  });
  const baseState = {
    obstacle: { title: 'goal', index: 0, count: 3 },
    title: secret,
    briefing: secret,
    situation: secret,
    lastResult: { narrative: secret },
    inventory: [{ id: 'tool', name: 'scissors', status: 'available', description: secret }],
    remainingMs: 120000,
    creditsRemaining: 2,
  } as unknown as PublicGameState;
  for (const status of ['briefing', 'playing'] as const) {
    const state = { ...baseState, status };
    const store = new KnowledgeStore(source);
    for (const context of [undefined, buildCompanionContext(source, store, state)]) {
      const payload = liveInstructions(state, source, undefined, context);
      assert(!payload.includes(secret), `${status}: secret leaked into instructions`);
      assert(payload.includes('公開された最初のヒント'));
      assert(payload.includes(source.scenarioV2.obstacles[0]!.situationDisplay.ja));
      assert(payload.includes('明示的な「待って」「やめて」「中止」だけ'));
      assert(payload.includes('確定した中止通知が届くまで'));
    }
    assert(!JSON.stringify(openingCommand(state, 'ja', source)).includes(secret));
  }
});
