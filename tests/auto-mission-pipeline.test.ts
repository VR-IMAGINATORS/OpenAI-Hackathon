import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../tools/auto-mission/config.js';
import { runGeneration, evaluateSaved } from '../tools/auto-mission/pipeline.js';
import { ResponsesProvider } from '../tools/auto-mission/provider.js';
import { resolveEvidence } from '../tools/auto-mission/verdict.js';
import { Budget } from '../tools/auto-mission/budget.js';
import {
  type MissionConfig,
  type Role,
  type RunRecord,
  type MissionCandidate,
} from '../tools/auto-mission/schemas.js';
const fixture = JSON.parse(readFileSync('tests/fixtures/auto-mission/valid.json', 'utf8'));
type Input = Record<string, any>;
type Hook = (
  role: Role,
  input: Input,
  fallback: unknown,
  signal: AbortSignal,
) => unknown | Promise<unknown>;
async function setup(hook?: Hook, configure?: (config: MissionConfig) => void) {
  const { config } = await loadConfig('config/auto-mission/default.json');
  configure?.(config);
  const inputs: { role: Role; input: Input }[] = [];
  const budget = new Budget(config.limits);
  const provider = new ResponsesProvider(config, {
    apiKey: 'test-only-not-a-secret',
    budget,
    transport: async (_url, options) => {
      const body = JSON.parse(String(options!.body));
      const role = body.text.format.name as Role;
      const input = JSON.parse(body.input[0].content[0].text) as Input;
      inputs.push({ role, input });
      let fallback: unknown;
      if (role === 'contractGenerator') {
        const { locations, factDefinitions, initialState, orderedObstacles, escapeConditions } =
          fixture.contract;
        fallback = { locations, factDefinitions, initialState, orderedObstacles, escapeConditions };
      } else if (role === 'contractChecker')
        fallback = { verdict: 'pass', summary: '固定条件確認', findings: [] };
      else if (role === 'storyGenerator' || role === 'repairer')
        fallback = {
          ...structuredClone(fixture.candidate),
          revision: input.revision,
          contractDigest: input.contractDigest,
        };
      else if (role === 'verifier')
        fallback = { candidateDigest: input.candidateDigest, decisions: [], findings: [] };
      else
        fallback = {
          role,
          candidateDigest: input.candidateDigest,
          verdict: 'pass',
          summary: '独立確認',
          findings: [],
        };
      const result = hook ? await hook(role, input, fallback, options!.signal!) : fallback;
      return new Response(
        JSON.stringify({
          status: 'completed',
          model: body.model,
          usage: { input_tokens: 12, output_tokens: 20 },
          output: [
            { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });
  return { config, provider, budget, inputs };
}
test('mission pipeline passes with independent identical reviewer payloads and phase checkpoints', async () => {
  const setupResult = await setup();
  const snapshots: RunRecord[] = [];
  try {
    const result = await runGeneration(setupResult.config, {
      provider: setupResult.provider,
      mode: 'mock',
      references: [{ path: 'sample.md', content: '参考' }],
      save: async (record) => {
        snapshots.push(structuredClone(record));
      },
    });
    assert.equal(result.status, 'passed');
    assert.equal(result.revisions.length, 1);
    assert.equal(result.calls.length, 7);
    assert.equal(result.revisions[0].verdict?.passed, true);
    const reviews = setupResult.inputs.filter((i) =>
      ['physics', 'resources', 'causality'].includes(i.role),
    );
    assert.equal(reviews.length, 3);
    assert.deepEqual(reviews[0].input, reviews[1].input);
    assert.deepEqual(reviews[1].input, reviews[2].input);
    assert.deepEqual(Object.keys(reviews[0].input).sort(), [
      'candidate',
      'candidateDigest',
      'contract',
      'evidenceIndex',
    ]);
    for (const entry of reviews[0].input.evidenceIndex)
      assert.ok(
        String(resolveEvidence(reviews[0].input.candidate, entry.path)).startsWith(entry.excerpt),
      );
    assert.ok(snapshots.some((s) => s.contract !== null && s.revisions.length === 0));
    assert.equal(snapshots.at(-1)!.status, 'passed');
    assert.ok(
      result.timings.some((t) => t.phase === 'parallel-reviews' && t.status === 'completed'),
    );
  } finally {
    setupResult.budget.close();
  }
});
test('mission repair ends at two repairs and does not let AI override mechanical failures', async () => {
  const s = await setup((role, _input, fallback) => {
    if (role === 'storyGenerator' || role === 'repairer') {
      const candidate = fallback as MissionCandidate;
      candidate.steps[0].itemIds = ['unknown'];
    }
    return fallback;
  });
  try {
    const result = await runGeneration(s.config, { provider: s.provider, mode: 'mock' });
    assert.equal(result.status, 'failed');
    assert.equal(result.failureCode, 'STORY_REJECTED');
    assert.equal(result.revisions.length, 3);
    assert.equal(s.inputs.filter((i) => i.role === 'repairer').length, 2);
    assert.equal(
      s.inputs.some((i) => i.role === 'physics' || i.role === 'verifier'),
      false,
    );
    assert.equal(new Set(result.revisions.map((r) => r.candidate.contractDigest)).size, 1);
    assert.equal(
      result.revisions.every((r) => r.mechanical?.checks.some((c) => c.status === 'fail')),
      true,
    );
  } finally {
    s.budget.close();
  }
});
test('mission repaired candidate gets fresh reviewers without previous findings', async () => {
  const s = await setup((role, input, fallback) => {
    if (role === 'storyGenerator') (fallback as MissionCandidate).steps[0].itemIds = ['unknown'];
    return fallback;
  });
  try {
    const result = await runGeneration(s.config, { provider: s.provider, mode: 'mock' });
    assert.equal(result.status, 'passed');
    assert.equal(result.revisions.length, 2);
    assert.ok(s.inputs.find((i) => i.role === 'repairer')!.input.previous);
    for (const review of s.inputs.filter((i) =>
      ['physics', 'resources', 'causality'].includes(i.role),
    )) {
      assert.equal('previous' in review.input, false);
      assert.equal('reviews' in review.input, false);
      assert.equal(review.input.candidate.revision, 1);
    }
  } finally {
    s.budget.close();
  }
});
test('saved evaluation creates new identity and rejects changed fixed inputs', async () => {
  const first = await setup();
  let saved: RunRecord;
  try {
    saved = await runGeneration(first.config, { provider: first.provider, mode: 'mock' });
  } finally {
    first.budget.close();
  }
  const again = await setup();
  try {
    const result = await evaluateSaved(saved, { provider: again.provider, mode: 'mock' });
    assert.equal(result.status, 'passed');
    assert.notEqual(result.runId, saved.runId);
    assert.equal(result.parentRunId, saved.runId);
    assert.deepEqual(result.contract, saved.contract);
    assert.equal(
      again.inputs.some((i) =>
        ['contractGenerator', 'storyGenerator', 'repairer'].includes(i.role),
      ),
      false,
    );
    assert.equal(saved.revisions.length, 1);
  } finally {
    again.budget.close();
  }
  const changed = structuredClone(saved);
  changed.inputSnapshot.config.difficulty.maxPhotoSends++;
  const bad = await setup();
  try {
    const result = await evaluateSaved(changed, { provider: bad.provider, mode: 'mock' });
    assert.equal(result.failureCode, 'CONTRACT_INVALID');
    assert.equal(bad.inputs.length, 0);
  } finally {
    bad.budget.close();
  }
});
test('peer API failure cancels unfinished reviewer but preserves completed review and candidate', async () => {
  let canceled = false;
  const s = await setup(async (role, _input, fallback, signal) => {
    if (role === 'resources') {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error('private upstream detail should never be saved');
    }
    if (role === 'causality')
      return await new Promise((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            canceled = true;
            reject(signal.reason);
          },
          { once: true },
        ),
      );
    return fallback;
  });
  const snapshots: RunRecord[] = [];
  try {
    const result = await runGeneration(s.config, {
      provider: s.provider,
      mode: 'mock',
      save: async (record) => {
        snapshots.push(structuredClone(record));
      },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.failureCode, 'API_ERROR');
    assert.equal(canceled, true);
    assert.deepEqual(
      result.revisions[0].reviews.map((r) => r.role),
      ['physics'],
    );
    assert.equal(result.revisions[0].verification, null);
    assert.equal(
      s.inputs.some((i) => i.role === 'repairer'),
      false,
    );
    assert.equal(snapshots.at(-1)!.revisions.length, 1);
    assert.equal(JSON.stringify(result).includes('private upstream detail'), false);
  } finally {
    s.budget.close();
  }
});
test('timeout saves obtained contract without fabricating a final story', async () => {
  const s = await setup(
    async (role, _input, fallback, signal) =>
      role === 'storyGenerator'
        ? await new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
          )
        : fallback,
    (config) => {
      config.limits.requestTimeoutSeconds = 0.03;
    },
  );
  const snapshots: RunRecord[] = [];
  try {
    const result = await runGeneration(s.config, {
      provider: s.provider,
      mode: 'mock',
      save: async (r) => {
        snapshots.push(structuredClone(r));
      },
    });
    assert.equal(result.failureCode, 'API_TIMEOUT');
    assert.ok(result.contract);
    assert.equal(result.revisions.length, 0);
    assert.equal(snapshots.at(-1)!.status, 'failed');
    assert.ok(result.timings.some((t) => t.status === 'aborted'));
  } finally {
    s.budget.close();
  }
});
test('storage failure is not reported as successful saved generation', async () => {
  const s = await setup();
  try {
    await assert.rejects(
      runGeneration(s.config, {
        provider: s.provider,
        mode: 'mock',
        save: async () => {
          throw new Error('disk full');
        },
      }),
      { code: 'STORAGE_ERROR' },
    );
  } finally {
    s.budget.close();
  }
});

test('unknown required review is REVIEW_INCOMPLETE and never triggers story repair', async () => {
  const s = await setup((role, _input, fallback) =>
    role === 'physics'
      ? { ...(fallback as object), verdict: 'unknown', summary: '身体動作の評価が未完了' }
      : fallback,
  );
  try {
    const result = await runGeneration(s.config, { provider: s.provider, mode: 'mock' });
    assert.equal(result.status, 'failed');
    assert.equal(result.failureCode, 'REVIEW_INCOMPLETE');
    assert.equal(result.revisions.length, 1);
    assert.equal(
      s.inputs.some((i) => i.role === 'repairer'),
      false,
    );
    assert.equal(result.revisions[0].verdict?.failureCode, 'REVIEW_INCOMPLETE');
  } finally {
    s.budget.close();
  }
});
test('stale verifier digest is OUTPUT_INVALID and never triggers story repair', async () => {
  const s = await setup((role, _input, fallback) =>
    role === 'verifier' ? { ...(fallback as object), candidateDigest: '0'.repeat(64) } : fallback,
  );
  try {
    const result = await runGeneration(s.config, { provider: s.provider, mode: 'mock' });
    assert.equal(result.status, 'failed');
    assert.equal(result.failureCode, 'OUTPUT_INVALID');
    assert.equal(result.revisions.length, 1);
    assert.equal(
      s.inputs.some((i) => i.role === 'repairer'),
      false,
    );
  } finally {
    s.budget.close();
  }
});
test('contract checker finding with missing evidence fails before story generation', async () => {
  const s = await setup((role, _input, fallback) =>
    role === 'contractChecker'
      ? {
          ...(fallback as object),
          findings: [
            {
              id: 'untrusted-id',
              role: 'contractChecker',
              blocking: false,
              category: 'causality',
              targetPath: '/does-not-exist',
              excerpt: 'nonexistent evidence',
              reason: '説明不足',
              missingInformation: '配置の説明',
            },
          ],
        }
      : fallback,
  );
  try {
    const result = await runGeneration(s.config, { provider: s.provider, mode: 'mock' });
    assert.equal(result.status, 'failed');
    assert.equal(result.failureCode, 'CONTRACT_INVALID');
    assert.equal(result.revisions.length, 0);
    assert.equal(
      s.inputs.some((i) => i.role === 'storyGenerator' || i.role === 'repairer'),
      false,
    );
  } finally {
    s.budget.close();
  }
});

test('contradictory terminal goals stop before story generation and preserve diagnostics', async () => {
  const context = await setup((role, _input, fallback) => {
    if (role !== 'contractGenerator') return fallback;
    const proposal = structuredClone(fallback) as {
      orderedObstacles: { goalConditions: { key: string; value: string }[] }[];
    };
    proposal.orderedObstacles[1].goalConditions.push({ key: 'rope', value: 'closed' });
    return proposal;
  });
  try {
    const result = await runGeneration(context.config, {
      provider: context.provider,
      mode: 'mock',
    });
    assert.equal(result.failureCode, 'CONTRACT_INVALID');
    assert.equal(result.contractValidation?.valid, false);
    assert.ok(
      result.contractValidation?.checks.some(
        (check) => check.status === 'fail' && check.reason.includes('終端条件が矛盾'),
      ),
    );
    assert.equal(
      context.inputs.some((input) => input.role === 'storyGenerator'),
      false,
    );
  } finally {
    context.budget.close();
  }
});
