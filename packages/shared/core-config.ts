import { z } from 'zod';

export const localeSchema = z.enum(['ja', 'en']);
export type Locale = z.infer<typeof localeSchema>;
const text = z.string().trim().min(1).max(2000);
export const localizedTextSchema = z.object({ ja: text, en: text }).strict();
export type LocalizedText = z.infer<typeof localizedTextSchema>;
const classificationExampleSchema = z
  .object({
    utterance: text,
    kind: z.enum(['wait', 'consult', 'execute']),
    reason: text,
  })
  .strict();
const localeConversationSchema = z
  .object({
    liveInstructions: text,
    openingMessage: text,
    classificationExamples: z.array(classificationExampleSchema).min(3).max(30),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const kind of ['wait', 'consult', 'execute']) {
      if (!value.classificationExamples.some((example) => example.kind === kind)) {
        ctx.addIssue({
          code: 'custom',
          path: ['classificationExamples'],
          message: `Missing ${kind} example`,
        });
      }
    }
  });
export const coreConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    conversation: z.object({ ja: localeConversationSchema, en: localeConversationSchema }).strict(),
    judgment: z.object({ physicality: text, ambiguity: text, partialProgress: text }).strict(),
    visualInspection: z.object({ majorContradictions: text }).strict(),
    timeWarning: z
      .object({
        enabled: z.boolean(),
        thresholdSeconds: z.number().int().min(1).max(3600),
        deliveryInstructions: localizedTextSchema,
        message: localizedTextSchema,
      })
      .strict()
      .optional(),
    chatGroupingGapMs: z.number().int().min(0).max(10000),
  })
  .strict();
export type CoreConfig = z.infer<typeof coreConfigSchema>;
export function parseCoreConfig(value: unknown): CoreConfig {
  return coreConfigSchema.parse(value);
}
