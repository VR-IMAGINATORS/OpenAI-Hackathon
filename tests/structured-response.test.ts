import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { structuredResponse, responseText } from '../apps/local-server/structured-response.js';
import { canRetryJudgment } from '../apps/local-server/ai-failure.js';

const body = {
  instructions: 'Return current facts.',
  max_output_tokens: 2048,
  input: [{ text: 'fixed evidence' }],
};
const completed = {
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
};
const schema = z.object({ ok: z.boolean() }).strict();

for (const first of [
  { ...completed, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
  { output: [] },
  { output: {} },
  { output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }] },
])
  test('read/parse recovery uses fixed input and a larger bounded output budget', async () => {
    const seen: any[] = [];
    const result = await structuredResponse(
      async (request) => {
        seen.push(request);
        return seen.length === 1 ? first : completed;
      },
      body,
      (value) => schema.parse(value),
    );
    assert.equal(result.ok, true);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].max_output_tokens, 2048);
    assert.equal(seen[1].max_output_tokens, 4096);
    assert.deepEqual(seen[0].input, seen[1].input);
    assert.equal(body.max_output_tokens, 2048);
  });

for (const first of [
  { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] },
  { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Private refusal' }] }] },
])
  test('refusals are identified without repair or private text disclosure', async () => {
    let calls = 0;
    await assert.rejects(
      structuredResponse(
        async () => {
          calls++;
          return first;
        },
        body,
        (value) => schema.parse(value),
      ),
      /AI_OUTPUT_REFUSED/,
    );
    assert.equal(calls, 1);
  });

test('recovery stops after two calls and a stale request cannot make the second call', async () => {
  let calls = 0;
  await assert.rejects(
    structuredResponse(
      async () => {
        calls++;
        return { output: [] };
      },
      body,
      (value) => schema.parse(value),
    ),
    /AI_OUTPUT_INVALID/,
  );
  assert.equal(calls, 2);
  let sent = 0;
  await assert.rejects(
    structuredResponse(
      async () => {
        if (sent) throw Object.assign(new Error('stale'), { code: 'ACTION_INVALID' });
        sent++;
        return { output: [] };
      },
      body,
      (value) => schema.parse(value),
    ),
    /stale/,
  );
  assert.equal(sent, 1);
  assert.throws(() => responseText({ ...completed, status: 'incomplete' }), /AI_OUTPUT_INCOMPLETE/);
});

test('the original upstream HTTP status distinguishes permanent errors from retryable failures', () => {
  for (const upstreamStatus of [400, 401, 403, 404])
    assert.equal(canRetryJudgment({ code: 'UPSTREAM_FAILED', status: 502, upstreamStatus }), false);
  for (const upstreamStatus of [408, 500, 502, 503])
    assert.equal(canRetryJudgment({ code: 'UPSTREAM_FAILED', status: 502, upstreamStatus }), true);
  assert.equal(canRetryJudgment({ code: 'REQUEST_LIMIT', status: 429 }), false);
});
