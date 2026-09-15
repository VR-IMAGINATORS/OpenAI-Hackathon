import { config as loadEnv } from 'dotenv';
import { basename, dirname, join, resolve } from 'node:path';
import {
  expansionMain,
  liveExpansionClient,
  type ExpansionCliOptions,
  type PilotContext,
} from './cli.js';
import {
  pilot,
  remaining,
  retryPlay,
  pilotRows,
  remainingRows,
  createPlayMatrix,
} from './matrix.js';
import { createMockPlayClient } from './player.js';
import { evaluateCandidate, validateEvaluationForAdoption } from './evaluate.js';
import { repairCandidate } from './repair.js';
import { renderSavedExpansion } from './report.js';
import { adoptExpansion } from './adopt.js';
import { ExpansionStore, conditionsDigest, artifactDigest } from './store.js';
import { ExpansionBudget, EXPANSION_LIMITS, MeasuredResponsesClient } from './budget.js';
import { summarizeUsage, predictRemainingCost } from './usage.js';
import { parseSavedExpansionInput, readExpansionText, codeIdentity } from './config.js';
import { compileExpandedScenario } from './compile.js';
import type { AIResponsesClient } from '../../../apps/local-server/game-ai.js';
async function evaluationClient(mode: 'mock' | 'live'): Promise<AIResponsesClient> {
  if (mode === 'live') return liveExpansionClient(process.env.OPENAI_API_KEY ?? '');
  const module = await import('./evaluate.js');
  const factory = (module as unknown as { createMockEvaluationClient?: () => AIResponsesClient })
    .createMockEvaluationClient;
  if (!factory) throw new Error('MOCK_EVALUATION_INTEGRATION_PENDING');
  return factory();
}
/** A candidate revision is evaluated independently; a repaired candidate never starts itself. */
export async function evaluateAndStop(
  context: PilotContext,
  client?: AIResponsesClient,
): Promise<void> {
  const { input, store, budget, candidate } = context;
  const raw = client ?? (await evaluationClient(store.snapshot.mode));
  const plays = await store.reusablePlays();
  const record = await evaluateCandidate({
    source: input.source,
    candidate,
    conditions: store.snapshot.conditions,
    plays,
    client: raw,
    budget,
    checkpoint: (call) => store.saveCall(call),
    prompts: input.evaluationPrompts,
    signal: context.signal,
  });
  await store.saveEvaluation(record);
  if (record.status !== 'complete') {
    await store.setStage('incomplete');
    return;
  }
  const defects = record.verifiedFindings.filter(
    (f) => f.classification === 'confirmed_scenario_defect' && f.blocking,
  );
  if (defects.length) {
    await store.setStage('rejected');
    if (candidate.revision < 3 && defects.some((f) => f.repairable)) {
      const repaired = await repairCandidate({
        root: dirname(store.directory),
        source: input.source,
        candidate,
        manifest: store.snapshot,
        evaluation: record,
        plays,
        client: raw,
        budget,
        prompt: input.evaluationPrompts.repair,
        signal: context.signal,
      });
      await repaired.store.saveInputSnapshot(input);
      await renderSavedExpansion(join(repaired.store.directory, 'manifest.json'));
      console.log(
        'awaiting_pilot: revised candidate saved; start explicitly with expand-pilot --input ' +
          join(repaired.store.directory, 'manifest.json'),
      );
    }
    return;
  }
  if (record.verifiedFindings.some((f) => f.blocking || f.classification !== 'player_miss')) {
    await store.setStage('incomplete');
    return;
  }
  if (plays.length === 9) {
    validateEvaluationForAdoption(record, {
      source: input.source,
      candidate,
      candidateDigest: artifactDigest(candidate),
      conditionsDigest: conditionsDigest(store.snapshot.conditions),
      plays,
      expectedPlayIds: createPlayMatrix(input.config).map((r) => r.playId),
    });
    await store.setStage('ready_for_adoption');
  } else if (plays.length === 3) {
    await store.setStage('pilot_reported');
  } else throw new Error('EVALUATION_PLAY_COUNT_INVALID');
}
export interface ContinuationDeps {
  codeIdentity?: typeof codeIdentity;
  client?: AIResponsesClient;
  evaluationClient?: AIResponsesClient;
  render?: (path: string) => Promise<void>;
  log?: (message: string) => void;
}
export async function continueExpansion(
  options: ExpansionCliOptions,
  signal?: AbortSignal,
  deps: ContinuationDeps = {},
): Promise<number> {
  const log = deps.log ?? console.log;
  let store: ExpansionStore | undefined;
  let execution: string | undefined;
  let result = 2;
  try {
    if (!options.input || basename(options.input) !== 'manifest.json' || !options.mode)
      throw new Error('CONTINUATION_INPUT_INVALID');
    const data = await ExpansionStore.readOnly(options.input);
    if (data.manifest.mode !== options.mode) throw new Error('MODE_MISMATCH');
    const input = parseSavedExpansionInput(
      JSON.parse(await readExpansionText(join(data.directory, 'input.json'), 16 * 1024 * 1024)),
    );
    const identity = await (deps.codeIdentity ?? codeIdentity)();
    const expected = {
      ...data.manifest.conditions,
      ...identity,
      sourceDigest: input.source.sourceDigest,
      configDigest: input.configDigest,
      promptDigests: input.promptDigests,
      catalogDigest: input.catalogDigest,
      locale: input.config.locale,
      initiative: input.config.initiative,
      rules: input.source.compiledOriginal.rules,
      selectedModels: {
        generator: input.config.generator.model,
        game: input.config.gameModel,
        ...Object.fromEntries(input.config.playerModels.map((model, i) => ['player-' + i, model])),
      },
    };
    if (conditionsDigest(expected) !== conditionsDigest(data.manifest.conditions))
      throw new Error('CONTINUATION_CONDITIONS_MISMATCH');
    const unresolved = data.plays
      .filter((p) => p.status === 'incomplete' || p.status === 'running')
      .filter(
        (p) =>
          !data.plays.some(
            (other) => other.playId === p.playId && ['cleared', 'uncleared'].includes(other.status),
          ),
      );
    const completedIds = new Set(
      data.plays.filter((p) => ['cleared', 'uncleared'].includes(p.status)).map((p) => p.playId),
    );
    const missingEvaluation =
      data.evaluation === null || (data.evaluation as { status?: string }).status === 'incomplete';
    const recoverEvaluation =
      data.manifest.stage === 'incomplete' &&
      missingEvaluation &&
      [3, 9].includes(completedIds.size) &&
      pilotRows(input.config).every((row) => completedIds.has(row.playId));
    if (
      options.command === 'expand-continue' &&
      ((!['pilot_reported', 'remaining_running', 'reviewing'].includes(data.manifest.stage) &&
        !recoverEvaluation) ||
        unresolved.length)
    )
      throw new Error('PILOT_OR_RETRY_REQUIRED');
    if (options.command === 'expand-pilot' && data.manifest.stage !== 'awaiting_pilot')
      throw new Error('AWAITING_PILOT_REQUIRED');
    if (
      options.command === 'expand-retry' &&
      (!options.play || !unresolved.some((p) => p.playId === options.play))
    )
      throw new Error('INCOMPLETE_PLAY_REQUIRED');
    if (options.mode === 'live' && !deps.client) loadEnv({ path: '.env.local', quiet: true });
    if (options.mode === 'live' && !deps.client && !process.env.OPENAI_API_KEY)
      throw new Error('CREDENTIALS_REQUIRED');
    store = await ExpansionStore.resume(options.input, expected);
    const limits =
      options.command === 'expand-continue'
        ? EXPANSION_LIMITS.remaining
        : options.command === 'expand-retry'
          ? EXPANSION_LIMITS.play
          : EXPANSION_LIMITS.pilot;
    const budget = new ExpansionBudget({
      mode: options.mode,
      maxCostUsd: options.maxCostUsd,
      pricing: data.manifest.pricingSnapshot,
      limits,
    });
    execution = await store.beginExecution(options.command, options.maxCostUsd ?? null);
    const scopes = new Set<string>();
    const context: PilotContext = {
      input,
      candidate: data.candidate,
      compiled: compileExpandedScenario(data.source, data.candidate),
      store,
      budget,
      createClient: (playId, scopeId = playId) => {
        if (!scopes.has(scopeId)) {
          budget.addScope(scopeId, EXPANSION_LIMITS.play);
          scopes.add(scopeId);
        }
        return new MeasuredResponsesClient(
          deps.client ??
            (options.mode === 'mock'
              ? createMockPlayClient()
              : liveExpansionClient(process.env.OPENAI_API_KEY ?? '')),
          budget,
          () => ({ revision: data.candidate.revision, playId, scopeId }),
          (call) => store!.saveCall(call),
        );
      },
      signal,
    };
    if (options.command === 'expand-continue') {
      // A failed review never causes completed plays to run again.
      if (completedIds.size === 9) {
        await evaluateAndStop(context, deps.evaluationClient);
      } else {
        if (completedIds.size === 3 && missingEvaluation)
          await evaluateAndStop(context, deps.evaluationClient);
        if (['pilot_reported', 'remaining_running'].includes(store.snapshot.stage)) {
          await remaining(context);
          if (store.snapshot.stage === 'reviewing')
            await evaluateAndStop(context, deps.evaluationClient);
        }
      }
    } else if (options.command === 'expand-retry') {
      await retryPlay(context, options.play!);
      if (['reviewing', 'pilot_reported'].includes(store.snapshot.stage))
        await evaluateAndStop(context, deps.evaluationClient);
    } else if (options.command === 'expand-pilot') {
      await pilot(context);
      if (store.snapshot.stage === 'pilot_reported')
        await evaluateAndStop(context, deps.evaluationClient);
    } else throw new Error('UNSUPPORTED_CONTINUATION');
    const calls = await store.readCalls(),
      plays = await store.reusablePlays();
    log(
      JSON.stringify({
        stage: store.snapshot.stage,
        additionalExecution: budget.snapshot(),
        cumulative: summarizeUsage(calls),
        remainingCost:
          store.snapshot.stage === 'pilot_reported'
            ? predictRemainingCost(
                plays.map((p) => ({
                  model: p.model,
                  status: p.status,
                  calls: calls.filter((c) => c.playId === p.playId),
                })),
                remainingRows(input.config).map((r) => r.model),
              )
            : null,
      }),
    );
    result =
      store.snapshot.stage === 'rejected'
        ? 1
        : ['pilot_reported', 'ready_for_adoption', 'awaiting_pilot'].includes(store.snapshot.stage)
          ? 0
          : 2;
  } catch (error) {
    if (store) await store.setStage('incomplete').catch(() => {});
    log(
      error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
        ? error.message
        : 'CONTINUATION_FAILED',
    );
  } finally {
    if (store && execution)
      try {
        await store.finishExecution(execution, result === 2 ? 'incomplete' : 'completed');
      } catch {
        log('EXECUTION_CHECKPOINT_FAILED');
        result = 2;
      }
    if (store)
      try {
        await (deps.render ?? renderSavedExpansion)(join(store.directory, 'manifest.json'));
      } catch {
        log('REPORT_FAILED');
        result = 2;
      }
  }
  return result;
}
export function defaultExpansionMain(args: string[]): Promise<number> {
  return expansionMain(args, {
    pilot: async (context) => {
      await pilot(context);
      if (context.store.snapshot.stage === 'pilot_reported') await evaluateAndStop(context);
    },
    continueRun: continueExpansion,
    render: renderSavedExpansion,
    adopt: adoptExpansion,
  });
}
