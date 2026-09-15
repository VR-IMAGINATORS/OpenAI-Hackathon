import { z } from 'zod';
import { warningPolicySchema } from './harness.js';

export const localeSchema = z.enum(['ja', 'en']);
export type Locale = z.infer<typeof localeSchema>;
export const companionInitiativeSchema = z.enum(['observations', 'hypotheses', 'suggestions']);
export type CompanionInitiative = z.infer<typeof companionInitiativeSchema>;
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
const currentCoreConfigSchema = z
  .object({
    schemaVersion: z.literal(2),
    companionInitiative: companionInitiativeSchema.default('observations'),
    acceptancePolicy: localizedTextSchema,
    creativity: z
      .object({
        enabled: z.boolean(),
        // Read old deployment configs, but never restore their retired lottery.
        successProbability: z.number().min(0).max(1).optional(),
      })
      .strict()
      .transform(({ enabled }) => ({ enabled }))
      .optional(),
    recovery: z
      .object({
        retrying: localizedTextSchema,
        failed: localizedTextSchema,
        cancelled: localizedTextSchema,
      })
      .strict(),
    warnings: warningPolicySchema,
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
const acceptancePolicy = {
  ja: '身近な物の通常の物性と筋の通る工夫を認める。溶岩など日常から大きく離れた物は認めない。舞台の物理的制約と扱える主体を守り、特殊能力を加えない。',
  en: 'Allow everyday objects and physically plausible creative uses. Reject extraordinary objects such as lava. Preserve world constraints and the companion’s capabilities; do not add special powers.',
};
const recovery = {
  retrying: { ja: 'ごめん、もう一度確かめるね。', en: 'Sorry, let me check once more.' },
  failed: {
    ja: 'ごめん、今は確かめられなかった。もう一度どうしたいか教えて。',
    en: 'Sorry, I could not check that just now. Tell me what you want to try again.',
  },
  cancelled: { ja: 'わかった、いったん止めるね。', en: 'All right, I will stop for now.' },
};
/** Explicit compatibility conversion. Unknown new-format fields still fail strict parsing. */
export function normalizeCoreConfig(value: unknown): unknown {
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1
  )
    return value;
  const legacy = value as Record<string, any>;
  const warning = legacy.timeWarning;
  return {
    ...legacy,
    schemaVersion: 2,
    acceptancePolicy,
    recovery,
    warnings: {
      enabled: warning?.enabled ?? false,
      milestones: warning
        ? [
            {
              id: 'legacy-warning',
              kind: 'normal',
              thresholdSeconds: warning.thresholdSeconds,
              message: warning.message,
              transitionMessage: warning.message,
            },
          ]
        : [],
    },
  };
}
export const coreConfigSchema = z.preprocess(normalizeCoreConfig, currentCoreConfigSchema);
export type CoreConfig = z.infer<typeof coreConfigSchema>;
export function parseCoreConfig(value: unknown): CoreConfig {
  return coreConfigSchema.parse(value);
}
