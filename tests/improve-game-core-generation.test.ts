import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  loadExpansionConfig,
  expansionConfigSchema,
} from '../tools/auto-mission/expansion/config.js';
import {
  generateCandidate,
  mockGeneratorClient,
  mockExpansionProposal,
  GeneratorValidationError,
} from '../tools/auto-mission/expansion/generator.js';
import { expansionMain, parseExpansionArgs } from '../tools/auto-mission/expansion/cli.js';
import { ExpansionStore, conditionsDigest } from '../tools/auto-mission/expansion/store.js';
import { ExpansionBudget, EXPANSION_LIMITS } from '../tools/auto-mission/expansion/budget.js';
import { EXPANSION_PRICING } from '../tools/auto-mission/expansion/usage.js';
import type { EvaluationManifest } from '../tools/auto-mission/expansion/store-schema.js';
import { validatePreservation } from '../tools/auto-mission/expansion/source.js';
const input = await loadExpansionConfig('config/auto-mission/expand-default.json');
const args = ['expand', '--config', 'config/auto-mission/expand-default.json', '--mock'];
const identity = async () => ({ codeRevision: 'unit-test', dirtyDigest: 'f'.repeat(64) });
async function temporary(work: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'expansion-generation-test-'));
  try {
    await work(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test('fixed warehouse candidate and common thirteen objects carry only ordinary properties', () => {
  assert.equal(input.source.selection.sceneId, 'scene-echo-platform');
  assert.equal(input.source.selection.candidateIndex, 0);
  assert.equal(input.config.objectCatalog.length, 13);
  assert.deepEqual(
    input.config.objectCatalog.slice(-5).map((i) => i.id),
    ['grabber', 'flat-screwdriver', 'coin', 'toothbrush', 'clothespin'],
  );
  assert.ok(
    input.config.objectCatalog.every(
      (item) => Object.keys(item).sort().join(',') === 'id,name,ordinaryProperties',
    ),
  );
  const lower = structuredClone(input.config) as any;
  lower.generator.model = 'gpt-5.6-luna';
  assert.equal(expansionConfigSchema.safeParse(lower).success, false);
});
test('Astra structured fixture compiles with preserved rules and original mechanisms within request limit', async () => {
  const mock = mockGeneratorClient(input.source);
  let bytes = 0;
  const result = await generateCandidate(input, {
    respond: async (body) => {
      bytes = Buffer.byteLength(JSON.stringify(body));
      assert.equal((body as any).model, 'gpt-6-astra');
      assert.ok(JSON.parse((body as any).input[0].content[0].text).referenceSolutions.length);
      return mock.respond(body);
    },
  });
  assert.ok(bytes <= 65536);
  validatePreservation(input.source, result.compiled);
  assert.equal(result.candidate.revision, 1);
  assert.equal(
    result.compiled.investigation?.knowledgeMetadata.some((m) => m.layer === 'detail'),
    true,
  );
});
test('malformed proposals and changes outside presentation allowlist are rejected without downgrade', async () => {
  for (const mutate of [
    (p: any) => p.displayOverrides.push({ path: '/rules', value: { ja: 'change', en: 'change' } }),
    (p: any) => (p.openingOverview.ja = 'x'.repeat(2001)),
    (p: any) => (p.knowledgeMetadata[0].targetId = 'missing'),
    (p: any) => (p.unknown = 'forbidden'),
  ]) {
    const proposal = mockExpansionProposal(input.source);
    mutate(proposal);
    let calls = 0;
    await assert.rejects(
      () =>
        generateCandidate(input, {
          respond: async (body) => {
            calls++;
            assert.equal((body as any).model, 'gpt-6-astra');
            return {
              status: 'completed',
              output: [
                {
                  type: 'message',
                  content: [{ type: 'output_text', text: JSON.stringify(proposal) }],
                },
              ],
            };
          },
        }),
      GeneratorValidationError,
    );
    assert.equal(calls, 1);
  }
});
test('strict CLI rejects unknown duplicate and conflicting modes, missing limits, invalid revisions before I/O', async () => {
  const invalid = [
    ['expand', '--config', 'x', '--live'],
    ['expand', '--config', 'x', '--mock', '--live'],
    ['expand', '--config', 'x', '--mock', '--config', 'y'],
    ['expand', '--config', 'x', '--mock', '--wat'],
    ['expand', '--config', 'x', '--live', '--max-cost-usd', 'NaN'],
    ['expand', '--config', 'x', '--live', '--max-cost-usd', '-1'],
    ['expand-adopt', '--input', 'x', '--revision', '1.5'],
    ['expand-render', '--input', 'x', '--mock'],
    ['expand-retry', '--input', 'x', '--mock'],
    ['expand', '--mock'],
  ];
  for (const argv of invalid) {
    assert.throws(() => parseExpansionArgs(argv));
    let io = false;
    assert.equal(
      await expansionMain(argv, {
        codeIdentity: async () => {
          io = true;
          return identity();
        },
        log: () => {},
      }),
      2,
    );
    assert.equal(io, false);
  }
  assert.equal(
    parseExpansionArgs(['expand', '--config', 'x', '--live', '--max-cost-usd', '0.5']).maxCostUsd,
    0.5,
  );
});
test('CLI saves candidate but reports integration pending when no pilot runner is supplied', async () =>
  temporary(async (root) => {
    const logs: string[] = [];
    assert.equal(
      await expansionMain(args, {
        outputRoot: root,
        codeIdentity: identity,
        log: (s) => logs.push(s),
      }),
      2,
    );
    const directory = join(root, (await readdir(root))[0]!);
    const result = await ExpansionStore.readOnly(join(directory, 'manifest.json'));
    assert.equal(result.manifest.stage, 'incomplete');
    assert.equal(result.plays.length, 0);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0]!.status, 'completed');
    assert.ok(logs.some((s) => s.includes('PILOT_INTEGRATION_PENDING')));
  }));
test('pilot injection must produce exactly the diagonal three completed plays before CLI reports pilot stage', async () =>
  temporary(async (root) => {
    const code = await expansionMain(args, {
      outputRoot: root,
      codeIdentity: identity,
      log: () => {},
      pilot: async (context) => {
        for (let i = 0; i < 3; i++)
          await context.store.checkpointPlay({
            playId: 'play-' + i + '-' + i,
            attemptId: randomUUID(),
            candidateDigest: context.store.snapshot.conditions.candidateDigest,
            revision: 1,
            conditionsDigest: conditionsDigest(context.store.snapshot.conditions),
            model: context.input.config.playerModels[i]!,
            persona: context.input.config.personas[i]!,
            status: 'uncleared',
            terminationReason: 'unit_fixture_turn_limit',
            turns: [],
            disclosureTrace: [],
            ambienceTrace: [],
            stateVersions: [],
            callIds: [],
          });
        await context.store.setStage('pilot_reported');
      },
    });
    assert.equal(code, 0);
    const stored = await ExpansionStore.readOnly(
      join(root, (await readdir(root))[0]!, 'manifest.json'),
    );
    assert.equal(stored.plays.length, 3);
    assert.equal(stored.manifest.playMatrix.length, 9);
  }));
test('transport failure retains candidate-less draft and nonzero reservation; no manifest is adopted', async () =>
  temporary(async (root) => {
    assert.equal(
      await expansionMain(args, {
        outputRoot: root,
        codeIdentity: identity,
        log: () => {},
        client: {
          respond: async () => {
            throw new Error('private auth token');
          },
        },
      }),
      2,
    );
    const directory = join(root, (await readdir(root))[0]!);
    const draft = await ExpansionStore.readOnlyDraft(join(directory, 'draft.json'));
    assert.equal(draft.candidate, null);
    assert.equal(draft.draft.stage, 'incomplete');
    assert.equal(draft.calls[0]!.status, 'incomplete');
    assert.ok(draft.calls[0]!.reservedCostUsd > 0);
    assert.equal(draft.calls[0]!.estimatedCostUsd, null);
    assert.equal(JSON.stringify(draft).includes('private auth token'), false);
    await assert.rejects(() => readFile(join(directory, 'manifest.json')));
  }));
test('invalid generation is a rejected draft, not a successful static check or pilot', async () =>
  temporary(async (root) => {
    const mock = mockGeneratorClient(input.source);
    assert.equal(
      await expansionMain(args, {
        outputRoot: root,
        codeIdentity: identity,
        log: () => {},
        client: {
          respond: async (body) => {
            const response = (await mock.respond(body)) as any;
            response.output[0].content[0].text = '{}';
            return response;
          },
        },
      }),
      1,
    );
    const draft = await ExpansionStore.readOnlyDraft(
      join(root, (await readdir(root))[0]!, 'draft.json'),
    );
    assert.equal(draft.draft.stage, 'rejected');
    assert.equal(draft.calls[0]!.status, 'completed');
  }));
function base(): EvaluationManifest {
  return {
    schemaVersion: 1,
    kind: 'mission-expansion',
    runId: randomUUID(),
    mode: 'mock',
    parentRunId: null,
    conditions: {
      sourceDigest: input.source.sourceDigest,
      candidateDigest: '0'.repeat(64),
      revision: 1,
      codeRevision: 'test',
      dirtyDigest: 'a'.repeat(64),
      configDigest: input.configDigest,
      promptDigests: input.promptDigests,
      catalogDigest: input.catalogDigest,
      locale: 'ja',
      rules: input.source.compiledOriginal.rules,
      initiative: 'observations',
      selectedModels: { generator: 'gpt-6-astra' },
    },
    pricingSnapshot: EXPANSION_PRICING,
    stage: 'frozen',
    budgets: { maxCostUsd: null, maxCalls: 650, maxOutputTokens: 350000, deadlineMs: 4500000 },
    playMatrix: [],
    plays: [],
    callIds: [],
  };
}
test('draft cannot finalize while calls run and candidate may be fixed only once', async () =>
  temporary(async (root) => {
    const draft = await ExpansionStore.createDraft(root, base(), input.source);
    const b = new ExpansionBudget({
      mode: 'mock',
      pricing: EXPANSION_PRICING,
      limits: EXPANSION_LIMITS.pilot,
    });
    const call = b.reserve(
      { model: 'gpt-6-astra', max_output_tokens: 100, input: 'test' },
      { revision: 1 },
    );
    await draft.saveCall(call);
    const generated = await generateCandidate(input, mockGeneratorClient(input.source));
    await assert.rejects(() => draft.finalize(generated.candidate), /Unfinished/);
    call.status = 'completed';
    await draft.saveCall(call);
    await draft.finalize(generated.candidate);
    await assert.rejects(() => draft.finalize(generated.candidate), /already fixed/);
    await assert.rejects(() => draft.saveCall(call), /already fixed/);
  }));

test('recovering a crashed draft preserves reservations and requires a fresh generation run', async () =>
  temporary(async (root) => {
    const draft = await ExpansionStore.createDraft(root, base(), input.source);
    const b = new ExpansionBudget({
      mode: 'mock',
      pricing: EXPANSION_PRICING,
      limits: EXPANSION_LIMITS.pilot,
    });
    const call = b.reserve(
      { model: 'gpt-6-astra', max_output_tokens: 100, input: 'pending' },
      { revision: 1 },
    );
    await draft.saveCall(call);
    const recovered = await ExpansionStore.recoverDraft(join(draft.directory, 'draft.json'));
    assert.equal(recovered.draft.stage, 'incomplete');
    assert.equal(recovered.calls[0]!.status, 'incomplete');
    assert.equal(recovered.calls[0]!.reservedCostUsd, call.reservedCostUsd);
    assert.equal(recovered.calls[0]!.estimatedCostUsd, null);
  }));
