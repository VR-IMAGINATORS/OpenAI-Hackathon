import { randomUUID } from 'node:crypto';
import { Budget } from './budget.js';
import { assembleContract, digestValue, parseConfig } from './config.js';
import { evaluateSaved, type MissionProvider } from './pipeline.js';
import { fixtureNames, loadFixture, type FixtureName, type MissionFixture } from './mock.js';
import type { MissionConfig, RunRecord } from './schemas.js';

export function fixtureRecord(
  fixture: MissionFixture,
  config: MissionConfig,
  mode: 'mock' | 'live',
): RunRecord {
  const caseConfig = parseConfig({
    ...config,
    world: fixture.contract.world,
    difficulty: fixture.contract.difficulty,
    objectCatalog: fixture.contract.objectCatalog,
    referenceScenarios: [],
  });
  const inputSnapshot = { config: caseConfig, references: [] };
  const { locations, factDefinitions, initialState, orderedObstacles, escapeConditions } =
    fixture.contract;
  const contract = assembleContract(
    caseConfig,
    { locations, factDefinitions, initialState, orderedObstacles, escapeConditions },
    digestValue(inputSnapshot),
  );
  const contractDigest = digestValue(contract);
  const candidate = { ...structuredClone(fixture.candidate), contractDigest };
  // This seed is a fixture input, not a claimed successful run. Evaluate always rechecks it.
  return {
    runId: `fixture-${randomUUID()}`,
    parentRunId: null,
    mode,
    status: 'running',
    phase: 'check',
    failureCode: null,
    failureReason: null,
    inputSnapshot,
    contract,
    contractDigest,
    contractCheck: {
      verdict: 'pass',
      summary: 'ベンチマークの固定入力。実AIによる契約検査結果ではない。',
      findings: [],
    },
    revisions: [
      {
        candidate,
        digest: digestValue(candidate),
        mechanical: null,
        reviews: [],
        verification: null,
        verdict: null,
      },
    ],
    calls: [],
    timings: [],
    startedAt: new Date().toISOString(),
    endedAt: null,
    durationMs: null,
  };
}
export interface BenchmarkDependencies {
  mode: 'live' | 'mock';
  createProvider: (config: MissionConfig, budget: Budget) => MissionProvider;
  save?: (record: RunRecord) => Promise<void>;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}
export async function benchmark(config: MissionConfig, deps: BenchmarkDependencies) {
  config = parseConfig(config);
  const budget = new Budget(config.limits);
  const records: RunRecord[] = [];
  const cases: {
    name: FixtureName;
    expected: 'pass' | 'fail';
    actual: 'pass' | 'fail' | 'error';
    matched: boolean;
    failureCode: RunRecord['failureCode'];
  }[] = [];
  try {
    for (const name of fixtureNames) {
      if (deps.signal?.aborted || budget.signal.aborted || budget.remainingMs() <= 0) break;
      const fixture = await loadFixture(name);
      const seed = fixtureRecord(fixture, config, deps.mode);
      const provider = deps.createProvider(seed.inputSnapshot.config, budget);
      const record = await evaluateSaved(seed, {
        provider,
        mode: deps.mode,
        save: deps.save,
        onProgress: (message) => deps.onProgress?.(`${name}: ${message}`),
        signal: deps.signal,
      });
      records.push(record);
      const actual =
        record.status === 'passed'
          ? 'pass'
          : record.failureCode === 'STORY_REJECTED'
            ? 'fail'
            : 'error';
      cases.push({
        name,
        expected: fixture.expected.verdict,
        actual,
        matched: actual === fixture.expected.verdict,
        failureCode: record.failureCode,
      });
      if (actual === 'error') break;
    }
    return {
      records,
      cases,
      budget: budget.snapshot(),
      complete: cases.length === fixtureNames.length,
      mode: deps.mode,
    };
  } finally {
    budget.close();
  }
}
