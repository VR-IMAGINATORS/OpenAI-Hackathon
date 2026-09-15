import test from 'node:test';
import assert from 'node:assert/strict';
import { coreIntentResponseSchema } from '../apps/local-server/core-intent-ai.js';

test('intent wire schema uses supported anyOf for ordinary intents and retained request controls', () => {
  const schema = coreIntentResponseSchema as any;
  const check = (node: any) => {
    if (!node || typeof node !== 'object') return;
    assert.equal('oneOf' in node, false, 'Responses rejects oneOf');
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
    }
    Object.values(node).forEach(check);
  };
  check(schema);
  assert.deepEqual(
    schema.properties.decision.anyOf.flatMap(
      (branch: any) => branch.properties.kind.enum ?? [branch.properties.kind.const],
    ),
    ['wait', 'consult', 'execute', 'retry_request', 'cancel_request'],
  );
  assert.equal(JSON.stringify(schema).includes('retryOf'), false);
});
