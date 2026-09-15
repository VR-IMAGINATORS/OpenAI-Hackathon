import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMockEvaluationClient } from '../tools/auto-mission/expansion/evaluate.js';
import { expansionMain } from '../tools/auto-mission/expansion/cli.js';
import { continueExpansion } from '../tools/auto-mission/expansion/orchestration.js';
import { ExpansionStore, conditionsDigest } from '../tools/auto-mission/expansion/store.js';
import {
  loadExpansionConfig,
  parseSavedExpansionInput,
} from '../tools/auto-mission/expansion/config.js';
const identity = async () => ({ codeRevision: 'test', dirtyDigest: 'a'.repeat(64) });
async function savedPilot(work: (path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'expansion-orchestration-test-'));
  try {
    const exit = await expansionMain(
      ['expand', '--config', 'config/auto-mission/expand-default.json', '--mock'],
      {
        outputRoot: root,
        codeIdentity: identity,
        log: () => {},
        pilot: async (ctx) => {
          for (let i = 0; i < 3; i++)
            await ctx.store.checkpointPlay({
              playId: 'play-' + i + '-' + i,
              attemptId: randomUUID(),
              candidateDigest: ctx.store.snapshot.conditions.candidateDigest,
              revision: 1,
              conditionsDigest: conditionsDigest(ctx.store.snapshot.conditions),
              model: ctx.input.config.playerModels[i]!,
              persona: ctx.input.config.personas[i]!,
              status: 'uncleared',
              terminationReason: 'unit_fixture',
              turns: [{ index: 1, playerRequest: 'inspect', publicReply: 'visible detail' }],
              disclosureTrace: [],
              ambienceTrace: [],
              stateVersions: [],
              callIds: [],
            });
          await ctx.store.setStage('pilot_reported');
        },
      },
    );
    assert.equal(exit, 0);
    await work(join(root, (await readdir(root))[0]!, 'manifest.json'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test('saved prompt bundle retains exact bytes and rejects tampered identity', async () => {
  const input = await loadExpansionConfig('config/auto-mission/expand-default.json');
  assert.deepEqual(parseSavedExpansionInput(JSON.parse(JSON.stringify(input))), input);
  const changed = structuredClone(input);
  changed.generatorPrompt += '\n';
  assert.throws(() => parseSavedExpansionInput(changed));
});
test('continuation rejects changed code, wrong mode, absent retry and unrequested pilot before any calls', async () =>
  savedPilot(async (path) => {
    let calls = 0;
    const logs: string[] = [];
    const deps = {
      codeIdentity: identity,
      client: {
        respond: async () => {
          calls++;
          throw Error('must not call');
        },
      },
      render: async () => {},
      log: (s: string) => logs.push(s),
    };
    const initial = await ExpansionStore.readOnly(path);
    for (const options of [
      { command: 'expand-continue' as const, input: path, mode: 'live' as const, maxCostUsd: 1 },
      { command: 'expand-pilot' as const, input: path, mode: 'mock' as const },
      { command: 'expand-retry' as const, input: path, mode: 'mock' as const, play: 'play-0-0' },
    ])
      assert.equal(await continueExpansion(options, undefined, deps), 2);
    assert.equal(
      await continueExpansion(
        { command: 'expand-continue', input: path, mode: 'mock' },
        undefined,
        {
          ...deps,
          codeIdentity: async () => ({ codeRevision: 'changed', dirtyDigest: 'a'.repeat(64) }),
        },
      ),
      2,
    );
    assert.equal(calls, 0);
    const after = await ExpansionStore.readOnly(path);
    assert.deepEqual(after.manifest, initial.manifest);
    assert.equal(after.executions.length, 0);
    assert.ok(logs.includes('CONTINUATION_CONDITIONS_MISMATCH'));
  }));
test('explicit additional invocation limits are recorded independently without changing original cap', async () =>
  savedPilot(async (path) => {
    const data = await ExpansionStore.readOnly(path);
    const store = await ExpansionStore.resume(path, data.manifest.conditions);
    const id = await store.beginExecution('expand-continue', 3.25);
    await store.finishExecution(id, 'incomplete');
    const saved = await ExpansionStore.readOnly(path);
    assert.equal(saved.executions.length, 1);
    assert.equal(saved.executions[0]!.maxCostUsd, 3.25);
    assert.equal(saved.executions[0]!.status, 'incomplete');
    assert.equal(saved.manifest.budgets.maxCostUsd, data.manifest.budgets.maxCostUsd);
  }));

test('failed pilot evaluation can be explicitly retried while old evaluation and completed plays remain', async () =>
  savedPilot(async (path) => {
    const before = await ExpansionStore.readOnly(path);
    const store = await ExpansionStore.resume(path, before.manifest.conditions);
    await store.saveEvaluation({ status: 'incomplete', failure: 'PREVIOUS_API_FAILURE' });
    await store.setStage('incomplete');
    let gameCalls = 0,
      reviewCalls = 0;
    const result = await continueExpansion(
      { command: 'expand-continue', input: path, mode: 'mock' },
      undefined,
      {
        codeIdentity: identity,
        client: {
          respond: async () => {
            gameCalls++;
            throw Error('no replay');
          },
        },
        evaluationClient: {
          respond: async () => {
            reviewCalls++;
            throw Error('new failure');
          },
        },
        render: async () => {},
        log: () => {},
      },
    );
    assert.equal(result, 2);
    assert.equal(gameCalls, 0);
    assert.ok(reviewCalls > 0);
    const after = await ExpansionStore.readOnly(path);
    assert.deepEqual(after.plays, before.plays);
    assert.equal(after.manifest.stage, 'incomplete');
    assert.equal(after.executions.length, 1);
    assert.ok((await readdir(after.directory)).some((n) => n.startsWith('evaluation-history-')));
  }));
test('nine completed plays resume only final evaluation without replay or deleting old calls', async () =>
  savedPilot(async (path) => {
    let data = await ExpansionStore.readOnly(path);
    const store = await ExpansionStore.resume(path, data.manifest.conditions);
    for (const row of data.manifest.playMatrix) {
      if (data.plays.some((p) => p.playId === row.playId)) continue;
      await store.checkpointPlay({
        ...data.plays[0]!,
        playId: row.playId,
        attemptId: randomUUID(),
        model: row.model,
        persona: row.persona,
        status: 'cleared',
      });
    }
    await store.saveEvaluation({ status: 'incomplete', failure: 'PREVIOUS_API_FAILURE' });
    await store.setStage('incomplete');
    data = await ExpansionStore.readOnly(path);
    let gameCalls = 0;
    const result = await continueExpansion(
      { command: 'expand-continue', input: path, mode: 'mock' },
      undefined,
      {
        codeIdentity: identity,
        client: {
          respond: async () => {
            gameCalls++;
            throw Error('no replay');
          },
        },
        evaluationClient: createMockEvaluationClient(),
        render: async () => {},
        log: () => {},
      },
    );
    assert.equal(result, 0);
    assert.equal(gameCalls, 0);
    const after = await ExpansionStore.readOnly(path);
    assert.equal(after.manifest.stage, 'ready_for_adoption');
    assert.deepEqual(after.plays, data.plays);
    assert.ok(after.calls.length > data.calls.length);
    assert.deepEqual(after.calls.slice(0, data.calls.length), data.calls);
    assert.equal(after.executions[0]!.status, 'completed');
  }));
