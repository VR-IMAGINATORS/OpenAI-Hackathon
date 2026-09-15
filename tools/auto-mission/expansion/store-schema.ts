import { z } from 'zod';
import { scenarioSchema } from '../../../packages/shared/scenario.js';
import { digest, key } from './schemas.js';
import { pricingSchema } from './usage.js';
const text = z.string().max(2000);
export const evaluationConditionsSchema = z
  .object({
    sourceDigest: digest,
    candidateDigest: digest,
    revision: z.number().int().min(1),
    codeRevision: z.string().min(1).max(128),
    dirtyDigest: digest,
    configDigest: digest,
    promptDigests: z.record(z.string().min(1).max(128), digest),
    catalogDigest: digest,
    locale: z.enum(['ja', 'en']),
    rules: scenarioSchema.shape.rules,
    initiative: z.enum(['observations', 'hypotheses', 'suggestions']),
    selectedModels: z.record(z.string().min(1).max(128), z.string().min(1).max(128)),
  })
  .strict();
export type EvaluationConditions = z.infer<typeof evaluationConditionsSchema>;
export const playCheckpointSchema = z
  .object({
    playId: key,
    attemptId: z.string().uuid(),
    candidateDigest: digest,
    revision: z.number().int().min(1),
    conditionsDigest: digest,
    model: z.string().min(1).max(128),
    persona: key,
    status: z.enum(['running', 'cleared', 'uncleared', 'incomplete']),
    terminationReason: text.nullable(),
    turns: z.array(z.unknown()).max(25),
    disclosureTrace: z.array(z.unknown()).max(10000),
    ambienceTrace: z.array(z.unknown()).max(1000),
    stateVersions: z.array(z.unknown()).max(1000),
    callIds: z.array(z.string().uuid()).max(200),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.status !== 'running' && !v.terminationReason)
      ctx.addIssue({ code: 'custom', message: 'Terminal play requires a reason' });
  });
export type PlayCheckpoint = z.infer<typeof playCheckpointSchema>;
export const evaluationManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('mission-expansion'),
    runId: z.string().uuid(),
    mode: z.enum(['mock', 'live']),
    parentRunId: z.string().uuid().nullable(),
    conditions: evaluationConditionsSchema,
    pricingSnapshot: pricingSchema,
    stage: z.enum([
      'frozen',
      'expanding',
      'static_check',
      'pilot_running',
      'pilot_reported',
      'remaining_running',
      'reviewing',
      'ready_for_adoption',
      'adopted',
      'repairing',
      'awaiting_pilot',
      'incomplete',
      'rejected',
    ]),
    budgets: z
      .object({
        maxCostUsd: z.number().positive().nullable(),
        maxCalls: z.number().int().positive(),
        maxOutputTokens: z.number().int().positive(),
        deadlineMs: z.number().int().positive(),
      })
      .strict(),
    playMatrix: z
      .array(z.object({ playId: key, model: z.string().min(1).max(128), persona: key }).strict())
      .max(9),
    plays: z
      .array(
        z
          .object({
            playId: key,
            attemptId: z.string().uuid(),
            snapshotId: z.string().uuid(),
            digest,
            status: playCheckpointSchema.shape.status,
          })
          .strict(),
      )
      .max(100),
    callIds: z.array(z.string().uuid()).max(10000),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.mode === 'live' && m.budgets.maxCostUsd === null)
      ctx.addIssue({ code: 'custom', message: 'Live requires explicit cost limit' });
    if (
      new Set(m.callIds).size !== m.callIds.length ||
      new Set(m.playMatrix.map((p) => p.playId)).size !== m.playMatrix.length ||
      new Set(m.plays.map((p) => p.playId + ':' + p.attemptId)).size !== m.plays.length
    )
      ctx.addIssue({ code: 'custom', message: 'Duplicate manifest identity' });
    for (const p of m.plays)
      if (!m.playMatrix.some((row) => row.playId === p.playId))
        ctx.addIssue({ code: 'custom', message: 'Unknown matrix play' });
  });
export type EvaluationManifest = z.infer<typeof evaluationManifestSchema>;

export const generationDraftSchema = z
  .object(evaluationManifestSchema.shape)
  .strict()
  .omit({ kind: true, conditions: true, stage: true, plays: true })
  .safeExtend({
    kind: z.literal('mission-expansion-draft'),
    conditions: evaluationConditionsSchema.extend({ candidateDigest: z.null() }),
    stage: z.enum(['frozen', 'expanding', 'incomplete', 'rejected']),
  });
export type GenerationDraft = z.infer<typeof generationDraftSchema>;

export const executionSchema = z
  .object({
    id: z.string().uuid(),
    command: z.string().min(1).max(64),
    maxCostUsd: z.number().positive().nullable(),
    firstCallIndex: z.number().int().nonnegative(),
    lastCallIndex: z.number().int().nonnegative().nullable(),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().nullable(),
    status: z.enum(['running', 'completed', 'incomplete']),
  })
  .strict();
export type ExecutionRecord = z.infer<typeof executionSchema>;
