import { z } from 'zod';

const id = z.string().trim().min(1).max(128);
const key = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const text = z.string().trim().min(1).max(2000);
const localized = z.object({ ja: text, en: text }).strict();
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const actionOriginSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('speech'),
      evidenceSeq: z.array(version).min(1).max(100),
      delegationId: id,
    })
    .strict(),
  z
    .object({
      kind: z.literal('photo'),
      requestId: id,
      photoIds: z.array(id).min(1).max(2),
      photoVersion: version,
    })
    .strict(),
]);
export type ActionOrigin = z.infer<typeof actionOriginSchema>;
export const controlInputSchema = z
  .object({
    evidenceSeq: z.array(version).min(1).max(100),
    targetOperationId: id,
    arrivalRevision: version,
    status: z.enum(['pending', 'keep', 'cancel', 'replace', 'unknown']),
  })
  .strict();
export type ControlInput = z.infer<typeof controlInputSchema>;
export const scenarioKnowledgeEntrySchema = z
  .object({
    id: key,
    localizedText: localized,
    kind: z.enum(['known', 'observable', 'hidden']),
    prerequisites: z.array(z.object({ factKey: key, value: key }).strict()).max(30),
    revealMode: z.enum(['automatic', 'on_request']),
    requestCue: localized,
    observationTargetId: key.optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.kind === 'known' && (entry.prerequisites.length || entry.revealMode !== 'automatic'))
      ctx.addIssue({ code: 'custom', message: 'Known information must be initially available' });
  });
export type ScenarioKnowledgeEntry = z.infer<typeof scenarioKnowledgeEntrySchema>;
export const observationTargetSchema = z.object({ id: key, description: localized }).strict();
export const inferenceSchema = z
  .object({
    id: key,
    text,
    supportingKnownIds: z.array(key).min(1).max(100),
    status: z.enum(['tentative', 'retracted']),
    updatedAtVersion: version,
  })
  .strict();
export type Inference = z.infer<typeof inferenceSchema>;
export const knowledgeStateSchema = z
  .object({
    version,
    revealedIds: z.array(key).max(100),
    reveals: z
      .array(
        z
          .object({ id: key, reason: z.enum(['initial', 'progress', 'request', 'observation']) })
          .strict(),
      )
      .max(100),
    inferences: z.array(inferenceSchema).max(100),
  })
  .strict();
export type KnowledgeState = z.infer<typeof knowledgeStateSchema>;
export const acceptanceDecisionSchema = z
  .object({
    itemIdentity: id,
    recognitionRevision: version,
    policyVersion: id,
    situationRef: id,
    decision: z.enum(['accepted', 'rejected']),
    reason: text,
  })
  .strict();
export type AcceptanceDecision = z.infer<typeof acceptanceDecisionSchema>;
export const voiceActivitySchema = z
  .object({
    generation: version.min(1),
    sequence: version.min(1),
    input: z.enum(['active', 'quiet', 'unknown']),
    output: z.enum(['active', 'quiet', 'unknown']),
    playbackReady: z.boolean(),
    inputStopped: z.boolean().optional(),
  })
  .strict();
export type VoiceActivity = z.infer<typeof voiceActivitySchema>;
export const warningMilestoneSchema = z
  .object({
    id: key,
    kind: z.enum(['normal', 'final']),
    thresholdSeconds: z.number().int().min(1).max(3600),
    maxWaitMs: z.number().int().min(0).optional(),
    message: localized,
    transitionMessage: localized,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === 'final' && value.maxWaitMs === undefined)
      ctx.addIssue({ code: 'custom', message: 'Final warning needs a bounded wait' });
    if (value.maxWaitMs !== undefined && value.maxWaitMs >= value.thresholdSeconds * 1000)
      ctx.addIssue({ code: 'custom', message: 'Wait must be shorter than warning threshold' });
  });
export const warningPolicySchema = z
  .object({ enabled: z.boolean(), milestones: z.array(warningMilestoneSchema).max(10) })
  .strict()
  .superRefine((policy, ctx) => {
    const ids = new Set<string>();
    policy.milestones.forEach((entry, index) => {
      if (
        ids.has(entry.id) ||
        (index > 0 && entry.thresholdSeconds >= policy.milestones[index - 1]!.thresholdSeconds)
      )
        ctx.addIssue({
          code: 'custom',
          path: ['milestones', index],
          message: 'Warnings require unique IDs and descending distinct thresholds',
        });
      ids.add(entry.id);
      if (entry.kind === 'final' && index !== policy.milestones.length - 1)
        ctx.addIssue({
          code: 'custom',
          path: ['milestones', index],
          message: 'Final warning must be last',
        });
    });
  });
export type WarningPolicy = z.infer<typeof warningPolicySchema>;
