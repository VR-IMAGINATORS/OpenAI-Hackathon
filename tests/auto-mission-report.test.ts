import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, digestValue } from '../tools/auto-mission/config.js';
import { renderReport, escapeHtml } from '../tools/auto-mission/report.js';
import { RunStore, readRun } from '../tools/auto-mission/store.js';
import { runRecordSchema, type RunRecord } from '../tools/auto-mission/schemas.js';
async function record(): Promise<RunRecord> {
  const inputSnapshot = await loadConfig('config/auto-mission/default.json');
  const fixture = JSON.parse(readFileSync('tests/fixtures/auto-mission/valid.json', 'utf8'));
  return runRecordSchema.parse({
    runId: randomUUID(),
    parentRunId: null,
    mode: 'mock',
    status: 'failed',
    phase: 'finished',
    failureCode: 'STORY_REJECTED',
    failureReason: '成立性を確認できませんでした',
    inputSnapshot,
    contract: fixture.contract,
    contractDigest: digestValue(fixture.contract),
    contractCheck: { verdict: 'pass', summary: '固定条件確認', findings: [] },
    revisions: [
      {
        candidate: fixture.candidate,
        digest: digestValue(fixture.candidate),
        mechanical: null,
        reviews: [],
        verification: null,
        verdict: null,
      },
    ],
    calls: [],
    timings: [],
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 1234,
  });
}
test('mission HTML escapes model text and makes failed mock draft explicit', async () => {
  const run = await record();
  const attack = '<script>alert("x")</script><img src="https://evil.example" onerror="alert(1)">';
  run.revisions[0].candidate.title = attack;
  run.revisions[0].candidate.opening = attack;
  run.inputSnapshot.references = [{ path: 'reference.md', content: attack }];
  run.failureReason = attack;
  const html = renderReport(run);
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('<img '), false);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('生成できませんでした'));
  assert.ok(html.includes('MOCK · 模擬実行'));
  assert.ok(html.includes('最終案'));
  assert.ok(html.includes('Content-Security-Policy'));
  assert.equal(/<script\b/i.test(html), false);
});
test('mission HTML marks missing draft and unknown token usage without fictitious zero success', async () => {
  const run = await record();
  run.revisions = [];
  run.failureCode = 'API_TIMEOUT';
  run.calls = [
    {
      role: 'storyGenerator',
      model: 'gpt-6-astra',
      requestedModel: 'gpt-6-astra',
      responseModel: null,
      reasoningEffort: 'high',
      status: 'aborted',
      usage: null,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      durationMs: 30,
      reservedOutputTokens: 12000,
      error: 'API_TIMEOUT',
    },
  ];
  run.timings = [
    {
      phase: 'api',
      revision: 0,
      role: 'storyGenerator',
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      durationMs: 30,
      status: 'aborted',
      reason: 'API_TIMEOUT',
    },
  ];
  const html = renderReport(run);
  assert.ok(html.includes('固定条件案（ストーリー本文の生成前）'));
  assert.ok(html.includes(escapeHtml(run.contract!.initialState.description)));
  run.contract = null;
  assert.ok(renderReport(run).includes('固定条件案もまだ取得できていません'));
  assert.ok(html.includes('使用量不明1件'));
  assert.ok(html.includes('API_TIMEOUT'));
  assert.ok(html.includes('aborted'));
});
test('mission store roundtrips checkpoints in separate unique directories and offline HTML', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mission-store-'));
  try {
    const first = await RunStore.create(root);
    const second = await RunStore.create(root);
    assert.notEqual(first.directory, second.directory);
    const one = await record();
    const two = await record();
    await first.save(one);
    await second.save(two);
    assert.deepEqual(await readRun(path.join(first.directory, 'run.json')), one);
    one.failureCode = 'API_TIMEOUT';
    await first.save(one);
    assert.equal(
      (await readRun(path.join(first.directory, 'run.json'))).failureCode,
      'API_TIMEOUT',
    );
    assert.deepEqual(await readRun(path.join(second.directory, 'run.json')), two);
    const html = renderReport(one);
    await first.report(html);
    assert.equal(await readFile(path.join(first.directory, 'report.html'), 'utf8'), html);
  } finally {
    const base = path.resolve(tmpdir());
    const target = path.resolve(root);
    assert.ok(
      target.startsWith(base + path.sep) && path.basename(target).startsWith('mission-store-'),
    );
    await rm(target, { recursive: true, force: true });
  }
});
