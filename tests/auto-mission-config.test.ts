import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  loadConfig,
  parseConfig,
  digestValue,
  assembleContract,
} from '../tools/auto-mission/config.js';
import {
  contractProposalSchema,
  missionCandidateSchema,
  reviewSchema,
  verificationSchema,
} from '../tools/auto-mission/schemas.js';
const configPath = path.resolve('config/auto-mission/default.json');
test('mission default keeps Astra, ten-minute timeout and unlimited counted actions', async () => {
  const { config } = await loadConfig(configPath);
  assert.equal(config.models.storyGenerator.model, 'gpt-6-astra');
  assert.equal(config.limits.deadlineSeconds, 600);
  assert.equal(config.difficulty.maxActions, null);
  for (const role of [
    'contractGenerator',
    'contractChecker',
    'storyGenerator',
    'repairer',
    'verifier',
  ] as const) {
    const altered = structuredClone(config);
    altered.models[role].model = 'gpt-5.6-sol';
    assert.throws(() => parseConfig(altered));
  }
  const duplicate = structuredClone(config);
  duplicate.objectCatalog.push(duplicate.objectCatalog[0]);
  assert.throws(() => parseConfig(duplicate));
  assert.throws(() => parseConfig({ ...config, apiKey: 'not-allowed' }));
  assert.throws(() => parseConfig({ ...config, limits: { ...config.limits, maxRepairs: 3 } }));
  assert.throws(() =>
    parseConfig({ ...config, difficulty: { ...config.difficulty, maxActions: 0 } }),
  );
});
test('mission digest is canonical and contract assembly keeps external constraints', async () => {
  assert.equal(digestValue({ b: 1, a: 2 }), digestValue({ a: 2, b: 1 }));
  assert.notEqual(digestValue({ a: 1 }), digestValue({ a: 2 }));
  const { config } = await loadConfig(configPath);
  const proposal = {
    locations: [{ id: 'room', description: '部屋' }],
    factDefinitions: [{ key: 'door', allowedValues: ['closed', 'open'], initialValue: 'closed' }],
    initialState: { locationId: 'room', description: '椅子のそば', props: [] },
    orderedObstacles: [
      {
        id: 'first',
        locationId: 'room',
        goalConditions: [{ key: 'door', value: 'open' }],
        constraints: [],
      },
      {
        id: 'second',
        locationId: 'room',
        goalConditions: [{ key: 'door', value: 'open' }],
        constraints: [],
      },
    ],
    escapeConditions: [{ key: 'door', value: 'open' }],
  };
  const contract = assembleContract(config, proposal, digestValue(config));
  assert.deepEqual(contract.difficulty, config.difficulty);
  assert.throws(() =>
    contractProposalSchema.parse({ ...proposal, difficulty: { maxActions: 99 } }),
  );
});
test('mission structured output schemas require every property and reject extra fields', () => {
  for (const schema of [
    contractProposalSchema,
    missionCandidateSchema,
    reviewSchema,
    verificationSchema,
  ]) {
    const json = z.toJSONSchema(schema);
    assert.equal(json.additionalProperties, false);
    assert.deepEqual([...json.required!].sort(), Object.keys(json.properties!).sort());
  }
});
test('mission loads explicit references relative to config and rejects secret/remote inputs', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mission-config-'));
  try {
    const { config } = await loadConfig(configPath);
    await writeFile(path.join(directory, 'example.md'), '参考案');
    config.referenceScenarios = ['example.md'];
    const file = path.join(directory, 'config.json');
    await writeFile(file, JSON.stringify(config));
    assert.equal((await loadConfig(file)).references[0].content, '参考案');
    for (const reference of ['.env', '.env.local', 'https://example.com/example.md']) {
      config.referenceScenarios = [reference];
      await writeFile(file, JSON.stringify(config));
      await assert.rejects(loadConfig(file));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
