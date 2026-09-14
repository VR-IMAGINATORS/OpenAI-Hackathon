import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { z } from 'zod';
import { assembleContract, digestValue, parseConfig } from './config.js';
import { validateContract, simulateWitness } from './simulate.js';
import { deriveVerdict, validateEvidence } from './verdict.js';
import type { Budget } from './budget.js';
import {
  contractProposalSchema,
  contractCheckSchema,
  missionCandidateSchema,
  reviewSchema,
  verificationSchema,
  failureCodeSchema,
  reviewerRoles,
  type Role,
  type CallRecord,
  type RunRecord,
  type InputSnapshot,
  type PhaseTiming,
  type FailureCode,
  type MissionConfig,
  type MissionCandidate,
  type RevisionRecord,
} from './schemas.js';

export interface MissionProvider {
  calls: CallRecord[];
  budget: Budget;
  call<T>(role: Role, input: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T>;
}
export interface RunDependencies {
  provider: MissionProvider;
  mode: 'live' | 'mock';
  references?: InputSnapshot['references'];
  save?: (record: RunRecord) => Promise<void>;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}
class RunFailure extends Error {
  constructor(
    readonly code: FailureCode,
    message: string,
  ) {
    super(message);
  }
}
function errorCode(error: unknown): FailureCode {
  const code = failureCodeSchema.safeParse((error as { code?: unknown })?.code);
  return code.success ? code.data : 'API_ERROR';
}
const messages: Record<FailureCode, string> = {
  CONFIG_INVALID: '設定または保存入力が不正です。',
  CONTRACT_INVALID: '固定条件を検証できませんでした。',
  STORY_REJECTED: '修正上限までに成立性を確認できませんでした。',
  REVIEW_INCOMPLETE: '必須評価が未完了です。',
  API_ERROR: 'API通信に失敗しました。',
  API_TIMEOUT: '実行または呼び出しの制限時間に達しました。',
  MODEL_UNAVAILABLE: '指定モデルを利用できません。',
  OUTPUT_INVALID: 'モデル出力の形式または参照が不正です。',
  BUDGET_EXCEEDED: 'APIまたはトークンの予算上限に達しました。',
  INTERRUPTED: '実行を中断しました。',
  STORAGE_ERROR: '結果の保存に失敗しました。',
};

/** Keep the full trace in run.json; send only actionable diagnostics to the repairer. */
export function repairContext(previous: RevisionRecord) {
  return {
    candidate: previous.candidate,
    digest: previous.digest,
    mechanical: previous.mechanical
      ? {
          checks: previous.mechanical.checks.filter((check) => check.status === 'fail'),
          resourceTotals: previous.mechanical.resourceTotals,
          estimatedTotalSeconds: previous.mechanical.estimatedTotalSeconds,
          lastValidState: previous.mechanical.stateTrace.at(-1) ?? null,
        }
      : null,
    reviews: previous.reviews,
    verification: previous.verification,
    verdict: previous.verdict,
  };
}
export async function runGeneration(
  config: MissionConfig,
  deps: RunDependencies,
): Promise<RunRecord> {
  return run(config, deps);
}
export async function evaluateSaved(saved: RunRecord, deps: RunDependencies): Promise<RunRecord> {
  return run(
    saved.inputSnapshot.config,
    { ...deps, references: saved.inputSnapshot.references },
    saved,
  );
}
async function run(
  config: MissionConfig,
  deps: RunDependencies,
  saved?: RunRecord,
): Promise<RunRecord> {
  config = parseConfig(config);
  const start = performance.now();
  const record: RunRecord = {
    runId: randomUUID(),
    parentRunId: saved?.runId ?? null,
    mode: deps.mode,
    status: 'running',
    phase: 'contract',
    failureCode: null,
    failureReason: null,
    inputSnapshot: structuredClone({ config, references: deps.references ?? [] }),
    contract: null,
    contractDigest: null,
    contractCheck: null,
    revisions: [],
    calls: [],
    timings: [],
    startedAt: new Date().toISOString(),
    endedAt: null,
    durationMs: null,
  };
  const callStart = deps.provider.calls.length;
  const abort = () =>
    deps.provider.budget.abort(new RunFailure('INTERRUPTED', messages.INTERRUPTED));
  deps.signal?.addEventListener('abort', abort, { once: true });
  if (deps.signal?.aborted) abort();
  const ensureRunning = () => {
    if (deps.signal?.aborted) throw new RunFailure('INTERRUPTED', messages.INTERRUPTED);
    if (deps.provider.budget.remainingMs() <= 0)
      throw new RunFailure('API_TIMEOUT', messages.API_TIMEOUT);
    if (deps.provider.budget.signal.aborted) throw deps.provider.budget.signal.reason;
  };
  async function checkpoint() {
    record.calls = structuredClone(deps.provider.calls.slice(callStart));
    if (!deps.save) return;
    try {
      await deps.save(structuredClone(record));
    } catch {
      throw new RunFailure('STORAGE_ERROR', messages.STORAGE_ERROR);
    }
  }
  async function phase<T>(
    name: string,
    revision: number | null,
    operation: () => Promise<T> | T,
    role: Role | null = null,
  ): Promise<T> {
    ensureRunning();
    const at = performance.now();
    const timing: PhaseTiming = {
      phase: name,
      revision,
      role,
      startedAt: new Date().toISOString(),
      endedAt: null,
      durationMs: null,
      status: 'running',
      reason: null,
    };
    record.timings.push(timing);
    deps.onProgress?.(
      `${name}${revision === null ? '' : ` (候補 ${revision + 1})`}${role ? ` / ${role}` : ''}`,
    );
    try {
      const value = await operation();
      ensureRunning();
      timing.status = 'completed';
      return value;
    } catch (error) {
      timing.status = deps.provider.budget.signal.aborted ? 'aborted' : 'failed';
      timing.reason = errorCode(error);
      throw error;
    } finally {
      timing.endedAt = new Date().toISOString();
      timing.durationMs = performance.now() - at;
    }
  }
  const call = <T>(role: Role, input: unknown, schema: z.ZodType<T>, revision: number | null) =>
    phase('api', revision, () => deps.provider.call(role, input, schema, deps.signal), role);
  const skip = (name: string, revision: number, reason: string) =>
    record.timings.push({
      phase: name,
      revision,
      role: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      durationMs: null,
      status: 'skipped',
      reason,
    });
  try {
    await checkpoint();
    if (saved) {
      if (
        !saved.contract ||
        !saved.revisions.length ||
        !saved.contractCheck ||
        saved.contractCheck.verdict !== 'pass' ||
        saved.contractCheck.findings.some((f) => f.blocking)
      )
        throw new RunFailure('CONTRACT_INVALID', messages.CONTRACT_INVALID);
      const rebuilt = assembleContract(
        config,
        {
          locations: saved.contract.locations,
          factDefinitions: saved.contract.factDefinitions,
          initialState: saved.contract.initialState,
          orderedObstacles: saved.contract.orderedObstacles,
          escapeConditions: saved.contract.escapeConditions,
        },
        digestValue(record.inputSnapshot),
      );
      if (
        digestValue(rebuilt) !== saved.contractDigest ||
        digestValue(saved.contract) !== saved.contractDigest
      )
        throw new RunFailure('CONTRACT_INVALID', messages.CONTRACT_INVALID);
      record.contract = structuredClone(saved.contract);
      record.contractDigest = saved.contractDigest;
      record.contractCheck = structuredClone(saved.contractCheck);
    } else {
      const proposal = await call(
        'contractGenerator',
        record.inputSnapshot,
        contractProposalSchema,
        null,
      );
      record.contract = assembleContract(config, proposal, digestValue(record.inputSnapshot));
      record.contractDigest = digestValue(record.contract);
    }
    const contract = record.contract;
    const contractResult = await phase('contract-check', null, () => validateContract(contract));
    record.contractValidation = contractResult;
    await checkpoint();
    if (!contractResult.valid) throw new RunFailure('CONTRACT_INVALID', messages.CONTRACT_INVALID);
    if (!saved) {
      record.contractCheck = await call('contractChecker', { contract }, contractCheckSchema, null);
      await checkpoint();
      if (
        record.contractCheck.verdict !== 'pass' ||
        record.contractCheck.findings.some(
          (f) => f.blocking || f.role !== 'contractChecker' || !validateEvidence(contract, f),
        )
      )
        throw new RunFailure('CONTRACT_INVALID', messages.CONTRACT_INVALID);
    }
    for (let revision = 0; revision <= (saved ? 0 : config.limits.maxRepairs); revision++) {
      record.phase = revision ? 'repair' : 'generate';
      const previous = record.revisions.at(-1);
      const candidate: MissionCandidate = saved
        ? structuredClone(saved.revisions.at(-1)!.candidate)
        : await call(
            revision ? 'repairer' : 'storyGenerator',
            {
              contract,
              contractDigest: record.contractDigest,
              revision,
              references: record.inputSnapshot.references,
              ...(previous
                ? {
                    previous: repairContext(previous),
                    instruction:
                      '固定コントラクトを変更せず、指摘と機械検査の問題を修正してください。',
                  }
                : {}),
            },
            missionCandidateSchema,
            revision,
          );
      if (
        candidate.contractDigest !== record.contractDigest ||
        (!saved && candidate.revision !== revision)
      )
        throw new RunFailure('OUTPUT_INVALID', messages.OUTPUT_INVALID);
      const current: RevisionRecord = {
        candidate,
        digest: digestValue(candidate),
        mechanical: null,
        reviews: [],
        verification: null,
        verdict: null,
      };
      record.revisions.push(current);
      await checkpoint();
      record.phase = 'check';
      current.mechanical = await phase('mechanical', candidate.revision, () =>
        simulateWitness(contract, candidate),
      );
      await checkpoint();
      if (current.mechanical.checks.every((c) => c.status === 'pass')) {
        record.phase = 'review';
        // Immutable identical payload: previous rounds, repair instructions and peer findings are absent.
        const evidenceIndex = [
          { path: '/opening', excerpt: candidate.opening },
          { path: '/ending', excerpt: candidate.ending },
          ...candidate.obstacles.flatMap((o, i) => [
            { path: '/obstacles/' + i + '/description', excerpt: o.description },
            { path: '/obstacles/' + i + '/solutionExample', excerpt: o.solutionExample },
          ]),
          ...candidate.items.map((item, i) => ({
            path: '/items/' + i + '/initialPlacement',
            excerpt: item.initialPlacement,
          })),
          ...candidate.steps.flatMap((step, i) => [
            { path: '/steps/' + i + '/description', excerpt: step.description },
            { path: '/steps/' + i + '/timeRationale', excerpt: step.timeRationale },
          ]),
        ];
        const reviewInput = {
          contract,
          candidate,
          candidateDigest: current.digest,
          evidenceIndex: evidenceIndex
            .filter((entry) => !entry.path.endsWith('/timeRationale'))
            .map((entry) => ({ ...entry, excerpt: entry.excerpt.slice(0, 80) })),
        };
        await phase('parallel-reviews', candidate.revision, async () => {
          for (
            let offset = 0;
            offset < reviewerRoles.length;
            offset += config.limits.maxConcurrentReviews
          ) {
            const roles = reviewerRoles.slice(offset, offset + config.limits.maxConcurrentReviews);
            const results = await Promise.allSettled(
              roles.map(async (role) => {
                try {
                  const review = await call(
                    role,
                    structuredClone(reviewInput),
                    reviewSchema,
                    candidate.revision,
                  );
                  if (review.role !== role || review.candidateDigest !== current.digest)
                    throw new RunFailure('OUTPUT_INVALID', messages.OUTPUT_INVALID);
                  review.findings = review.findings.map((finding, i) => ({
                    ...finding,
                    role,
                    id: `${role}-${i + 1}`,
                  }));
                  current.reviews.push(review);
                } catch (error) {
                  deps.provider.budget.abort(error);
                  throw error;
                }
              }),
            );
            const failed = results.find((result) => result.status === 'rejected');
            if (failed?.status === 'rejected') throw failed.reason;
          }
        });
        await checkpoint();
        record.phase = 'verify';
        current.verification = await call(
          'verifier',
          { ...reviewInput, reviews: current.reviews },
          verificationSchema,
          candidate.revision,
        );
        current.verification.findings = current.verification.findings.map((finding, i) => ({
          ...finding,
          role: 'verifier',
          id: `verifier-${i + 1}`,
        }));
        await checkpoint();
        const verdict = deriveVerdict(
          candidate,
          current.mechanical,
          current.reviews,
          current.verification,
        );
        current.verdict = verdict;
        if (verdict.passed) {
          record.status = 'passed';
          break;
        }
        if (verdict.failureCode && verdict.failureCode !== 'STORY_REJECTED')
          throw new RunFailure(verdict.failureCode, messages[verdict.failureCode]);
      } else {
        current.verdict = deriveVerdict(candidate, current.mechanical, [], null);
        skip('parallel-reviews', candidate.revision, '機械検査に不合格のため省略');
        skip('verify', candidate.revision, '機械検査の不合格はAIが棄却できない');
      }
      if (revision === (saved ? 0 : config.limits.maxRepairs))
        throw new RunFailure('STORY_REJECTED', messages.STORY_REJECTED);
    }
  } catch (error) {
    record.status = 'failed';
    record.failureCode = errorCode(error);
    record.failureReason = messages[record.failureCode];
  } finally {
    deps.signal?.removeEventListener('abort', abort);
    record.phase = 'finished';
    record.endedAt = new Date().toISOString();
    record.durationMs = performance.now() - start;
    await checkpoint();
  }
  return record;
}
