import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { z } from 'zod';
import { Budget, MissionProviderError } from '../tools/auto-mission/budget.js';
import { ResponsesProvider, strictOutputSchema } from '../tools/auto-mission/provider.js';
import { missionConfigSchema } from '../tools/auto-mission/schemas.js';
const config = () =>
  missionConfigSchema.parse(
    JSON.parse(
      readFileSync(new URL('../config/auto-mission/default.json', import.meta.url), 'utf8'),
    ),
  );
const output = z.strictObject({ ok: z.boolean() });
const response = (extra: Record<string, unknown> = {}) =>
  new Response(
    JSON.stringify({
      status: 'completed',
      model: 'actual-model',
      usage: { input_tokens: 12, output_tokens: 5 },
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
      ...extra,
    }),
  );
const rejectsCode = (code: string) => (error: unknown) =>
  error instanceof MissionProviderError && error.code === code;

test('atomic reservations count concurrent maxima; unknown usage is retained', () => {
  const budget = new Budget({
    maxApiCalls: 3,
    maxOutputTokensTotal: 15,
    deadlineSeconds: 600,
    requestTimeoutSeconds: 180,
  });
  try {
    const a = budget.reserve(10);
    assert.throws(() => budget.reserve(6), rejectsCode('BUDGET_EXCEEDED'));
    budget.settle(a, 3);
    const b = budget.reserve(10);
    budget.settle(b, null);
    assert.equal(budget.snapshot().chargedOutputTokens, 13);
    assert.equal(budget.snapshot().unknownUsageCalls, 1);
    assert.throws(() => budget.reserve(3), rejectsCode('BUDGET_EXCEEDED'));
  } finally {
    budget.close();
  }
});
test('global monotonic deadline never resets between calls', () => {
  let now = 0;
  const budget = new Budget(config().limits, { now: () => now });
  try {
    now = 600001;
    assert.throws(() => budget.reserve(1), rejectsCode('API_TIMEOUT'));
  } finally {
    budget.close();
  }
});
test('strict schema rejects optional fields and allows nullable fields', () => {
  assert.throws(
    () => strictOutputSchema(z.object({ optional: z.string().optional() })),
    rejectsCode('OUTPUT_INVALID'),
  );
  assert.equal(
    strictOutputSchema(z.object({ nullable: z.string().nullable() })).additionalProperties,
    false,
  );
});
test('independent calls have no shared conversation or prior response; usage/model recorded', async () => {
  const bodies: Record<string, unknown>[] = [];
  const provider = new ResponsesProvider(config(), {
    apiKey: 'test-secret',
    transport: async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(init?.redirect, 'error');
      bodies.push(JSON.parse(String(init?.body)));
      return response();
    },
  });
  try {
    await Promise.all([
      provider.call('physics', { candidate: 'same' }, output),
      provider.call('resources', { candidate: 'same' }, output),
    ]);
    assert.deepEqual(bodies[0].input, bodies[1].input);
    for (const body of bodies) {
      assert.equal(body.previous_response_id, undefined);
      assert.equal(body.conversation, undefined);
      assert.equal(body.store, false);
    }
    assert.equal(provider.calls[0].responseModel, 'actual-model');
    assert.deepEqual(provider.calls[0].usage, { inputTokens: 12, outputTokens: 5 });
    assert.ok(!JSON.stringify(provider.calls).includes('test-secret'));
  } finally {
    provider.budget.close();
  }
});
for (const [name, payload, detail] of [
  [
    'refusal',
    { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'private raw text' }] }] },
    'refusal',
  ],
  ['incomplete', { status: 'incomplete' }, 'incomplete'],
  [
    'schema mismatch',
    { output: [{ type: 'message', content: [{ type: 'output_text', text: '{"wrong":true}' }] }] },
    'schema_mismatch',
  ],
] as const)
  test(`${name} fails safely without retry`, async () => {
    let count = 0;
    const provider = new ResponsesProvider(config(), {
      apiKey: 'test-secret',
      transport: async () => {
        count++;
        return response(payload);
      },
    });
    try {
      await assert.rejects(
        provider.call('storyGenerator', {}, output),
        (e: unknown) => e instanceof MissionProviderError && e.detail === detail,
      );
      assert.equal(count, 1);
      assert.ok(!JSON.stringify(provider.calls).includes('private raw text'));
    } finally {
      provider.budget.close();
    }
  });
test('transport errors sanitize secrets and stop sibling requests', async () => {
  const provider = new ResponsesProvider(config(), {
    apiKey: 'secret',
    transport: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.model === config().models.physics.model)
        throw new Error('secret credential and upstream data');
      return new Promise<Response>(() => {});
    },
  });
  try {
    const result = await Promise.allSettled([
      provider.call('physics', {}, output),
      provider.call('resources', {}, output),
    ]);
    assert.ok(result.every((x) => x.status === 'rejected'));
    assert.ok(!JSON.stringify(provider.calls).includes('credential'));
    assert.equal(provider.budget.snapshot().unknownUsageCalls, 2);
  } finally {
    provider.budget.close();
  }
});
test('request timeout works even when injected transport ignores abort', async () => {
  const c = config();
  c.limits.requestTimeoutSeconds = 0.01;
  const provider = new ResponsesProvider(c, {
    apiKey: 'secret',
    transport: async () => new Promise<Response>(() => {}),
  });
  try {
    await assert.rejects(provider.call('physics', {}, output), rejectsCode('API_TIMEOUT'));
    assert.equal(provider.calls[0].status, 'aborted');
  } finally {
    provider.budget.close();
  }
});
test('model unavailable is a failure without downgrade', async () => {
  let count = 0;
  const provider = new ResponsesProvider(config(), {
    apiKey: 'secret',
    transport: async () => {
      count++;
      return new Response('private', { status: 404 });
    },
  });
  try {
    await assert.rejects(
      provider.call('storyGenerator', {}, output),
      rejectsCode('MODEL_UNAVAILABLE'),
    );
    assert.equal(count, 1);
  } finally {
    provider.budget.close();
  }
});
test('oversized input stops before reservation or transport', async () => {
  const provider = new ResponsesProvider(config(), {
    apiKey: 'secret',
    transport: async () => {
      throw new Error('must not call');
    },
  });
  try {
    await assert.rejects(
      provider.call('physics', { text: 'x'.repeat(50000) }, output),
      rejectsCode('BUDGET_EXCEEDED'),
    );
    assert.equal(provider.calls.length, 0);
  } finally {
    provider.budget.close();
  }
});

test('unknown and excessive upstream usage are never converted to free success', async () => {
  const unknown = new ResponsesProvider(config(), {
    apiKey: 'secret',
    transport: async () => response({ usage: { input_tokens: 8 } }),
  });
  try {
    await unknown.call('physics', {}, output);
    assert.equal(unknown.calls[0].usage?.outputTokens, null);
    assert.equal(
      unknown.budget.snapshot().chargedOutputTokens,
      config().models.physics.maxOutputTokens,
    );
  } finally {
    unknown.budget.close();
  }
  const excessive = new ResponsesProvider(config(), {
    apiKey: 'secret',
    transport: async () => response({ usage: { input_tokens: 8, output_tokens: 100001 } }),
  });
  try {
    await assert.rejects(excessive.call('physics', {}, output), rejectsCode('BUDGET_EXCEEDED'));
    assert.equal(excessive.calls[0].status, 'failed');
  } finally {
    excessive.budget.close();
  }
});
test('oversized response is bounded and not stored', async () => {
  const provider = new ResponsesProvider(config(), {
    apiKey: 'secret',
    transport: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)),
  });
  try {
    await assert.rejects(
      provider.call('physics', {}, output),
      (e: unknown) => e instanceof MissionProviderError && e.detail === 'response_too_large',
    );
    assert.equal(provider.calls[0].usage, null);
  } finally {
    provider.budget.close();
  }
});

test('call digests identify only frozen instructions and canonical scenario input', async () => {
  const { createHash } = await import('node:crypto');
  const { stableStringify } = await import('../tools/auto-mission/config.js');
  const bodies: { instructions: string; input: { content: { text: string }[] }[] }[] = [];
  const provider = new ResponsesProvider(config(), {
    apiKey: 'auth-is-not-scenario-data',
    transport: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return response();
    },
  });
  try {
    const input = { z: 3, a: { y: 2, b: 1 } };
    await provider.call('physics', input, output);
    await provider.call('physics', { a: { b: 1, y: 2 }, z: 3 }, output);
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    assert.equal(provider.calls[0].instructionsDigest, hash(bodies[0].instructions));
    assert.equal(bodies[0].input[0].content[0].text, stableStringify(input));
    assert.equal(provider.calls[0].inputDigest, hash(bodies[0].input[0].content[0].text));
    assert.equal(provider.calls[0].inputDigest, provider.calls[1].inputDigest);
    assert.equal(provider.calls[0].instructionsDigest, provider.calls[1].instructionsDigest);
    assert.notEqual(provider.calls[0].inputDigest, hash('auth-is-not-scenario-data'));
    assert.ok(!JSON.stringify(provider.calls).includes('auth-is-not-scenario-data'));
  } finally {
    provider.budget.close();
  }
});
