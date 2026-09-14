import { z } from 'zod';

export const roles = [
  'contractGenerator',
  'contractChecker',
  'storyGenerator',
  'repairer',
  'physics',
  'resources',
  'causality',
  'verifier',
] as const;
export const reviewerRoles = ['physics', 'resources', 'causality'] as const;
export const roleSchema = z.enum(roles);
export type Role = z.infer<typeof roleSchema>;
export const reviewerRoleSchema = z.enum(reviewerRoles);
export type ReviewerRole = z.infer<typeof reviewerRoleSchema>;
const text = z.string().min(1).max(16000);
const id = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-zA-Z0-9_-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const modelSettingsSchema = z.strictObject({
  model: text,
  reasoningEffort: z.enum(['low', 'medium', 'high']),
  maxOutputTokens: z.number().int().positive(),
});
export type ModelSettings = z.infer<typeof modelSettingsSchema>;
export const worldSchema = z.strictObject({ premise: text, constraints: z.array(text).min(1) });
export const difficultySchema = z.strictObject({
  maxPhotoSends: z.number().int().positive(),
  maxPhotosPerSend: z.number().int().positive(),
  maxActions: z.number().int().positive().nullable(),
  totalTimeSeconds: z.number().positive(),
  obstacleCount: z.number().int().min(2).max(5),
});
export const catalogItemSchema = z.strictObject({
  id,
  name: text,
  ordinaryProperties: z.array(text).min(1),
});
export const missionConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  locale: z.literal('ja'),
  world: worldSchema,
  difficulty: difficultySchema,
  objectCatalog: z.array(catalogItemSchema).min(1),
  referenceScenarios: z.array(text),
  models: z.strictObject({
    contractGenerator: modelSettingsSchema,
    contractChecker: modelSettingsSchema,
    storyGenerator: modelSettingsSchema,
    repairer: modelSettingsSchema,
    physics: modelSettingsSchema,
    resources: modelSettingsSchema,
    causality: modelSettingsSchema,
    verifier: modelSettingsSchema,
  }),
  limits: z.strictObject({
    maxRepairs: z.number().int().min(0).max(2),
    maxApiCalls: z.number().int().positive(),
    maxOutputTokensTotal: z.number().int().positive(),
    deadlineSeconds: z.number().positive(),
    requestTimeoutSeconds: z.number().positive(),
    maxInputBytesPerCall: z.number().int().positive(),
    maxConcurrentReviews: z.number().int().min(1).max(3),
  }),
});
export type MissionConfig = z.infer<typeof missionConfigSchema>;
export const conditionSchema = z.strictObject({ key: id, value: text });
export const itemStateSchema = z.strictObject({
  phase: z.enum(['unmaterialized', 'held', 'placed', 'unavailable']),
  locationId: id.nullable(),
  condition: z.enum(['usable', 'spent', 'broken']),
});
export type ItemState = z.infer<typeof itemStateSchema>;
export const contractProposalSchema = z.strictObject({
  locations: z.array(z.strictObject({ id, description: text })).min(1),
  factDefinitions: z
    .array(z.strictObject({ key: id, allowedValues: z.array(text).min(1), initialValue: text }))
    .min(1),
  initialState: z.strictObject({
    locationId: id,
    description: text,
    props: z.array(z.strictObject({ id, description: text, locationId: id })),
  }),
  orderedObstacles: z
    .array(
      z.strictObject({
        id,
        locationId: id,
        goalConditions: z.array(conditionSchema).min(1),
        constraints: z.array(text),
      }),
    )
    .min(2)
    .max(5),
  escapeConditions: z.array(conditionSchema).min(1),
});
export type ContractProposal = z.infer<typeof contractProposalSchema>;
export const missionContractSchema = contractProposalSchema.extend({
  schemaVersion: z.literal(1),
  inputDigest: digest,
  world: worldSchema,
  difficulty: difficultySchema,
  objectCatalog: z.array(catalogItemSchema).min(1),
});
export type MissionContract = z.infer<typeof missionContractSchema>;
export const stepSchema = z.strictObject({
  id,
  obstacleId: id,
  kind: z.enum(['send', 'use', 'place', 'retrieve', 'move']),
  description: text,
  preconditions: z.array(conditionSchema),
  itemIds: z.array(id),
  targetLocationId: id.nullable(),
  factEffects: z.array(z.strictObject({ key: id, from: text, to: text })),
  itemEffects: z.array(z.strictObject({ itemId: id, from: itemStateSchema, to: itemStateSchema })),
  estimatedSeconds: z.number().positive(),
  timeRationale: text,
});
export type Step = z.infer<typeof stepSchema>;
export const missionCandidateSchema = z.strictObject({
  revision: z.number().int().min(0).max(2),
  contractDigest: digest,
  title: text,
  opening: text,
  obstacles: z
    .array(z.strictObject({ id, description: text, solutionExample: text }))
    .min(2)
    .max(5),
  ending: text,
  items: z.array(z.strictObject({ id, catalogId: id, initialPlacement: text })),
  steps: z.array(stepSchema).min(1),
});
export type MissionCandidate = z.infer<typeof missionCandidateSchema>;
export const mechanicalCheckSchema = z.strictObject({
  id: text,
  status: z.enum(['pass', 'fail']),
  path: text,
  reason: text,
});
export const mechanicalResultSchema = z.strictObject({
  candidateDigest: digest,
  checks: z.array(mechanicalCheckSchema),
  stateTrace: z.array(
    z.strictObject({
      stepId: id,
      locationId: id,
      facts: z.array(conditionSchema),
      items: z.array(z.strictObject({ itemId: id, state: itemStateSchema })),
    }),
  ),
  resourceTotals: z.strictObject({
    photoSends: z.number().int().nonnegative(),
    actions: z.number().int().nonnegative(),
    photos: z.number().int().nonnegative(),
  }),
  estimatedTotalSeconds: z.number().nonnegative(),
});
export type MechanicalResult = z.infer<typeof mechanicalResultSchema>;
export type MechanicalCheck = z.infer<typeof mechanicalCheckSchema>;
export const findingSchema = z.strictObject({
  id: text,
  role: z.enum(['physics', 'resources', 'causality', 'verifier', 'contractChecker']),
  blocking: z.boolean(),
  category: text,
  targetPath: text,
  excerpt: text,
  reason: text,
  missingInformation: z.string(),
});
export type Finding = z.infer<typeof findingSchema>;
export const reviewSchema = z.strictObject({
  role: reviewerRoleSchema,
  candidateDigest: digest,
  verdict: z.enum(['pass', 'fail', 'unknown']),
  summary: text,
  findings: z.array(findingSchema),
});
export type Review = z.infer<typeof reviewSchema>;
export const verificationSchema = z.strictObject({
  candidateDigest: digest,
  decisions: z.array(
    z.strictObject({
      findingId: text,
      disposition: z.enum(['confirmed', 'rejected', 'unresolved']),
      reason: text,
      evidencePaths: z.array(text),
      counterevidence: z.string(),
    }),
  ),
  findings: z.array(findingSchema),
});
export type Verification = z.infer<typeof verificationSchema>;
export const contractCheckSchema = z.strictObject({
  verdict: z.enum(['pass', 'fail', 'unknown']),
  summary: text,
  findings: z.array(findingSchema),
});
export type ContractCheck = z.infer<typeof contractCheckSchema>;
export const failureCodeSchema = z.enum([
  'CONFIG_INVALID',
  'CONTRACT_INVALID',
  'STORY_REJECTED',
  'REVIEW_INCOMPLETE',
  'API_ERROR',
  'API_TIMEOUT',
  'MODEL_UNAVAILABLE',
  'OUTPUT_INVALID',
  'BUDGET_EXCEEDED',
  'INTERRUPTED',
  'STORAGE_ERROR',
]);
export type FailureCode = z.infer<typeof failureCodeSchema>;
export const callRecordSchema = z.strictObject({
  instructionsDigest: digest.optional(),
  inputDigest: digest.optional(),
  role: roleSchema,
  reasoningEffort: text,
  model: text,
  requestedModel: text,
  responseModel: z.string().nullable(),
  status: z.enum(['running', 'completed', 'failed', 'aborted']),
  usage: z
    .strictObject({
      inputTokens: z.number().int().nonnegative().nullable(),
      outputTokens: z.number().int().nonnegative().nullable(),
    })
    .nullable(),
  startedAt: text,
  endedAt: z.string().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  reservedOutputTokens: z.number().int().positive(),
  error: z.string().nullable(),
});
export type CallRecord = z.infer<typeof callRecordSchema>;
export const phaseTimingSchema = z.strictObject({
  phase: text,
  revision: z.number().int().nonnegative().nullable(),
  role: roleSchema.nullable(),
  startedAt: text,
  endedAt: z.string().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  status: z.enum(['running', 'completed', 'skipped', 'failed', 'aborted']),
  reason: z.string().nullable(),
});
export type PhaseTiming = z.infer<typeof phaseTimingSchema>;
export const verdictSchema = z.strictObject({
  passed: z.boolean(),
  failureCode: failureCodeSchema.nullable(),
  reasons: z.array(z.string()),
});
export type Verdict = z.infer<typeof verdictSchema>;
export const revisionRecordSchema = z.strictObject({
  verdict: verdictSchema.nullable(),
  candidate: missionCandidateSchema,
  digest,
  mechanical: mechanicalResultSchema.nullable(),
  reviews: z.array(reviewSchema),
  verification: verificationSchema.nullable(),
});
export type RevisionRecord = z.infer<typeof revisionRecordSchema>;
export const inputSnapshotSchema = z.strictObject({
  config: missionConfigSchema,
  references: z.array(z.strictObject({ path: text, content: z.string() })),
});
export type InputSnapshot = z.infer<typeof inputSnapshotSchema>;
export const runRecordSchema = z.strictObject({
  runId: text,
  parentRunId: z.string().nullable(),
  mode: z.enum(['live', 'mock']),
  status: z.enum(['running', 'passed', 'failed']),
  phase: z.enum(['contract', 'generate', 'check', 'review', 'verify', 'repair', 'finished']),
  failureCode: failureCodeSchema.nullable(),
  failureReason: z.string().nullable(),
  inputSnapshot: inputSnapshotSchema,
  contract: missionContractSchema.nullable(),
  contractDigest: digest.nullable(),
  contractCheck: contractCheckSchema.nullable(),
  contractValidation: z
    .strictObject({ valid: z.boolean(), checks: z.array(mechanicalCheckSchema) })
    .optional(),
  revisions: z.array(revisionRecordSchema),
  calls: z.array(callRecordSchema),
  timings: z.array(phaseTimingSchema),
  startedAt: text,
  endedAt: z.string().nullable(),
  durationMs: z.number().nonnegative().nullable(),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

export type ModelRole = Role;
