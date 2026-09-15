import { z } from 'zod';
import { sha256 } from './source.js';
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const usageSchema = z
  .object({
    inputTokens: count.nullable(),
    outputTokens: count.nullable(),
    cachedInputTokens: count.nullable(),
    reasoningTokens: count.nullable(),
  })
  .strict();
export type TokenUsage = z.infer<typeof usageSchema>;
const token = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
export function extractUsage(data: unknown): TokenUsage {
  const raw = data as {
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      input_tokens_details?: { cached_tokens?: unknown };
      output_tokens_details?: { reasoning_tokens?: unknown };
    };
  } | null;
  const usage = {
    inputTokens: token(raw?.usage?.input_tokens),
    outputTokens: token(raw?.usage?.output_tokens),
    cachedInputTokens: token(raw?.usage?.input_tokens_details?.cached_tokens),
    reasoningTokens: token(raw?.usage?.output_tokens_details?.reasoning_tokens),
  };
  if (
    usage.cachedInputTokens !== null &&
    (usage.inputTokens === null || usage.cachedInputTokens > usage.inputTokens)
  )
    usage.cachedInputTokens = null;
  if (
    usage.reasoningTokens !== null &&
    (usage.outputTokens === null || usage.reasoningTokens > usage.outputTokens)
  )
    usage.reasoningTokens = null;
  return usage;
}
export const pricingSchema = z
  .object({
    checkedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    serviceTier: z.literal('default'),
    responseAliases: z.record(z.string(), z.string()).default({}),
    models: z.record(
      z.string(),
      z
        .object({
          input: z.number().nonnegative(),
          cachedInput: z.number().nonnegative(),
          output: z.number().nonnegative(),
          cacheWriteMultiplier: z.number().min(1),
          source: z.url(),
        })
        .strict(),
    ),
  })
  .strict();
export type PricingSnapshot = z.infer<typeof pricingSchema>;
// USD per million tokens; verified from each official model page on 2026-09-15.
// Input is capped at 64 KiB, so the >272K-token price tier is unreachable.
export const EXPANSION_PRICING: PricingSnapshot = {
  checkedAt: '2026-09-15',
  serviceTier: 'default',
  responseAliases: {},
  models: {
    'gpt-6-astra': {
      input: 10,
      cachedInput: 1,
      output: 50,
      cacheWriteMultiplier: 1.25,
      source: 'https://developers.openai.com/api/docs/models/gpt-6-astra',
    },
    'gpt-5.6-sol': {
      input: 4,
      cachedInput: 0.4,
      output: 20,
      cacheWriteMultiplier: 1.25,
      source: 'https://developers.openai.com/api/docs/models/gpt-5.6-sol',
    },
    'gpt-5.6-terra': {
      input: 2,
      cachedInput: 0.2,
      output: 12,
      cacheWriteMultiplier: 1.25,
      source: 'https://developers.openai.com/api/docs/models/gpt-5.6-terra',
    },
    'gpt-5.6-luna': {
      input: 0.2,
      cachedInput: 0.02,
      output: 1.2,
      cacheWriteMultiplier: 1.25,
      source: 'https://developers.openai.com/api/docs/models/gpt-5.6-luna',
    },
  },
};
export function estimateCost(
  pricing: PricingSnapshot,
  model: string,
  usage: TokenUsage,
): number | null {
  const rate = pricing.models[model];
  if (!rate || usage.inputTokens === null || usage.outputTokens === null) return null;
  const cached = usage.cachedInputTokens ?? 0;
  // Unknown cache-write breakdown: conservatively price every uncached token as a write.
  // Reasoning is already included in output_tokens; never add it again.
  return (
    ((usage.inputTokens - cached) * rate.input * rate.cacheWriteMultiplier +
      cached * rate.cachedInput +
      usage.outputTokens * rate.output) /
    1_000_000
  );
}
export function pricingDigest(pricing: PricingSnapshot): string {
  return sha256(JSON.stringify(pricingSchema.parse(pricing)));
}
export const callUsageSchema = z
  .object({
    callId: z.string().uuid(),
    role: z.string().min(1).max(128),
    modelRequested: z.string().min(1).max(128),
    modelReturned: z.string().max(128).nullable(),
    playId: z.string().max(128).nullable(),
    revision: count.min(1),
    status: z.enum(['running', 'completed', 'failed', 'incomplete']),
    reservedInputTokens: count,
    reservedOutputTokens: count,
    reservedCostUsd: z.number().nonnegative(),
    estimatedCostUsd: z.number().nonnegative().nullable(),
    costBasis: z.literal('conservative-cache-write'),
    usage: usageSchema,
    pricingRef: z.string().regex(/^[a-f0-9]{64}$/),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    startedAt: z.string().datetime(),
    durationMs: z.number().nonnegative().nullable(),
    failure: z.string().max(128).nullable(),
  })
  .strict();
export type CallUsage = z.infer<typeof callUsageSchema>;

/** Known totals and uncertain reservations remain separate in reports. */
export function summarizeUsage(calls: readonly CallUsage[]) {
  return {
    callCount: calls.length,
    knownInputTokens: calls.reduce((sum, c) => sum + (c.usage.inputTokens ?? 0), 0),
    knownOutputTokens: calls.reduce((sum, c) => sum + (c.usage.outputTokens ?? 0), 0),
    unknownInputCalls: calls.filter((c) => c.usage.inputTokens === null).length,
    unknownOutputCalls: calls.filter((c) => c.usage.outputTokens === null).length,
    estimatedKnownCostUsd: calls.reduce((sum, c) => sum + (c.estimatedCostUsd ?? 0), 0),
    unknownCostCalls: calls.filter((c) => c.estimatedCostUsd === null).length,
    retainedUnknownCostUsd: calls
      .filter((c) => c.estimatedCostUsd === null)
      .reduce((sum, c) => sum + c.reservedCostUsd, 0),
  };
}
/** Pilot model/persona are confounded: this is a cost projection, never a model ranking. */
export function predictRemainingCost(
  pilot: readonly {
    model: string;
    status: 'cleared' | 'uncleared' | 'incomplete' | 'running';
    calls: readonly CallUsage[];
  }[],
  remainingModels: readonly string[],
): { estimatedUsd: number; basis: 'pilot-per-model'; guaranteed: false } | null {
  let total = 0;
  for (const model of remainingModels) {
    const plays = pilot.filter((play) => play.model === model);
    if (plays.length !== 1) return null;
    const play = plays[0]!;
    if (
      !['cleared', 'uncleared'].includes(play.status) ||
      !play.calls.length ||
      play.calls.some((call) => call.status !== 'completed' || call.estimatedCostUsd === null)
    )
      return null;
    total += play.calls.reduce((sum, call) => sum + call.estimatedCostUsd!, 0);
  }
  return { estimatedUsd: total, basis: 'pilot-per-model', guaranteed: false };
}
