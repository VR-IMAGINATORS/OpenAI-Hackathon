import { z } from 'zod';
import { digest, key, text } from './schemas.js';
export const REVIEW_MODELS = ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra'] as const;
export const evidenceRefSchema = z.union([
  z
    .object({
      kind: z.literal('pointer'),
      document: z.enum(['source', 'candidate']),
      pointer: z
        .string()
        .max(1000)
        .regex(/^(?:\/(?:[^~]|~[01])*)*$/),
    })
    .strict(),
  z.object({ kind: z.literal('turn'), playId: key, turnId: z.string().min(1).max(128) }).strict(),
]);
export const findingSchema = z
  .object({ id: key, claim: text, evidence: z.array(evidenceRefSchema).min(1).max(30) })
  .strict();
const score = z
  .object({
    score: z.number().int().min(1).max(5).nullable(),
    rationale: text,
    evidence: z.array(evidenceRefSchema).max(30),
    suggestions: z.array(text).max(10),
  })
  .strict();
export const reviewOutputSchema = z
  .object({
    feasibilityFindings: z.array(findingSchema).max(30),
    feasibilityEvidence: z.array(evidenceRefSchema).min(1).max(30),
    funScores: z
      .object({
        investigationDesire: score,
        inferenceFromInformation: score,
        satisfyingDiscovery: score,
        conversationValue: score,
      })
      .strict(),
  })
  .strict();
export const reviewSchema = reviewOutputSchema
  .extend({
    model: z.enum(REVIEW_MODELS),
    candidateDigest: digest,
    playIds: z.array(key).max(9),
    segments: z
      .array(
        z
          .object({
            inputDigest: digest,
            turnRefs: z
              .array(z.object({ playId: key, turnId: z.string().min(1).max(128) }).strict())
              .max(225),
            review: reviewOutputSchema,
          })
          .strict(),
      )
      .max(225),
  })
  .strict();
export const verifiedOutputSchema = z
  .object({
    findings: z
      .array(
        z
          .object({
            findingId: key,
            classification: z.enum([
              'confirmed_scenario_defect',
              'harness_defect',
              'player_miss',
              'inconclusive',
            ]),
            reason: text,
            evidence: z.array(evidenceRefSchema).min(1).max(30),
            counterEvidence: z.array(evidenceRefSchema).max(30),
            counterEvidenceReason: text,
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const verifiedFindingSchema = verifiedOutputSchema.shape.findings.element
  .extend({
    model: z.literal('gpt-6-astra'),
    blocking: z.boolean(),
    repairable: z.boolean(),
    segments: z
      .array(
        z
          .object({
            inputDigest: digest,
            turnRefs: z
              .array(z.object({ playId: key, turnId: z.string().min(1).max(128) }).strict())
              .max(225),
            finding: verifiedOutputSchema.shape.findings.element,
          })
          .strict(),
      )
      .max(225)
      .default([]),
  })
  .strict();
export const evaluationRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    candidateDigest: digest,
    revision: z.number().int().positive(),
    conditionsDigest: digest,
    playIds: z.array(key).max(9),
    reviews: z.array(reviewSchema).max(3),
    verifiedFindings: z.array(verifiedFindingSchema).max(100),
    verificationModel: z.literal('gpt-6-astra').nullable(),
    status: z.enum(['complete', 'incomplete']),
    failure: text.nullable(),
  })
  .strict();
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type VerifiedFinding = z.infer<typeof verifiedFindingSchema>;
export type EvaluationRecord = z.infer<typeof evaluationRecordSchema>;
