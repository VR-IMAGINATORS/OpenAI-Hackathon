import { randomInt } from 'node:crypto';
import { z } from 'zod';
import type { ScenarioSnapshot } from '../server/scenario-catalog.js';
import type { IntentContext } from './conversation.js';
import type { PublicGameState } from '../../packages/shared/game.js';
import { inferenceSchema } from '../../packages/shared/harness.js';
import { buildCompanionContext, type KnowledgeStore } from './companion-knowledge.js';
import { requestsStoryHint, storyHint } from './story.js';
import { harnessResponse } from './harness-decisions.js';

const selectionWireSchema = z
  .object({
    scope: z.enum(['overview', 'detail', 'hint', 'other']),
    ids: z.array(z.string().min(1).max(64)).max(100),
    ambienceSlotIds: z.array(z.string().min(1).max(64)).max(30),
  })
  .strict();
const selectionSchema = selectionWireSchema.extend({
  scope: selectionWireSchema.shape.scope.default('detail'),
  ambienceSlotIds: selectionWireSchema.shape.ambienceSlotIds.default([]),
});
const replyWireSchema = z
  .object({
    answer: z.string().trim().min(1).max(2000),
    inferences: z.array(inferenceSchema.omit({ updatedAtVersion: true })).max(5),
  })
  .strict();
const replySchema = replyWireSchema.extend({
  inferences: replyWireSchema.shape.inferences.default([]),
});
interface InvestigationOptions {
  snapshot: ScenarioSnapshot;
  knowledge: KnowledgeStore;
  context: IntentContext;
  model: string;
  respond(body: unknown): Promise<unknown>;
  validate?(): void;
}
export function investigationRequest(context: IntentContext): string {
  const eligible = new Set(context.eligibleEvidenceSeq);
  return context.fragments
    .filter((part) => part.speaker === 'user' && eligible.has(part.serverSeq))
    .map((part) => part.delta)
    .join('');
}
export function explicitlyRequestsHypothesis(context: IntentContext): boolean {
  return /仮説|推測(?:して|を|が)|どう思う|hypothes|speculat|what do you think/i.test(
    investigationRequest(context),
  );
}
/** The selector sees cues and authority-free metadata, never hidden body text. */
export async function selectInvestigation(options: InvestigationOptions) {
  options.validate?.();
  const explicitHint = requestsStoryHint(options.context);
  const batch = options.knowledge.eligibleRevealCandidates();
  const candidates = batch.candidates.filter((entry) => entry.layer !== 'hint');
  const slots = options.knowledge.availableAmbienceSlots();
  if (explicitHint) return { scope: 'hint' as const, ids: [], ambienceSlotIds: [] };
  if (!candidates.length && !slots.length)
    return { scope: 'other' as const, ids: [], ambienceSlotIds: [] };
  const value = await harnessResponse(
    { respond: options.respond, model: options.model, locale: options.snapshot.locale },
    selectionSchema,
    'knowledge_selection',
    options.knowledge.prompts.selection,
    {
      request: investigationRequest(options.context),
      explicitHint,
      candidates: candidates.map(({ id, targetId, layer, requestCue }) => ({
        id,
        targetId,
        layer,
        requestCue,
      })),
      ambienceSlots: slots.map(({ id, targetId, attribute }) => ({ id, targetId, attribute })),
    },
    selectionWireSchema,
  );
  options.validate?.();
  const allowed = new Map(candidates.map((entry) => [entry.id, entry]));
  const slotIds = new Set(slots.map((entry) => entry.id));
  if (
    new Set(value.ids).size !== value.ids.length ||
    new Set(value.ambienceSlotIds).size !== value.ambienceSlotIds.length ||
    value.ids.some((id) => !allowed.has(id)) ||
    value.ambienceSlotIds.some((id) => !slotIds.has(id))
  )
    throw new Error('INVESTIGATION_SELECTION_INVALID');
  // A model cannot turn a denied hint into permission or dump details for a broad request.
  if (value.scope === 'hint') return { scope: 'other' as const, ids: [], ambienceSlotIds: [] };
  return {
    ...value,
    ids:
      value.scope === 'overview'
        ? value.ids.filter((id) => allowed.get(id)!.layer === 'overview')
        : value.scope === 'other'
          ? []
          : value.ids,
    ambienceSlotIds: value.scope === 'detail' ? value.ambienceSlotIds : [],
  };
}

/** Mutates only the caller's draft; the common harness/classifier commits it after all guards pass. */
export async function resolveConsultation(
  options: InvestigationOptions & {
    state: PublicGameState;
    initialAnswer: string;
    obstacleIndex: number;
    hintsAlreadyGiven: number;
  },
) {
  const selection = await selectInvestigation(options);
  options.validate?.();
  const stagedHint =
    selection.scope === 'hint'
      ? storyHint(
          options.snapshot,
          options.obstacleIndex,
          options.context,
          options.hintsAlreadyGiven,
          options.knowledge,
        )
      : undefined;
  const before = options.knowledge.snapshot().version;
  if (selection.ids.length && !options.knowledge.applyReveals(selection.ids, before))
    throw new Error('INVESTIGATION_STALE');
  for (const slotId of selection.ambienceSlotIds) {
    if (options.knowledge.snapshot().ambience.some((entry) => entry.slotId === slotId)) continue;
    const slot = options.knowledge.availableAmbienceSlots().find((slot) => slot.id === slotId)!;
    if (
      !options.knowledge.addAmbience(
        slotId,
        randomInt(slot.allowedValues.length),
        options.knowledge.snapshot().version,
        options.context.generation + ':' + options.context.eligibleEvidenceSeq.at(-1),
      )
    )
      throw new Error('AMBIENCE_INVALID');
  }
  const profile = options.snapshot.scenarioV2.investigation;
  // Legacy consultations without a disclosure keep the original short response.
  if (!profile && !stagedHint && !selection.ids.length && !selection.ambienceSlotIds.length)
    return { answer: options.initialAnswer, inferences: undefined };
  options.validate?.();
  const initiative = options.snapshot.coreConfig.companionInitiative;
  const value = await harnessResponse(
    { respond: options.respond, model: options.model, locale: options.snapshot.locale },
    replySchema,
    'investigation_reply',
    [options.knowledge.prompts.response, options.knowledge.prompts[initiative]].join('\n'),
    {
      request: investigationRequest(options.context),
      scope: selection.scope,
      explicitHint: requestsStoryHint(options.context),
      stagedHint: stagedHint ?? null,
      publicContext: buildCompanionContext(options.snapshot, options.knowledge, options.state),
    },
    replyWireSchema,
  );
  options.validate?.();
  const answer = stagedHint
    ? appendHint(value.answer, stagedHint.hint, options.snapshot.locale)
    : value.answer;
  return {
    answer,
    inferences:
      initiative !== 'observations' || explicitlyRequestsHypothesis(options.context)
        ? value.inferences
        : [],
  };
}

function appendHint(answer: string, hint: string, locale: 'ja' | 'en') {
  if (answer.includes(hint)) return answer;
  return `${answer}\n\n${locale === 'ja' ? 'ヒント' : 'Hint'}: ${hint}`;
}
