import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { missionConfigSchema } from '../tools/auto-mission/schemas.js';
import { MockProvider, loadFixture } from '../tools/auto-mission/mock.js';
import { benchmark, fixtureRecord } from '../tools/auto-mission/benchmark.js';
import { runGeneration, evaluateSaved } from '../tools/auto-mission/pipeline.js';
const config = () =>
  missionConfigSchema.parse(
    JSON.parse(
      readFileSync(new URL('../config/auto-mission/default.json', import.meta.url), 'utf8'),
    ),
  );
test('mock generation runs pipeline and identifies all calls as mock', async () => {
  const c = config();
  const provider = new MockProvider(c);
  try {
    const result = await runGeneration(c, { provider, mode: 'mock' });
    assert.equal(result.status, 'passed', JSON.stringify(result));
    assert.equal(result.calls.length, 7);
    assert.ok(
      result.calls.every((call) => call.model.startsWith('mock:') && call.responseModel === 'mock'),
    );
  } finally {
    provider.budget.close();
  }
});
test('five-case benchmark never sends expected labels to evaluators and shares one budget', async () => {
  const inputs: unknown[] = [];
  const result = await benchmark(config(), {
    mode: 'mock',
    createProvider: (c, budget) => {
      const provider = new MockProvider(c, { budget });
      const call = provider.call.bind(provider);
      provider.call = async (role, input, schema, signal) => {
        inputs.push(input);
        return call(role, input, schema, signal);
      };
      return provider;
    },
  });
  assert.equal(result.complete, true);
  assert.equal(result.cases.length, 5);
  assert.ok(
    result.cases.every((c) => c.matched),
    JSON.stringify(result.cases),
  );
  assert.equal(result.budget.callCount, 12);
  for (const input of inputs) {
    const value = JSON.stringify(input);
    assert.ok(!value.includes('"expected"'));
    assert.ok(!value.includes('"matched"'));
  }
});
test('benchmark call limit is global and execution error is not expected rejection', async () => {
  const c = config();
  c.limits.maxApiCalls = 5;
  const result = await benchmark(c, {
    mode: 'mock',
    createProvider: (caseConfig, budget) => new MockProvider(caseConfig, { budget }),
  });
  assert.equal(result.complete, false);
  assert.equal(result.budget.callCount, 5);
  assert.equal(result.cases.at(-1)?.actual, 'error');
  assert.equal(result.cases.at(-1)?.matched, false);
});
test('saved evaluation keeps fixed contract and performs no regeneration', async () => {
  const c = config();
  const fixture = await loadFixture();
  const seed = fixtureRecord(fixture, c, 'mock');
  const provider = new MockProvider(c);
  try {
    const result = await evaluateSaved(seed, { provider, mode: 'mock' });
    assert.equal(result.status, 'passed');
    assert.equal(result.contractDigest, seed.contractDigest);
    assert.ok(
      !result.calls.some((call) =>
        ['contractGenerator', 'storyGenerator', 'repairer'].includes(call.role),
      ),
    );
  } finally {
    provider.budget.close();
  }
});
