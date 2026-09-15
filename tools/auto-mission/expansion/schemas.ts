import { z } from 'zod';
import { scenarioV2Schema } from '../../../packages/shared/scenario.js';
import {
  scenarioKnowledgeEntrySchema,
  observationTargetSchema,
  knowledgeMetadataSchema,
  ambienceSlotSchema,
  publicVisualSchema,
} from '../../../packages/shared/harness.js';
export const text = z.string().trim().min(1).max(2000);
export const localized = z.object({ ja: text, en: text }).strict();
export const key = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
const pointer = z.string().max(1000).regex(new RegExp('^(?:/(?:[^~]|~[01])*)*$'));
export const sourceSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceDigest: digest,
    rawCatalogText: z.string().min(1),
    compiledOriginal: scenarioV2Schema,
    originalInvariantDigest: digest,
    selection: z
      .object({
        candidateIndex: z.number().int().nonnegative(),
        sceneId: key,
        sequenceIndex: z.number().int().nonnegative(),
        obstacleIds: z.array(key).min(1).max(10),
      })
      .strict(),
    originalSections: z
      .object({
        shared: z.record(z.string(), z.unknown()),
        scene: z.record(z.string(), z.unknown()),
        gimmicks: z.array(z.record(z.string(), z.unknown())).min(1).max(10),
      })
      .strict(),
  })
  .strict();
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;
export const expansionCandidateSchema = z
  .object({
    schemaVersion: z.literal(1),
    candidateId: key,
    revision: z.number().int().min(1),
    parentDigest: digest.nullable(),
    sourceDigest: digest,
    originalInvariantDigest: digest,
    openingOverview: localized,
    expandedStory: z
      .array(z.object({ id: key, title: localized, body: localized }).strict())
      .min(1)
      .max(100),
    knowledgeAdditions: z.array(scenarioKnowledgeEntrySchema).max(100),
    observationTargets: z.array(observationTargetSchema).max(100),
    knowledgeMetadata: z.array(knowledgeMetadataSchema).max(100),
    displayOverrides: z.array(z.object({ path: pointer, value: localized }).strict()).max(100),
    ambienceSlots: z.array(ambienceSlotSchema).max(30),
    publicVisuals: z.array(publicVisualSchema).max(100),
    changeMap: z
      .array(
        z
          .object({
            sourcePointer: pointer,
            expandedPointer: pointer,
            kind: z.enum(['retained', 'added', 'revised']),
            reason: localized,
          })
          .strict(),
      )
      .max(300),
  })
  .strict();
export type ExpansionCandidate = z.infer<typeof expansionCandidateSchema>;
export function assertSize(value: unknown, label: string): void {
  if (
    Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8') >
    256 * 1024
  )
    throw new Error(label + ' exceeds 256 KiB');
}
export function parseExpansionCandidate(value: unknown): ExpansionCandidate {
  assertSize(value, 'Candidate');
  return expansionCandidateSchema.parse(value);
}
