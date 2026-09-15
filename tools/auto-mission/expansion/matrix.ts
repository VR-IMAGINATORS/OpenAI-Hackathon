import { randomUUID } from 'node:crypto';
import type { AIResponsesClient } from '../../../apps/local-server/game-ai.js';
import type { ScenarioV2 } from '../../../packages/shared/scenario.js';
import type { ExpansionCandidate } from './schemas.js';
import type { ExpansionConfig, ExpansionInput } from './config.js';
import { type ExpansionStore, artifactDigest, conditionsDigest } from './store.js';
import type { PlayCheckpoint, EvaluationManifest } from './store-schema.js';
import { type ExpansionBudget, ExpansionLimitError } from './budget.js';
import { compileExpandedScenario } from './compile.js';
import { TextPlayAdapter } from './play-adapter.js';
import { requestPlayerTurn, playerPersonaSchema } from './player.js';
export interface PilotContext {
  input: ExpansionInput;
  candidate: ExpansionCandidate;
  compiled: ScenarioV2;
  store: ExpansionStore;
  budget: ExpansionBudget;
  /** Factory must meter both player and game calls and durably save them under this scope. */
  createClient(playId: string, scopeId?: string): AIResponsesClient;
  signal?: AbortSignal;
}
export type PlayMatrixRow = EvaluationManifest['playMatrix'][number];
export function createPlayMatrix(
  config: Pick<ExpansionConfig, 'playerModels' | 'personas'>,
): PlayMatrixRow[] {
  if (
    config.playerModels.length !== 3 ||
    config.personas.length !== 3 ||
    new Set(config.playerModels).size !== 3 ||
    new Set(config.personas).size !== 3
  )
    throw new Error('INVALID_PLAY_MATRIX');
  return config.playerModels.flatMap((model, m) =>
    config.personas.map((persona, p) => ({ playId: 'play-' + m + '-' + p, model, persona })),
  );
}
export function pilotRows(
  config: Pick<ExpansionConfig, 'playerModels' | 'personas'>,
): PlayMatrixRow[] {
  return createPlayMatrix(config).filter((row) => {
    const [, m, p] = row.playId.split('-');
    return m === p;
  });
}
export function remainingRows(
  config: Pick<ExpansionConfig, 'playerModels' | 'personas'>,
): PlayMatrixRow[] {
  const pilot = new Set(pilotRows(config).map((row) => row.playId));
  return createPlayMatrix(config).filter((row) => !pilot.has(row.playId));
}
function validateContext(context: PilotContext) {
  const { input, candidate, compiled, store } = context;
  const manifest = store.snapshot,
    conditions = manifest.conditions;
  if (
    artifactDigest(createPlayMatrix(input.config)) !== artifactDigest(manifest.playMatrix) ||
    artifactDigest(candidate) !== conditions.candidateDigest ||
    candidate.revision !== conditions.revision ||
    input.source.sourceDigest !== conditions.sourceDigest ||
    input.configDigest !== conditions.configDigest ||
    input.catalogDigest !== conditions.catalogDigest ||
    input.config.locale !== conditions.locale ||
    input.config.initiative !== conditions.initiative ||
    artifactDigest(input.promptDigests) !== artifactDigest(conditions.promptDigests) ||
    artifactDigest(compiled.rules) !== artifactDigest(conditions.rules) ||
    artifactDigest(compiled) !== artifactDigest(compileExpandedScenario(input.source, candidate)) ||
    conditions.selectedModels.game !== input.config.gameModel ||
    input.config.playerModels.some(
      (model, index) => conditions.selectedModels['player-' + index] !== model,
    )
  )
    throw new Error('SIMULATION_CONDITIONS_MISMATCH');
  if (
    !Number.isInteger(input.config.maxTurns) ||
    input.config.maxTurns < 1 ||
    input.config.maxTurns > 25
  )
    throw new Error('INVALID_TURN_LIMIT');
}
const complete = (play: PlayCheckpoint) => play.status === 'cleared' || play.status === 'uncleared';
function safeFailure(error: unknown): string {
  if (error instanceof ExpansionLimitError) return error.code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{1,100}$/.test(error.message)) return error.message;
  return 'SIMULATION_INCOMPLETE';
}
function terminalStatus(
  adapter: TextPlayAdapter,
): Pick<PlayCheckpoint, 'status' | 'terminationReason'> | null {
  if (adapter.game.status === 'won') return { status: 'cleared', terminationReason: 'cleared' };
  if (adapter.game.terminal)
    return { status: 'uncleared', terminationReason: adapter.game.endReason ?? 'game_ended' };
  return null;
}
/** One attempt always begins from fresh state. Completed turns are checkpointed atomically. */
export async function runPlay(context: PilotContext, row: PlayMatrixRow): Promise<PlayCheckpoint> {
  validateContext(context);
  const { input, store, budget } = context;
  const manifest = store.snapshot;
  if (!manifest.playMatrix.some((entry) => artifactDigest(entry) === artifactDigest(row)))
    throw new Error('UNKNOWN_PLAY');
  const attemptId = randomUUID(),
    scopeId = row.playId + '-' + attemptId;
  const firstCall = budget.calls.length;
  const record: PlayCheckpoint = {
    playId: row.playId,
    attemptId,
    candidateDigest: manifest.conditions.candidateDigest,
    revision: manifest.conditions.revision,
    conditionsDigest: conditionsDigest(manifest.conditions),
    model: row.model,
    persona: row.persona,
    status: 'running',
    terminationReason: null,
    turns: [],
    disclosureTrace: [],
    ambienceTrace: [],
    stateVersions: [],
    callIds: [],
  };
  await store.checkpointPlay(record);
  let adapter: TextPlayAdapter | undefined;
  const capture = (turn: number) => {
    if (!adapter) return;
    const diagnostics = adapter.diagnostics();
    record.stateVersions.push({
      turn,
      gameVersion: diagnostics.gameVersion,
      actionEpoch: diagnostics.actionEpoch,
      controllerEpoch: diagnostics.controllerEpoch,
      contextVersion: diagnostics.contextVersion,
      knowledgeVersion: diagnostics.knowledge.version,
      remainingMs: diagnostics.remainingMs,
      waitingRemainingMs: diagnostics.waitingRemainingMs,
      ...(turn === 0
        ? { measurementScope: diagnostics.measurementScope, opening: adapter.view().opening }
        : {}),
    });
    record.disclosureTrace.push(
      ...diagnostics.knowledge.reveals
        .filter((entry) => !record.disclosureTrace.some((saved: any) => saved.id === entry.id))
        .map((entry) => ({ ...entry, turn, knowledgeVersion: diagnostics.knowledge.version })),
    );
    record.ambienceTrace.push(
      ...diagnostics.knowledge.ambience
        .filter(
          (entry) => !record.ambienceTrace.some((saved: any) => saved.slotId === entry.slotId),
        )
        .map((entry) => ({ ...entry, turn })),
    );
  };
  try {
    context.signal?.throwIfAborted();
    const client = context.createClient(row.playId, scopeId);
    adapter = new TextPlayAdapter({
      scenario: context.compiled,
      coreConfig: { ...input.coreConfig, companionInitiative: input.config.initiative },
      locale: input.config.locale,
      gameModel: input.config.gameModel,
      catalog: input.config.objectCatalog,
      client,
      investigationPrompts: input.investigationPrompts,
    });
    capture(0);
    for (let index = 1; index <= input.config.maxTurns; index++) {
      context.signal?.throwIfAborted();
      if (budget.remainingMs({ revision: record.revision, playId: row.playId, scopeId }) <= 0)
        throw new ExpansionLimitError('PLAY_DEADLINE');
      const request = await requestPlayerTurn({
        client,
        model: row.model,
        persona: playerPersonaSchema.parse(row.persona),
        locale: input.config.locale,
        view: adapter.view(),
        prompts: input.playerPrompts,
        signal: context.signal,
      });
      const result = await adapter.turn(request, context.signal);
      const calls = budget.calls.slice(firstCall);
      // Real Runtime can provide a narration fallback; evaluation must still mark its failed API incomplete.
      if (calls.some((call) => call.status !== 'completed'))
        throw new ExpansionLimitError('GAME_API_INCOMPLETE');
      const diagnostics = adapter.diagnostics();
      record.turns.push({
        id: row.playId + '-turn-' + index,
        index,
        playerRequest: result.request,
        publicReply: result.publicReply,
        committedPublicEvents: result.committedPublicEvents,
        publicStateBefore: result.publicStateBefore,
        publicStateAfter: result.publicStateAfter,
        privateDiagnostics: {
          actions: diagnostics.actions,
          knowledgeVersion: diagnostics.knowledge.version,
        },
      });
      capture(index);
      record.callIds = calls.map((call) => call.callId);
      const terminal = terminalStatus(adapter);
      if (terminal) Object.assign(record, terminal);
      else if (index === input.config.maxTurns) {
        record.status = 'uncleared';
        record.terminationReason = 'turn_limit';
      }
      await store.checkpointPlay(record);
      if (record.status !== 'running') break;
    }
  } catch (error) {
    record.status = 'incomplete';
    record.terminationReason = safeFailure(error);
    record.callIds = budget.calls.slice(firstCall).map((call) => call.callId);
    capture(record.turns.length);
    await store.checkpointPlay(record);
  } finally {
    adapter?.close();
  }
  return structuredClone(record);
}
async function runRows(context: PilotContext, rows: PlayMatrixRow[]) {
  for (const row of rows) {
    const previous = (await context.store.readPlays()).filter((play) => play.playId === row.playId);
    if (previous.some(complete)) continue;
    if (previous.length) throw new Error('RETRY_REQUIRED');
    const result = await runPlay(context, row);
    if (result.status === 'incomplete') {
      await context.store.setStage('incomplete');
      return false;
    }
  }
  return true;
}
export async function pilot(context: PilotContext): Promise<void> {
  validateContext(context);
  if (
    !['static_check', 'pilot_running', 'pilot_reported', 'awaiting_pilot'].includes(
      context.store.snapshot.stage,
    )
  )
    throw new Error('PILOT_STAGE_INVALID');
  await context.store.setStage('pilot_running');
  if (await runRows(context, pilotRows(context.input.config)))
    await context.store.setStage('pilot_reported');
}
export async function remaining(context: PilotContext): Promise<void> {
  validateContext(context);
  if (!['pilot_reported', 'remaining_running'].includes(context.store.snapshot.stage))
    throw new Error('REMAINING_STAGE_INVALID');
  const plays = await context.store.readPlays();
  if (
    pilotRows(context.input.config).some(
      (row) => !plays.some((play) => play.playId === row.playId && complete(play)),
    )
  )
    throw new Error('PILOT_INCOMPLETE');
  if (
    plays.some(
      (play) =>
        play.status === 'incomplete' &&
        !plays.some((other) => other.playId === play.playId && complete(other)),
    )
  )
    throw new Error('RETRY_REQUIRED');
  await context.store.setStage('remaining_running');
  if (await runRows(context, remainingRows(context.input.config)))
    await context.store.setStage('reviewing');
}
export async function retryPlay(context: PilotContext, playId: string): Promise<void> {
  validateContext(context);
  const row = createPlayMatrix(context.input.config).find((row) => row.playId === playId);
  const previous = (await context.store.readPlays()).filter((play) => play.playId === playId);
  if (!row || !previous.length || previous.some((play) => play.status !== 'incomplete'))
    throw new Error('RETRY_REQUIRES_INCOMPLETE_PLAY');
  const result = await runPlay(context, row);
  if (result.status === 'incomplete') {
    await context.store.setStage('incomplete');
    return;
  }
  const completed = await context.store.reusablePlays();
  const all = createPlayMatrix(context.input.config).every((entry) =>
    completed.some((play) => play.playId === entry.playId),
  );
  const allPilot = pilotRows(context.input.config).every((entry) =>
    completed.some((play) => play.playId === entry.playId),
  );
  await context.store.setStage(all ? 'reviewing' : allPilot ? 'pilot_reported' : 'awaiting_pilot');
}
