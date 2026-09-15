import { config as loadEnv } from 'dotenv';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AIResponsesClient } from '../../../apps/local-server/game-ai.js';
import type { ScenarioV2 } from '../../../packages/shared/scenario.js';
import { loadExpansionConfig, codeIdentity, type ExpansionInput } from './config.js';
import { generateCandidate, mockGeneratorClient, GeneratorValidationError } from './generator.js';
import { ExpansionBudget, EXPANSION_LIMITS, MeasuredResponsesClient } from './budget.js';
import { EXPANSION_PRICING, summarizeUsage, predictRemainingCost } from './usage.js';
import { createMockPlayClient } from './player.js';
import { ExpansionStore, artifactDigest } from './store.js';
import type { ExpansionCandidate } from './schemas.js';
import type { EvaluationManifest } from './store-schema.js';
export interface PilotContext {
  input: ExpansionInput;
  candidate: ExpansionCandidate;
  compiled: ScenarioV2;
  store: ExpansionStore;
  budget: ExpansionBudget;
  createClient: (playId: string, scopeId?: string) => AIResponsesClient;
  signal?: AbortSignal;
}
export interface ExpansionCliDeps {
  pilot?: (context: PilotContext) => Promise<void>;
  continueRun?: (options: ExpansionCliOptions, signal?: AbortSignal) => Promise<number>;
  render?: (input: string) => Promise<void>;
  adopt?: (input: string, revision: number) => Promise<void>;
  client?: AIResponsesClient;
  playClient?: () => AIResponsesClient;
  outputRoot?: string;
  codeIdentity?: typeof codeIdentity;
  log?: (message: string) => void;
}
const commands = [
  'expand',
  'expand-continue',
  'expand-retry',
  'expand-pilot',
  'expand-render',
  'expand-adopt',
] as const;
export interface ExpansionCliOptions {
  command: (typeof commands)[number];
  config?: string;
  input?: string;
  mode?: 'mock' | 'live';
  maxCostUsd?: number;
  play?: string;
  revision?: number;
}
export function parseExpansionArgs(args: string[]): ExpansionCliOptions {
  const [command, ...rest] = args;
  if (!commands.includes(command as (typeof commands)[number]))
    throw new Error('UNKNOWN_EXPANSION_COMMAND');
  const values = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i]!;
    if (
      ![
        '--config',
        '--input',
        '--mock',
        '--live',
        '--max-cost-usd',
        '--play',
        '--revision',
      ].includes(key) ||
      values.has(key)
    )
      throw new Error('INVALID_OR_DUPLICATE_ARGUMENT');
    if (key === '--mock' || key === '--live') values.set(key, true);
    else {
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new Error('MISSING_ARGUMENT_VALUE');
      values.set(key, value);
    }
  }
  const opts: ExpansionCliOptions = { command: command as ExpansionCliOptions['command'] };
  const number = (key: string, integer = false) => {
    const raw = values.get(key);
    if (
      typeof raw !== 'string' ||
      !(integer ? /^[1-9][0-9]*$/ : /^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/).test(raw)
    )
      throw new Error('INVALID_NUMERIC_ARGUMENT');
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value)))
      throw new Error('INVALID_NUMERIC_ARGUMENT');
    return value;
  };
  const isRead = command === 'expand-render' || command === 'expand-adopt';
  if (isRead) {
    if (values.has('--live') || values.has('--mock') || values.has('--max-cost-usd'))
      throw new Error('READ_COMMAND_MODE_INVALID');
  } else {
    if (values.has('--live') === values.has('--mock')) throw new Error('EXACTLY_ONE_MODE_REQUIRED');
    opts.mode = values.has('--live') ? 'live' : 'mock';
    if (opts.mode === 'live' && !values.has('--max-cost-usd'))
      throw new Error('EXPLICIT_COST_LIMIT_REQUIRED');
  }
  if (values.has('--max-cost-usd')) opts.maxCostUsd = number('--max-cost-usd');
  const allowed =
    command === 'expand'
      ? ['--config', '--mock', '--live', '--max-cost-usd']
      : command === 'expand-render'
        ? ['--input']
        : command === 'expand-adopt'
          ? ['--input', '--revision']
          : command === 'expand-retry'
            ? ['--input', '--play', '--mock', '--live', '--max-cost-usd']
            : ['--input', '--mock', '--live', '--max-cost-usd'];
  if ([...values.keys()].some((key) => !allowed.includes(key)))
    throw new Error('ARGUMENT_COMBINATION_INVALID');
  if (command === 'expand') {
    const path = values.get('--config');
    if (typeof path !== 'string') throw new Error('CONFIG_REQUIRED');
    opts.config = path;
  } else {
    const input = values.get('--input');
    if (typeof input !== 'string') throw new Error('INPUT_REQUIRED');
    opts.input = input;
  }
  if (command === 'expand-adopt') opts.revision = number('--revision', true);
  if (command === 'expand-retry') {
    const play = values.get('--play');
    if (typeof play !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(play))
      throw new Error('PLAY_ID_REQUIRED');
    opts.play = play;
  }
  return opts;
}
export function liveExpansionClient(
  apiKey: string,
  transport: typeof fetch = fetch,
): AIResponsesClient {
  return {
    respond: async (body, signal) => {
      if (!apiKey) throw new Error('CREDENTIALS_REQUIRED');
      const response = await transport('https://api.openai.com/v1/responses', {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('UPSTREAM_HTTP_ERROR');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('EMPTY_RESPONSE');
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (size > 2 * 1024 * 1024) throw new Error('RESPONSE_TOO_LARGE');
          chunks.push(next.value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
  };
}
export async function expansionMain(args: string[], deps: ExpansionCliDeps = {}): Promise<number> {
  const log = deps.log ?? console.log;
  let draft: Awaited<ReturnType<typeof ExpansionStore.createDraft>> | undefined;
  let store: ExpansionStore | undefined;
  const controller = new AbortController(),
    interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  try {
    const options = parseExpansionArgs(args);
    if (options.command === 'expand-render') {
      if (!deps.render) throw new Error('RENDER_INTEGRATION_PENDING');
      await deps.render(options.input!);
      log('Saved expansion report rendered.');
      return 0;
    }
    if (options.command === 'expand-adopt') {
      if (!deps.adopt) throw new Error('ADOPTION_INTEGRATION_PENDING');
      await deps.adopt(options.input!, options.revision!);
      return 0;
    }
    if (options.command !== 'expand') {
      if (!deps.continueRun) throw new Error('CONTINUATION_INTEGRATION_PENDING');
      return await deps.continueRun(options, controller.signal);
    }
    const input = await loadExpansionConfig(options.config!);
    const identity = await (deps.codeIdentity ?? codeIdentity)();
    if (options.mode === 'live' && !deps.client) loadEnv({ path: '.env.local', quiet: true });
    const rawClient =
      deps.client ??
      (options.mode === 'mock'
        ? mockGeneratorClient(input.source)
        : liveExpansionClient(process.env.OPENAI_API_KEY ?? ''));
    if (options.mode === 'live' && !deps.client && !process.env.OPENAI_API_KEY)
      throw new Error('CREDENTIALS_REQUIRED');
    const limits = EXPANSION_LIMITS.pilot;
    const budget = new ExpansionBudget({
      mode: options.mode!,
      maxCostUsd: options.maxCostUsd,
      pricing: EXPANSION_PRICING,
      limits,
    });
    budget.addScope('static', EXPANSION_LIMITS.static);
    const manifest: EvaluationManifest = {
      schemaVersion: 1,
      kind: 'mission-expansion',
      runId: randomUUID(),
      mode: options.mode!,
      parentRunId: null,
      conditions: {
        sourceDigest: input.source.sourceDigest,
        candidateDigest: '0'.repeat(64),
        revision: 1,
        ...identity,
        configDigest: input.configDigest,
        promptDigests: input.promptDigests,
        catalogDigest: input.catalogDigest,
        locale: input.config.locale,
        rules: input.source.compiledOriginal.rules,
        initiative: input.config.initiative,
        selectedModels: {
          generator: input.config.generator.model,
          game: input.config.gameModel,
          ...Object.fromEntries(
            input.config.playerModels.map((model, index) => ['player-' + index, model]),
          ),
        },
      },
      pricingSnapshot: EXPANSION_PRICING,
      stage: 'frozen',
      budgets: {
        maxCostUsd: options.maxCostUsd ?? null,
        maxCalls: limits.maxCalls,
        maxOutputTokens: limits.maxOutputTokens,
        deadlineMs: limits.deadlineMs,
      },
      playMatrix: input.config.playerModels.flatMap((model, m) =>
        input.config.personas.map((persona, p) => ({
          playId: 'play-' + m + '-' + p,
          model,
          persona,
        })),
      ),
      plays: [],
      callIds: [],
    };
    draft = await ExpansionStore.createDraft(
      resolve(deps.outputRoot ?? 'runs/mission-expansion'),
      manifest,
      input.source,
    );
    await draft.saveInput(input);
    const generationClient = new MeasuredResponsesClient(
      rawClient,
      budget,
      () => ({ revision: 1, scopeId: 'static' }),
      (record) => draft!.saveCall(record),
    );
    const generated = await generateCandidate(input, generationClient, controller.signal);
    store = await draft.finalize(generated.candidate);
    await store.saveEvaluation({
      stage: 'static_check',
      mode: options.mode,
      mechanicalPreservation: 'passed',
      semanticEvaluation: 'not_run',
      candidateDigest: artifactDigest(generated.candidate),
    });
    log(
      options.mode!.toUpperCase() +
        ' static preservation checked; semantic/real-AI validation is not implied.',
    );
    log('Manifest: ' + join(store.directory, 'manifest.json'));
    if (!deps.pilot) {
      await store.setStage('incomplete');
      log('PILOT_INTEGRATION_PENDING: candidate saved; no pilot completion claimed.');
      return 2;
    }
    const scopes = new Set<string>();
    await store.setStage('pilot_running');
    await deps.pilot({
      input,
      ...generated,
      store,
      budget,
      createClient: (playId, scopeId = playId) => {
        if (!scopes.has(scopeId)) {
          budget.addScope(scopeId, EXPANSION_LIMITS.play);
          scopes.add(scopeId);
        }
        return new MeasuredResponsesClient(
          deps.playClient?.() ?? (options.mode === 'mock' ? createMockPlayClient() : rawClient),
          budget,
          () => ({ revision: 1, playId, scopeId }),
          (record) => store!.saveCall(record),
        );
      },
      signal: controller.signal,
    });
    if (store.snapshot.stage === 'rejected') {
      await deps.render?.(join(store.directory, 'manifest.json'));
      log('rejected: confirmed feasibility defect; no adoption.');
      return 1;
    }
    const plays = await store.reusablePlays();
    const expected = input.config.playerModels.map((_, i) => 'play-' + i + '-' + i);
    if (
      store.snapshot.stage !== 'pilot_reported' ||
      plays.length !== 3 ||
      expected.some((id) => !plays.some((play) => play.playId === id))
    )
      throw new Error('PILOT_INCOMPLETE');
    const calls = await store.readCalls();
    log(JSON.stringify(summarizeUsage(calls)));
    log(
      JSON.stringify({
        remainingCost: predictRemainingCost(
          plays.map((play) => ({
            model: play.model,
            status: play.status,
            calls: calls.filter((call) => call.playId === play.playId),
          })),
          store.snapshot.playMatrix
            .filter((row) => !expected.includes(row.playId))
            .map((row) => row.model),
        ),
      }),
    );
    await deps.render?.(join(store.directory, 'manifest.json'));
    log('pilot_reported: stopped after 3 plays; remaining 6 require explicit continuation.');
    return 0;
  } catch (error) {
    if (error instanceof GeneratorValidationError && draft && !store) {
      await draft
        .saveDiagnostic({ failure: 'GENERATION_REJECTED', output: error.output })
        .catch(() => {});
      await draft.fail('rejected').catch(() => {});
      log('GENERATION_REJECTED: no pilot ran. Draft: ' + join(draft.directory, 'draft.json'));
      try {
        await deps.render?.(join(draft.directory, 'draft.json'));
      } catch {
        log('REPORT_FAILED');
        return 2;
      }
      return 1;
    }
    if (store) await store.setStage('incomplete').catch(() => {});
    else if (draft) await draft.fail('incomplete').catch(() => {});
    const safe =
      error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
        ? error.message
        : 'EXPANSION_FAILED';
    log(safe);
    if (draft && !store) log('Draft: ' + join(draft.directory, 'draft.json'));
    if (store || draft)
      try {
        await deps.render?.(
          join((store ?? draft)!.directory, store ? 'manifest.json' : 'draft.json'),
        );
      } catch {
        log('REPORT_FAILED');
      }
    return 2;
  } finally {
    process.removeListener('SIGINT', interrupt);
  }
}
