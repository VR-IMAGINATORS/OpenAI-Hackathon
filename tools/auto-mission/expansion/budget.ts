import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { AIResponsesClient } from '../../../apps/local-server/game-ai.js';
import { sha256 } from './source.js';
import {
  extractUsage,
  estimateCost,
  pricingDigest,
  pricingSchema,
  type PricingSnapshot,
  type CallUsage,
} from './usage.js';
export interface ExpansionLimits {
  maxCalls: number;
  maxOutputTokens: number;
  deadlineMs: number;
  requestTimeoutMs: number;
  maxInputBytes: number;
}
export const EXPANSION_LIMITS = {
  static: {
    maxCalls: 12,
    maxOutputTokens: 60000,
    deadlineMs: 600000,
    requestTimeoutMs: 600000,
    maxInputBytes: 65536,
  },
  play: {
    maxCalls: 200,
    maxOutputTokens: 100000,
    deadlineMs: 1200000,
    requestTimeoutMs: 600000,
    maxInputBytes: 65536,
  },
  pilot: {
    maxCalls: 650,
    maxOutputTokens: 350000,
    deadlineMs: 4500000,
    requestTimeoutMs: 600000,
    maxInputBytes: 131072,
  },
  remaining: {
    maxCalls: 1250,
    maxOutputTokens: 650000,
    deadlineMs: 9000000,
    requestTimeoutMs: 600000,
    maxInputBytes: 131072,
  },
} satisfies Record<string, ExpansionLimits>;
export class ExpansionLimitError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ExpansionLimitError';
  }
}
interface Scope {
  limits: ExpansionLimits;
  started: number;
  calls: number;
  output: number;
}
export interface CallContext {
  role?: string;
  playId?: string;
  revision: number;
  scopeId?: string;
}
export class ExpansionBudget {
  readonly calls: CallUsage[] = [];
  readonly pricing: PricingSnapshot;
  private readonly scopes = new Map<string, Scope>();
  private readonly now: () => number;
  private chargedUsd = 0;
  private blocked = false;
  private readonly settled = new Set<string>();
  constructor(
    readonly options: {
      mode: 'mock' | 'live';
      maxCostUsd?: number;
      pricing: PricingSnapshot;
      limits: ExpansionLimits;
      now?: () => number;
    },
  ) {
    if (
      options.mode === 'live' &&
      (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd! <= 0)
    )
      throw new ExpansionLimitError('EXPLICIT_COST_LIMIT_REQUIRED');
    this.options = Object.freeze({ ...options });
    this.pricing = pricingSchema.parse(structuredClone(options.pricing));
    for (const rate of Object.values(this.pricing.models)) Object.freeze(rate);
    Object.freeze(this.pricing.models);
    Object.freeze(this.pricing.responseAliases);
    Object.freeze(this.pricing);
    if (!Object.keys(this.pricing.models).length) throw new ExpansionLimitError('PRICING_REQUIRED');
    this.now = options.now ?? (() => performance.now());
    this.addScope('run', options.limits);
  }
  addScope(id: string, limits: ExpansionLimits): void {
    if (this.scopes.has(id)) throw new ExpansionLimitError('DUPLICATE_SCOPE');
    if (
      Object.values(limits).some((value) => !Number.isSafeInteger(value) || value <= 0) ||
      limits.maxInputBytes > 131072
    )
      throw new ExpansionLimitError('INVALID_LIMITS');
    this.scopes.set(id, { limits: { ...limits }, started: this.now(), calls: 0, output: 0 });
  }
  private applicable(context: CallContext): Scope[] {
    const root = this.scopes.get('run')!;
    if (!context.scopeId || context.scopeId === 'run') return [root];
    const scope = this.scopes.get(context.scopeId);
    if (!scope) throw new ExpansionLimitError('UNKNOWN_SCOPE');
    return [root, scope];
  }
  remainingMs(context: CallContext): number {
    return Math.max(
      0,
      Math.min(
        ...this.applicable(context).map((s) => s.limits.deadlineMs - (this.now() - s.started)),
      ),
    );
  }
  reserve(body: unknown, context: CallContext): CallUsage {
    if (this.blocked) throw new ExpansionLimitError('BUDGET_BLOCKED');
    const request = body as Record<string, unknown>;
    if (!request || typeof request !== 'object' || Array.isArray(request))
      throw new ExpansionLimitError('INVALID_REQUEST');
    const model = request.model;
    if (typeof model !== 'string' || !this.pricing.models[model])
      throw new ExpansionLimitError('UNKNOWN_MODEL_PRICE');
    const output = request.max_output_tokens;
    if (typeof output !== 'number' || !Number.isSafeInteger(output) || output <= 0)
      throw new ExpansionLimitError('OUTPUT_RESERVATION_REQUIRED');
    // This evaluator is text only. Reject unbounded hidden context and separately billed tools.
    if (
      request.previous_response_id ||
      request.conversation ||
      request.tools ||
      request.stream ||
      request.background ||
      (request.service_tier && request.service_tier !== 'default')
    )
      throw new ExpansionLimitError('UNPRICED_REQUEST_FEATURE');
    const serialized = JSON.stringify(body);
    const inspect = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach(inspect);
        return;
      }
      const obj = value as Record<string, unknown>;
      if (['input_image', 'input_audio', 'input_file'].includes(String(obj.type)))
        throw new ExpansionLimitError('TEXT_ONLY');
      Object.values(obj).forEach(inspect);
    };
    inspect(body);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    const scopes = this.applicable(context);
    if (this.remainingMs(context) <= 0) throw new ExpansionLimitError('DEADLINE_EXCEEDED');
    for (const scope of scopes) {
      if (bytes > scope.limits.maxInputBytes) throw new ExpansionLimitError('INPUT_LIMIT');
      if (
        scope.calls >= scope.limits.maxCalls ||
        scope.output + output > scope.limits.maxOutputTokens
      )
        throw new ExpansionLimitError('CALL_OR_TOKEN_LIMIT');
    }
    // One token per UTF-8 byte plus framing allowance; never character-count / 4.
    const input = bytes + 1024;
    const reservedCost = estimateCost(this.pricing, model, {
      inputTokens: input,
      outputTokens: output,
      cachedInputTokens: 0,
      reasoningTokens: null,
    })!;
    if (this.options.mode === 'live' && this.chargedUsd + reservedCost > this.options.maxCostUsd!)
      throw new ExpansionLimitError('COST_LIMIT');
    const format = (request.text as { format?: { name?: unknown } } | undefined)?.format;
    const role = context.role ?? (typeof format?.name === 'string' ? format.name : 'responses');
    if (
      !role ||
      role.length > 128 ||
      !Number.isSafeInteger(context.revision) ||
      context.revision < 1
    )
      throw new ExpansionLimitError('INVALID_CALL_CONTEXT');
    for (const scope of scopes) {
      scope.calls++;
      scope.output += output;
    }
    this.chargedUsd += reservedCost;
    const record: CallUsage = {
      callId: randomUUID(),
      role,
      modelRequested: model,
      modelReturned: null,
      playId: context.playId ?? null,
      revision: context.revision,
      status: 'running',
      reservedInputTokens: input,
      reservedOutputTokens: output,
      reservedCostUsd: reservedCost,
      estimatedCostUsd: null,
      costBasis: 'conservative-cache-write',
      usage: extractUsage(null),
      pricingRef: pricingDigest(this.pricing),
      requestDigest: sha256(serialized),
      startedAt: new Date().toISOString(),
      durationMs: null,
      failure: null,
    };
    this.calls.push(record);
    return record;
  }
  settle(record: CallUsage, data: unknown, context: CallContext): void {
    if (!this.calls.includes(record)) throw new ExpansionLimitError('UNKNOWN_RESERVATION');
    if (this.settled.has(record.callId)) return;
    this.settled.add(record.callId);
    record.usage = extractUsage(data);
    const model = (data as { model?: unknown } | null)?.model;
    record.modelReturned = typeof model === 'string' ? model : null;
    // A different/unknown returned model cannot silently acquire the requested model's price.
    if (
      record.modelReturned !== record.modelRequested &&
      this.pricing.responseAliases[record.modelReturned ?? ''] !== record.modelRequested
    ) {
      this.blocked = true;
      throw new ExpansionLimitError('RETURNED_MODEL_MISMATCH');
    }
    const cost = estimateCost(this.pricing, record.modelRequested, record.usage);
    record.estimatedCostUsd = cost;
    if (cost === null) return; // Retain full reservation if either total is missing.
    this.chargedUsd += cost - record.reservedCostUsd;
    for (const scope of this.applicable(context))
      scope.output += record.usage.outputTokens! - record.reservedOutputTokens;
    if (
      record.usage.inputTokens! > record.reservedInputTokens ||
      record.usage.outputTokens! > record.reservedOutputTokens ||
      cost > record.reservedCostUsd
    ) {
      this.blocked = true;
      throw new ExpansionLimitError('USAGE_EXCEEDED_RESERVATION');
    }
  }
  snapshot() {
    return {
      chargedCostUsd: this.chargedUsd,
      callCount: this.calls.length,
      unknownUsageCalls: this.calls.filter((c) => c.estimatedCostUsd === null).length,
      scopes: Object.fromEntries(
        [...this.scopes].map(([id, s]) => [id, { calls: s.calls, chargedOutputTokens: s.output }]),
      ),
    };
  }
  async measure<T>(
    body: unknown,
    context: CallContext,
    invoke: (body: unknown, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    checkpoint?: (record: CallUsage) => Promise<void>,
  ): Promise<T> {
    if (signal?.aborted) throw new ExpansionLimitError('INTERRUPTED');
    const request = { ...(body as Record<string, unknown>), service_tier: 'default' };
    // Validate caller's tier before forcing a deterministic standard request.
    if (
      (body as { service_tier?: unknown })?.service_tier &&
      (body as { service_tier?: unknown }).service_tier !== 'default'
    )
      throw new ExpansionLimitError('UNPRICED_REQUEST_FEATURE');
    const record = this.reserve(request, context);
    const started = this.now();
    const controller = new AbortController();
    const abort = () => controller.abort(new ExpansionLimitError('INTERRUPTED'));
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = Math.min(
      this.remainingMs(context),
      ...this.applicable(context).map((s) => s.limits.requestTimeoutMs),
    );
    const timer = setTimeout(
      () => controller.abort(new ExpansionLimitError('REQUEST_TIMEOUT')),
      timeout,
    );
    let onAbort = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    void aborted.catch(() => {});
    try {
      // Durable reservation must precede paid transport, including calls made by the game.
      await checkpoint?.(record);
      if (controller.signal.aborted) throw controller.signal.reason;
      const result = await Promise.race([invoke(request, controller.signal), aborted]);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 2 * 1024 * 1024)
        throw new ExpansionLimitError('RESPONSE_SIZE_LIMIT');
      this.settle(record, result, context);
      if ((result as { status?: unknown })?.status !== 'completed')
        throw new ExpansionLimitError('RESPONSE_INCOMPLETE');
      record.status = 'completed';
      return result;
    } catch (error) {
      record.status = 'incomplete';
      record.failure =
        error instanceof ExpansionLimitError ? error.code : 'TRANSPORT_OR_CHECKPOINT_FAILURE';
      throw error instanceof ExpansionLimitError
        ? error
        : new ExpansionLimitError('TRANSPORT_OR_CHECKPOINT_FAILURE');
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
      signal?.removeEventListener('abort', abort);
      record.durationMs = Math.max(0, this.now() - started);
      try {
        await checkpoint?.(record);
      } catch {
        record.status = 'incomplete';
        record.failure = 'CHECKPOINT_FAILURE';
        throw new ExpansionLimitError('CHECKPOINT_FAILURE');
      }
    }
  }
}
export class MeasuredResponsesClient implements AIResponsesClient {
  constructor(
    private readonly client: AIResponsesClient,
    readonly budget: ExpansionBudget,
    private readonly context: () => CallContext,
    private readonly checkpoint?: (record: CallUsage) => Promise<void>,
  ) {}
  respond(body: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.budget.measure(
      body,
      this.context(),
      (request, combined) => this.client.respond(request, combined),
      signal,
      this.checkpoint,
    );
  }
}
/** Injection for the unchanged original ResponsesProvider as well as new expansion roles. */
export function measuredFetch(
  transport: typeof fetch,
  budget: ExpansionBudget,
  context: () => CallContext,
  checkpoint?: (record: CallUsage) => Promise<void>,
): typeof fetch {
  return async (input, init) => {
    if (
      String(input) !== 'https://api.openai.com/v1/responses' ||
      init?.method !== 'POST' ||
      typeof init.body !== 'string'
    )
      throw new ExpansionLimitError('UNSUPPORTED_ENDPOINT');
    const data = await budget.measure(
      JSON.parse(init.body),
      context(),
      async (body, signal) => {
        const response = await transport(input, { ...init, body: JSON.stringify(body), signal });
        if (!response.ok) {
          await response.body?.cancel();
          throw new ExpansionLimitError('HTTP_' + response.status);
        }
        const reader = response.body?.getReader();
        if (!reader) throw new ExpansionLimitError('EMPTY_RESPONSE');
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.length;
            if (bytes > 2 * 1024 * 1024) throw new ExpansionLimitError('RESPONSE_SIZE_LIMIT');
            chunks.push(next.value);
          }
          return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      },
      init.signal ?? undefined,
      checkpoint,
    );
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  };
}
