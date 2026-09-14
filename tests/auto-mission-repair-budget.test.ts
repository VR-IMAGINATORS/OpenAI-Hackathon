import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { loadConfig, digestValue } from '../tools/auto-mission/config.js';
import { repairContext } from '../tools/auto-mission/pipeline.js';
import { ResponsesProvider } from '../tools/auto-mission/provider.js';
import {
  missionContractSchema,
  revisionRecordSchema,
  missionCandidateSchema,
} from '../tools/auto-mission/schemas.js';

test('real large repair diagnostics fit 48 KiB without dropping the fixed contract or candidate', async () => {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/auto-mission/large-repair.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(Object.keys(fixture).sort(), ['contract', 'previous']);
  const contract = missionContractSchema.parse(fixture.contract);
  const previous = revisionRecordSchema.parse(fixture.previous);
  const savedSnapshot = JSON.stringify(previous);
  const { config } = await loadConfig('config/auto-mission/default.json');
  assert.equal(config.limits.maxInputBytesPerCall, 48 * 1024);
  const compressed = repairContext(previous);
  assert.deepEqual(compressed.candidate, previous.candidate);
  assert.deepEqual(
    compressed.mechanical!.checks,
    previous.mechanical!.checks.filter((check) => check.status === 'fail'),
  );
  assert.ok(compressed.mechanical!.checks.length > 0);
  assert.ok(previous.mechanical!.checks.some((check) => check.status === 'pass'));
  assert.deepEqual(compressed.mechanical!.lastValidState, previous.mechanical!.stateTrace.at(-1));
  assert.ok(previous.mechanical!.stateTrace.length > 1);
  assert.equal('stateTrace' in compressed.mechanical!, false);
  assert.deepEqual(compressed.reviews, previous.reviews);
  assert.deepEqual(compressed.verification, previous.verification);
  assert.deepEqual(compressed.verdict, previous.verdict);
  const payload = {
    contract,
    contractDigest: digestValue(contract),
    revision: 1,
    references: [],
    instruction: '固定コントラクトを変更せず、指摘と機械検査の問題を修正してください。',
  };
  let receivedBytes = 0;
  let calls = 0;
  const transport: typeof fetch = async (_url, options) => {
    calls++;
    receivedBytes = Buffer.byteLength(String(options!.body));
    const body = JSON.parse(String(options!.body));
    const input = JSON.parse(body.input[0].content[0].text);
    assert.deepEqual(input.contract, contract);
    assert.equal(input.contractDigest, digestValue(contract));
    assert.deepEqual(input.previous.candidate, previous.candidate);
    const candidate = { ...previous.candidate, revision: 1 };
    return new Response(
      JSON.stringify({
        status: 'completed',
        model: 'gpt-6-astra',
        usage: { input_tokens: 12, output_tokens: 20 },
        output: [
          { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(candidate) }] },
        ],
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  };
  const oldProvider = new ResponsesProvider(config, { apiKey: 'fixture-key', transport });
  try {
    await assert.rejects(
      oldProvider.call('repairer', { ...payload, previous }, missionCandidateSchema),
      { code: 'BUDGET_EXCEEDED' },
    );
    assert.equal(calls, 0);
    assert.equal(oldProvider.budget.snapshot().callCount, 0);
  } finally {
    oldProvider.budget.close();
  }
  const compactProvider = new ResponsesProvider(config, { apiKey: 'fixture-key', transport });
  try {
    const response = await compactProvider.call(
      'repairer',
      { ...payload, previous: compressed },
      missionCandidateSchema,
    );
    assert.equal(response.revision, 1);
    assert.equal(calls, 1);
    assert.ok(receivedBytes <= config.limits.maxInputBytesPerCall);
    assert.equal(
      JSON.stringify(previous),
      savedSnapshot,
      'Stored full checks and trace must remain unchanged',
    );
  } finally {
    compactProvider.budget.close();
  }
});
