import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadExpansionConfig } from '../tools/auto-mission/expansion/config.js';
import {
  mockExpansionProposal,
  candidateFromProposal,
} from '../tools/auto-mission/expansion/generator.js';
import { ExpansionStore, artifactDigest } from '../tools/auto-mission/expansion/store.js';
import { EXPANSION_PRICING } from '../tools/auto-mission/expansion/usage.js';
import {
  renderExpansionReport,
  renderSavedExpansion,
  escapeHtml,
} from '../tools/auto-mission/expansion/report.js';
import { adoptExpansion } from '../tools/auto-mission/expansion/adopt.js';
import type { EvaluationManifest } from '../tools/auto-mission/expansion/store-schema.js';
async function fixture(mode: 'mock' | 'live' = 'mock') {
  const input = await loadExpansionConfig('config/auto-mission/expand-default.json');
  const candidate = candidateFromProposal(input.source, mockExpansionProposal(input.source));
  const manifest: EvaluationManifest = {
    schemaVersion: 1,
    kind: 'mission-expansion',
    runId: randomUUID(),
    mode,
    parentRunId: null,
    conditions: {
      sourceDigest: input.source.sourceDigest,
      candidateDigest: artifactDigest(candidate),
      revision: 1,
      codeRevision: 'fixture',
      dirtyDigest: 'b'.repeat(64),
      configDigest: input.configDigest,
      promptDigests: input.promptDigests,
      catalogDigest: input.catalogDigest,
      locale: 'ja',
      rules: input.source.compiledOriginal.rules,
      initiative: 'observations',
      selectedModels: { generator: 'gpt-6-astra' },
    },
    pricingSnapshot: EXPANSION_PRICING,
    stage: 'pilot_reported',
    budgets: {
      maxCostUsd: mode === 'live' ? 10 : null,
      maxCalls: 650,
      maxOutputTokens: 350000,
      deadlineMs: 4500000,
    },
    playMatrix: input.config.playerModels.flatMap((model, m) =>
      input.config.personas.map((persona, p) => ({
        playId: 'play-' + m + '-' + p,
        model,
        persona,
      })),
    ),
    plays: [],
    callIds: [],
  };
  return { source: input.source, candidate, manifest, plays: [], calls: [], evaluation: null };
}
test('report includes exact source, complete expanded chapters and every original solution', async () => {
  const data = await fixture();
  data.candidate.expandedStory.push({
    id: 'last-chapter',
    title: { ja: '最後', en: 'Last' },
    body: { ja: 'LAST CHAPTER COMPLETE', en: 'THE END' },
  });
  const html = renderExpansionReport(data);
  assert.ok(html.includes(escapeHtml(data.source.rawCatalogText)));
  assert.match(html, /LAST CHAPTER COMPLETE/);
  for (const gimmick of data.source.originalSections.gimmicks)
    for (const solution of gimmick.referenceSolutions as { use: { ja: string } }[])
      assert.ok(html.includes(escapeHtml(solution.use.ja)));
  assert.match(html, /全9プレイは未完了/);
  assert.match(html, /mockは輸送/);
  assert.match(html, /@media\s*\(max-width:\s*760px\)/);
});
test('source and candidate text remain inert HTML without external scripts or resources', async () => {
  const data = await fixture();
  data.candidate.expandedStory[0]!.body.ja =
    '<script>alert("x")</script><img src="https://invalid.example/secret">';
  const html = renderExpansionReport(data);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script|<img|<iframe|<link[^>]+href=/i);
});
test('saved report renders offline without mutating candidate or stage, and draft renders without a candidate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expansion-report-'));
  try {
    const data = await fixture(),
      store = await ExpansionStore.create(root, data.manifest, data.source, data.candidate);
    const path = join(store.directory, 'manifest.json'),
      before = await readFile(path, 'utf8');
    await renderSavedExpansion(path);
    assert.equal(await readFile(path, 'utf8'), before);
    assert.match(await readFile(join(store.directory, 'report.html'), 'utf8'), /物語全文/);
    const draftManifest = { ...data.manifest, runId: randomUUID(), stage: 'frozen' as const };
    const draft = await ExpansionStore.createDraft(root, draftManifest, data.source);
    await renderSavedExpansion(join(draft.directory, 'draft.json'));
    assert.match(await readFile(join(draft.directory, 'report.html'), 'utf8'), /revision 未確定/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('adoption rejects mock, incomplete and revision mismatch before creating any output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'expansion-adopt-'));
  try {
    for (const mode of ['mock', 'live'] as const) {
      const data = await fixture(mode);
      const store = await ExpansionStore.create(root, data.manifest, data.source, data.candidate);
      const path = join(store.directory, 'manifest.json'),
        out = join(root, 'output');
      await assert.rejects(adoptExpansion(path, 1, out), /LIVE_EVALUATION_REQUIRED/);
      await store.setStage('ready_for_adoption');
      await assert.rejects(
        adoptExpansion(path, 2, out),
        mode === 'mock' ? /LIVE_EVALUATION_REQUIRED/ : /REVISION_MISMATCH/,
      );
      await assert.rejects(
        adoptExpansion(path, 1, out),
        mode === 'mock' ? /LIVE_EVALUATION_REQUIRED/ : /NINE_COMPLETED/,
      );
      await assert.rejects(access(out));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('synthetic complete evaluation gates adoption, rejects forged coverage, and never overwrites an existing file', async () => {
  // This is a local validation fixture, not a real live evaluation or adoption.
  const { ExpansionBudget, EXPANSION_LIMITS } = await import(
    '../tools/auto-mission/expansion/budget.js'
  );
  const { evaluateCandidate, createMockEvaluationClient, loadEvaluationPrompts } = await import(
    '../tools/auto-mission/expansion/evaluate.js'
  );
  const { conditionsDigest } = await import('../tools/auto-mission/expansion/store.js');
  const { mkdir, unlink } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'expansion-adopt-complete-'));
  try {
    const data = await fixture('live'),
      store = await ExpansionStore.create(root, data.manifest, data.source, data.candidate);
    const plays = data.manifest.playMatrix.map((row) => ({
      ...row,
      attemptId: randomUUID(),
      candidateDigest: artifactDigest(data.candidate),
      revision: 1,
      conditionsDigest: conditionsDigest(data.manifest.conditions),
      status: 'cleared' as const,
      terminationReason: 'fixture_clear',
      turns: [
        {
          index: 1,
          playerRequest: { kind: 'ask', text: 'Look around.' },
          publicReply: 'Fixture only.',
        },
      ],
      disclosureTrace: [],
      ambienceTrace: [],
      stateVersions: [],
      callIds: [],
    }));
    for (const play of plays) await store.checkpointPlay(play);
    const evaluation = await evaluateCandidate({
      source: data.source,
      candidate: data.candidate,
      conditions: data.manifest.conditions,
      plays,
      client: createMockEvaluationClient(),
      budget: new ExpansionBudget({
        mode: 'mock',
        pricing: EXPANSION_PRICING,
        limits: EXPANSION_LIMITS.remaining,
      }),
      prompts: loadEvaluationPrompts(),
    });
    assert.equal(evaluation.status, 'complete');
    await store.saveEvaluation(evaluation);
    await store.setStage('ready_for_adoption');
    const path = join(store.directory, 'manifest.json'),
      out = join(root, 'output');
    const forged = structuredClone(evaluation);
    forged.reviews[0]!.segments[0]!.turnRefs = [];
    await store.saveEvaluation(forged);
    await assert.rejects(adoptExpansion(path, 1, out), /REVIEW_COVERAGE_MISSING/);
    await assert.rejects(access(out));
    await store.saveEvaluation(evaluation);
    await mkdir(out);
    const target = join(out, data.candidate.candidateId + '-r1.json');
    await writeFile(target, 'existing user content', { flag: 'wx' });
    await assert.rejects(adoptExpansion(path, 1, out), /EEXIST/);
    assert.equal(await readFile(target, 'utf8'), 'existing user content');
    await unlink(target);
    await adoptExpansion(path, 1, out);
    const adopted = JSON.parse(await readFile(target, 'utf8'));
    assert.equal(adopted.investigation.sourceRef.revision, 1);
    const adoption = JSON.parse(
      await readFile(join(out, data.candidate.candidateId + '-r1.adoption.json'), 'utf8'),
    );
    assert.equal(adoption.evaluationDigest, artifactDigest(evaluation));
    assert.equal((await ExpansionStore.readOnly(path)).manifest.stage, 'adopted');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
