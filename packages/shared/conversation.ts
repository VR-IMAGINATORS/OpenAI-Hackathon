import { z } from 'zod';
import { itemStatus } from './game.js';

const sequence = z.number().int().min(1);
const version = z.number().int().min(0);
const milliseconds = z.number().int().min(0);
const eventId = z.string().min(1).max(200);
const uuid = z.string().uuid();
const factKey = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const factValue = z.string().min(1).max(2000);
const reason = z.string().min(1).max(1000);
const evidenceSeq = z
  .array(sequence)
  .min(1)
  .max(10_000)
  .refine((values) => new Set(values).size === values.length, 'Evidence sequences must be unique');

/** Structural contracts only: the runtime must verify speaker, eligibility and ownership. */
export const transcriptFragmentSchema = z
  .object({
    serverSeq: sequence,
    eventId,
    generation: sequence,
    speaker: z.enum(['user', 'assistant']),
    delta: z.string().max(4000),
    startMs: milliseconds,
    endMs: milliseconds,
    receivedGameVersion: version,
    executionEligible: z.boolean(),
  })
  .strict()
  .refine((value) => value.endMs >= value.startMs, {
    message: 'Transcript end must not precede start',
    path: ['endMs'],
  })
  .refine((value) => value.speaker === 'user' || !value.executionEligible, {
    message: 'Assistant speech cannot be execution evidence',
    path: ['executionEligible'],
  });
export type TranscriptFragment = z.infer<typeof transcriptFragmentSchema>;

export const delegationRequestSchema = z
  .object({
    id: eventId,
    generation: sequence,
    offsetMs: milliseconds,
    receivedAt: milliseconds,
    deadline: milliseconds,
    attempts: z.number().int().min(0).max(3),
    lastEvaluatedContextVersion: version.nullable(),
    status: z.enum(['pending', 'evaluating', 'consulted', 'reserved', 'expired']),
  })
  .strict()
  .refine((value) => value.deadline >= value.receivedAt, {
    message: 'Delegation deadline must not precede receipt',
    path: ['deadline'],
  });
export type DelegationRequest = z.infer<typeof delegationRequestSchema>;

/** Each reference has exactly one namespace. A UUID alone does not prove availability. */
export const itemReferenceSchema = z.union([
  z.object({ photoId: uuid }).strict(),
  z.object({ inventoryId: uuid }).strict(),
]);
export type ItemReference = z.infer<typeof itemReferenceSchema>;
export const executeIntentSchema = z
  .object({
    kind: z.literal('execute'),
    evidenceSeq,
    itemRefs: z
      .array(itemReferenceSchema)
      .min(1)
      .max(40)
      .refine(
        (refs) =>
          new Set(
            refs.map((ref) =>
              'photoId' in ref ? `photo:${ref.photoId}` : `inventory:${ref.inventoryId}`,
            ),
          ).size === refs.length,
        'Item references must be unique',
      ),
    usage: z.string().min(1).max(1000),
    reason,
  })
  .strict();
export const intentDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('wait'), reason }).strict(),
  z
    .object({
      kind: z.literal('consult'),
      evidenceSeq,
      reason,
      answer: z.string().min(1).max(2000).optional(),
    })
    .strict(),
  executeIntentSchema,
]);
export type IntentDecision = z.infer<typeof intentDecisionSchema>;
export type ExecuteIntent = z.infer<typeof executeIntentSchema>;

export const actionTicketSchema = z
  .object({
    id: uuid,
    playId: uuid,
    generation: sequence,
    actionEpoch: version,
    controllerEpoch: version,
    gameVersion: version,
    contextVersion: version,
    evidenceSeq,
    intent: executeIntentSchema,
    status: z.enum(['pending', 'committed', 'failed', 'invalid']),
  })
  .strict()
  .refine(
    (value) =>
      value.evidenceSeq.length === value.intent.evidenceSeq.length &&
      value.evidenceSeq.every((seq, index) => seq === value.intent.evidenceSeq[index]),
    {
      message: 'Ticket evidence must match its reserved intent',
      path: ['evidenceSeq'],
    },
  );
export type ActionTicket = z.infer<typeof actionTicketSchema>;

/** Scenario-dependent declared keys, values and transitions are checked at commit time. */
export const gameFactsSchema = z
  .object({
    obstacleId: factKey,
    values: z
      .record(factKey, factValue)
      .refine((values) => Object.keys(values).length <= 30, 'Too many facts'),
  })
  .strict();
export type GameFacts = z.infer<typeof gameFactsSchema>;
export const factChangeSchema = z.object({ key: factKey, from: factValue, to: factValue }).strict();
export const actionResultSchema = z
  .object({
    actionId: uuid,
    beforeVersion: version,
    afterVersion: version,
    success: z.boolean(),
    factChanges: z
      .array(factChangeSchema)
      .max(30)
      .refine(
        (changes) => new Set(changes.map((change) => change.key)).size === changes.length,
        'Each fact can change at most once per action',
      ),
    inventoryChanges: z
      .array(
        z
          .object({
            id: uuid,
            status: itemStatus,
            description: z.string().max(1000),
          })
          .strict(),
      )
      .max(40)
      .refine(
        (changes) => new Set(changes.map((change) => change.id)).size === changes.length,
        'Each inventory item can change at most once per action',
      ),
    narrative: z.string().min(1).max(2000),
    shortReason: reason,
  })
  .strict()
  .refine((value) => value.afterVersion === value.beforeVersion + 1, {
    message: 'An action advances the game version exactly once',
    path: ['afterVersion'],
  });
export type ActionResult = z.infer<typeof actionResultSchema>;

const commandType = z.enum([
  'session.thinking.append',
  'session.commentary.append',
  'session.instructions.append',
]);
/** Internal queue entry; connection ownership is not repeated in each HTTP command. */
export const liveOutboxEntrySchema = z
  .object({
    seq: sequence,
    eventId,
    generation: sequence,
    controllerEpoch: version,
    delegationId: eventId.nullable(),
    commandType,
    content: z.string().max(2000),
    messageId: uuid.nullable(),
  })
  .strict();
export type LiveOutboxEntry = z.infer<typeof liveOutboxEntrySchema>;

// Wire shapes below mirror contracts/openapi.json (Command, Slot, Message).
export const liveCommandSchema = z
  .object({
    seq: sequence,
    event_id: z.string().max(200),
    type: commandType,
    delegation_id: z.string().max(200).nullable(),
    content: z.string().max(2000),
    messageId: uuid.nullable(),
  })
  .strict();
export type CoreLiveCommand = z.infer<typeof liveCommandSchema>;
export const sceneImageSlotSchema = z
  .object({
    status: z.enum([
      'queued',
      'generating',
      'checking',
      'retrying',
      'ready',
      'failed',
      'cancelled',
    ]),
    assetId: uuid.nullable(),
    errorCode: z.literal('SCENE_RECEIVE_FAILED').nullable(),
    deadline: z.iso.datetime({ offset: true }),
  })
  .strict();
export type SceneImageSlot = z.infer<typeof sceneImageSlotSchema>;
export const chatMessageSchema = z
  .object({
    id: uuid,
    createdOrder: version,
    updatedVersion: version,
    side: z.enum(['user', 'assistant']),
    kind: z.enum(['transcript', 'photo', 'result', 'system']),
    text: z.string().max(4000),
    assetIds: z.array(uuid).max(2),
    imageSlot: sceneImageSlotSchema.nullable(),
    relatedCommandSeq: version.nullable(),
    liveGeneration: sequence.nullable(),
  })
  .strict();
export type ChatMessage = z.infer<typeof chatMessageSchema>;
