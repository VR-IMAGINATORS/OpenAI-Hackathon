import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { Budget, MissionProviderError } from './budget.js';
import { stableStringify } from './config.js';
import type { MissionConfig, ModelRole } from './schemas.js';

export interface ProviderCallRecord {
  instructionsDigest?: string;
  inputDigest?: string;
  role: ModelRole;
  model: string;
  requestedModel: string;
  responseModel: string | null;
  reasoningEffort: string;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  reservedOutputTokens: number;
  usage: { inputTokens: number | null; outputTokens: number | null } | null;
  error: string | null;
}
export interface MissionProvider {
  calls: ProviderCallRecord[];
  budget: Budget;
  call<T>(role: ModelRole, input: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T>;
}
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const rolePromptNames: Record<ModelRole, string> = {
  contractGenerator: 'contract-generator',
  contractChecker: 'contract-checker',
  storyGenerator: 'story-generator',
  repairer: 'repairer',
  physics: 'physics',
  resources: 'resources',
  causality: 'causality',
  verifier: 'verifier',
};
function instruction(role: ModelRole): string {
  return (
    readFileSync(new URL('./prompts/common.md', import.meta.url), 'utf8') +
    '\n' +
    readFileSync(new URL(`./prompts/${rolePromptNames[role]}.md`, import.meta.url), 'utf8')
  );
}
export function strictOutputSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  delete json.$schema;
  const inspect = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    if (object.oneOf || object.not || object.if)
      throw new MissionProviderError('OUTPUT_INVALID', 'unsupported_schema');
    if (object.type === 'object') {
      object.additionalProperties = false;
      const keys = Object.keys((object.properties ?? {}) as object);
      if (keys.some((key) => !(object.required as string[] | undefined)?.includes(key)))
        throw new MissionProviderError('OUTPUT_INVALID', 'optional_schema_property');
    }
    for (const child of Object.values(object))
      if (child && typeof child === 'object') {
        if (Array.isArray(child)) child.forEach(inspect);
        else inspect(child);
      }
  };
  if (json.type !== 'object')
    throw new MissionProviderError('OUTPUT_INVALID', 'object_root_required');
  inspect(json);
  return json;
}
async function responseJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new MissionProviderError('OUTPUT_INVALID', 'empty_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_RESPONSE_BYTES)
        throw new MissionProviderError('OUTPUT_INVALID', 'response_too_large');
      chunks.push(result.value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error instanceof MissionProviderError
      ? error
      : new MissionProviderError('OUTPUT_INVALID', 'invalid_response_json');
  } finally {
    reader.releaseLock();
  }
}
function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export class ResponsesProvider implements MissionProvider {
  readonly calls: ProviderCallRecord[] = [];
  readonly budget: Budget;
  private readonly transport: typeof fetch;
  private readonly instructions: Readonly<Record<ModelRole, string>>;
  constructor(
    private readonly config: MissionConfig,
    private readonly options: { apiKey: string; transport?: typeof fetch; budget?: Budget },
  ) {
    // Capture every role before the first call, so planner edits affect only the next run.
    this.instructions = Object.freeze(
      Object.fromEntries(
        (Object.keys(rolePromptNames) as ModelRole[]).map((role) => [role, instruction(role)]),
      ) as Record<ModelRole, string>,
    );
    this.budget = options.budget ?? new Budget(config.limits);
    this.transport = options.transport ?? fetch;
  }
  async call<T>(
    role: ModelRole,
    input: unknown,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.options.apiKey) throw new MissionProviderError('API_ERROR', 'credentials_missing');
    if (signal?.aborted) throw new MissionProviderError('INTERRUPTED');
    const model = this.config.models[role];
    const instructions = this.instructions[role];
    const inputText = stableStringify(input);
    const payload = JSON.stringify({
      model: model.model,
      reasoning: { effort: model.reasoningEffort },
      max_output_tokens: model.maxOutputTokens,
      store: false,
      instructions,
      input: [{ role: 'user', content: [{ type: 'input_text', text: inputText }] }],
      text: {
        format: {
          type: 'json_schema',
          name: role,
          strict: true,
          schema: strictOutputSchema(schema),
        },
      },
    });
    if (Buffer.byteLength(payload) > this.config.limits.maxInputBytesPerCall)
      throw new MissionProviderError('BUDGET_EXCEEDED', 'input_too_large');
    const reservation = this.budget.reserve(model.maxOutputTokens);
    const started = performance.now();
    const record: ProviderCallRecord = {
      instructionsDigest: createHash('sha256').update(instructions).digest('hex'),
      inputDigest: createHash('sha256').update(inputText).digest('hex'),
      role,
      model: model.model,
      requestedModel: model.model,
      responseModel: null,
      reasoningEffort: model.reasoningEffort,
      status: 'running',
      startedAt: new Date().toISOString(),
      endedAt: null,
      durationMs: null,
      reservedOutputTokens: model.maxOutputTokens,
      usage: null,
      error: null,
    };
    this.calls.push(record);
    const controller = new AbortController();
    const abortGlobal = () => controller.abort(this.budget.signal.reason);
    const abortCaller = () => controller.abort(new MissionProviderError('INTERRUPTED'));
    this.budget.signal.addEventListener('abort', abortGlobal, { once: true });
    signal?.addEventListener('abort', abortCaller, { once: true });
    const timer = setTimeout(
      () => controller.abort(new MissionProviderError('API_TIMEOUT', 'request_deadline')),
      Math.min(this.config.limits.requestTimeoutSeconds * 1000, this.budget.remainingMs()),
    );
    let abortListener: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () =>
        reject(
          controller.signal.reason instanceof MissionProviderError
            ? controller.signal.reason
            : new MissionProviderError('INTERRUPTED'),
        );
      controller.signal.addEventListener('abort', abortListener, { once: true });
      if (controller.signal.aborted) abortListener();
    });
    try {
      const data = await Promise.race([
        (async () => {
          const response = await this.transport('https://api.openai.com/v1/responses', {
            method: 'POST',
            redirect: 'error',
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${this.options.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: payload,
          });
          if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            throw new MissionProviderError(
              response.status === 403 || response.status === 404
                ? 'MODEL_UNAVAILABLE'
                : 'API_ERROR',
              `http_${response.status}`,
            );
          }
          return responseJson(response);
        })(),
        aborted,
      ]);
      if (controller.signal.aborted) throw controller.signal.reason;
      this.budget.assertActive();
      record.responseModel = typeof data.model === 'string' ? data.model : null;
      const usage = data.usage as Record<string, unknown> | undefined;
      record.usage = usage
        ? {
            inputTokens: tokenCount(usage.input_tokens),
            outputTokens: tokenCount(usage.output_tokens),
          }
        : null;
      if (data.status !== 'completed')
        throw new MissionProviderError(
          'OUTPUT_INVALID',
          data.status === 'incomplete' ? 'incomplete' : 'response_not_completed',
        );
      const content = (Array.isArray(data.output) ? data.output : []).flatMap(
        (entry: { type?: string; content?: unknown[] }) =>
          entry.type === 'message' && Array.isArray(entry.content) ? entry.content : [],
      ) as { type?: string; text?: string }[];
      if (content.some((item) => item.type === 'refusal'))
        throw new MissionProviderError('OUTPUT_INVALID', 'refusal');
      const text = content
        .filter((item) => item.type === 'output_text')
        .map((item) => item.text ?? '')
        .join('');
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new MissionProviderError('OUTPUT_INVALID', 'invalid_output_json');
      }
      const result = schema.safeParse(parsed);
      if (!result.success) throw new MissionProviderError('OUTPUT_INVALID', 'schema_mismatch');
      this.budget.settle(reservation, record.usage?.outputTokens ?? null);
      this.budget.assertActive();
      record.status = 'completed';
      return result.data;
    } catch (error) {
      const safe =
        error instanceof MissionProviderError
          ? error
          : new MissionProviderError('API_ERROR', 'transport_failure');
      record.status =
        safe.code === 'INTERRUPTED' || safe.code === 'API_TIMEOUT' ? 'aborted' : 'failed';
      record.error = safe.message;
      this.budget.abort(safe);
      throw safe;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', abortListener);
      this.budget.signal.removeEventListener('abort', abortGlobal);
      signal?.removeEventListener('abort', abortCaller);
      this.budget.settle(reservation, record.usage?.outputTokens ?? null);
      record.endedAt = new Date().toISOString();
      record.durationMs = performance.now() - started;
    }
  }
}
