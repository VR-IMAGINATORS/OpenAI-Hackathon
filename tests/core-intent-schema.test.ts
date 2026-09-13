import test from 'node:test';
import assert from 'node:assert/strict';
import { coreIntentResponseSchema } from '../apps/local-server/core-intent-ai.js';

test('intent wire schema uses supported anyOf while preserving all three intent branches', () => {
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
    schema.properties.decision.anyOf.map((branch: any) => branch.properties.kind.const),
    ['wait', 'consult', 'execute'],
  );
});
