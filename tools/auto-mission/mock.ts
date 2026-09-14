import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { Budget, MissionProviderError } from './budget.js';
import type { MissionProvider } from './provider.js';
import {
  missionContractSchema,
  missionCandidateSchema,
  type MissionConfig,
  type CallRecord,
  type Role,
  type MissionCandidate,
  type Review,
  type Finding,
} from './schemas.js';
export const fixtureNames = [
  'valid',
  'action-limit',
  'spent-tool',
  'bound-body',
  'missing-placement',
] as const;
export type FixtureName = (typeof fixtureNames)[number];
const fixtureSchema = z.strictObject({
  expected: z.strictObject({ verdict: z.enum(['pass', 'fail']), reason: z.string() }),
  contract: missionContractSchema,
  candidate: missionCandidateSchema,
});
export type MissionFixture = z.infer<typeof fixtureSchema>;
export async function loadFixture(name: FixtureName = 'valid'): Promise<MissionFixture> {
  if (!fixtureNames.includes(name)) throw new Error('Unknown fixture');
  return fixtureSchema.parse(
    JSON.parse(
      await readFile(
        new URL(`../../tests/fixtures/auto-mission/${name}.json`, import.meta.url),
        'utf8',
      ),
    ),
  );
}
/** Deterministic control-flow double, not an AI feasibility evaluator. */
export class MockProvider implements MissionProvider {
  readonly calls: CallRecord[] = [];
  readonly budget: Budget;
  private readonly fixture: Promise<MissionFixture>;
  constructor(
    private readonly config: MissionConfig,
    options: { budget?: Budget; fixture?: MissionFixture } = {},
  ) {
    this.budget = options.budget ?? new Budget(config.limits);
    this.fixture = options.fixture ? Promise.resolve(options.fixture) : loadFixture();
  }
  async call<T>(
    role: Role,
    input: unknown,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throw new MissionProviderError('INTERRUPTED');
    this.budget.assertActive();
    const model = this.config.models[role];
    const reservation = this.budget.reserve(model.maxOutputTokens);
    const start = performance.now();
    const record: CallRecord = {
      role,
      model: `mock:${model.model}`,
      requestedModel: model.model,
      responseModel: 'mock',
      reasoningEffort: model.reasoningEffort,
      status: 'running',
      usage: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      durationMs: null,
      reservedOutputTokens: model.maxOutputTokens,
      error: null,
    };
    this.calls.push(record);
    try {
      const fixture = await this.fixture;
      this.budget.assertActive();
      if (signal?.aborted) throw new MissionProviderError('INTERRUPTED');
      const data = input as {
        contractDigest?: string;
        revision?: number;
        candidateDigest?: string;
        candidate?: MissionCandidate;
        reviews?: Review[];
      };
      let result: unknown;
      if (role === 'contractGenerator') {
        const { locations, factDefinitions, initialState, orderedObstacles, escapeConditions } =
          fixture.contract;
        result = { locations, factDefinitions, initialState, orderedObstacles, escapeConditions };
      } else if (role === 'contractChecker')
        result = {
          verdict: 'pass',
          summary: 'MOCK: 固定テストデータの契約検査応答。実AI検証ではありません。',
          findings: [],
        };
      else if (role === 'storyGenerator' || role === 'repairer')
        result = {
          ...structuredClone(fixture.candidate),
          contractDigest: data.contractDigest,
          revision: data.revision,
        };
      else if (role === 'verifier')
        result = {
          candidateDigest: data.candidateDigest,
          decisions: (data.reviews ?? [])
            .flatMap((r) => r.findings)
            .map((f) => ({
              findingId: f.id,
              disposition: 'confirmed',
              reason: 'MOCK: テスト用指摘を確定。',
              evidencePaths: [f.targetPath],
              counterevidence: '',
            })),
          findings: [],
        };
      else {
        const findings: Finding[] = [];
        const opening = data.candidate?.opening ?? '';
        const blocked = role === 'physics' && opening.includes('指も一切動かせず');
        const missing = role === 'causality' && opening.includes('受け取り手段は不明');
        if (blocked || missing)
          findings.push({
            id: 'mock-1',
            role,
            blocking: true,
            category: blocked ? 'physical' : 'missing-information',
            targetPath: '/opening',
            excerpt: opening,
            reason: blocked
              ? 'MOCK: 指を動かせないのに道具を握る手順がある。'
              : 'MOCK: 具現化した物の受け取り説明がない。',
            missingInformation: missing ? '受け取り場所と手段' : '',
          });
        result = {
          role,
          candidateDigest: data.candidateDigest,
          verdict: findings.length ? 'fail' : 'pass',
          summary: 'MOCK: 固定パターンによる制御検査でありAI品質の証拠ではありません。',
          findings,
        };
      }
      const parsed = schema.parse(result);
      record.usage = { inputTokens: 0, outputTokens: 0 };
      record.status = 'completed';
      return parsed;
    } catch (error) {
      const safe =
        error instanceof MissionProviderError
          ? error
          : new MissionProviderError('OUTPUT_INVALID', 'mock_fixture_or_schema_invalid');
      record.status = 'failed';
      record.error = safe.message;
      this.budget.abort(safe);
      throw safe;
    } finally {
      this.budget.settle(reservation, record.usage?.outputTokens ?? null);
      record.durationMs = performance.now() - start;
      record.endedAt = new Date().toISOString();
    }
  }
}
