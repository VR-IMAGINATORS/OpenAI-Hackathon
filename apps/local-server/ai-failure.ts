import { z } from 'zod';

const codes = new Set([
  'UPSTREAM_FAILED',
  'REQUEST_LIMIT',
  'DRAINING',
  'PLAY_EXPIRED',
  'INVALID_REQUEST',
  'JUDGMENT_CONTEXT_LIMIT',
  'AI_OUTPUT_INCOMPLETE',
  'AI_OUTPUT_INVALID',
  'AI_OUTPUT_REFUSED',
  'INVALID_FACT_CHANGE',
  'INVALID_COMPLETION_FACT',
  'INVALID_INVENTORY_CHANGE',
  'INVALID_STRETCH_CANDIDATE',
  'UNKNOWN_CREATIVE_ATTEMPT',
  'CREATIVE_ATTEMPT_LIMIT',
  'ACTION_INVALID',
  'ACTION_FAILED',
  'CONTROL_CANCELLED',
  'INVESTIGATION_STALE',
]);

/** Only fixed diagnostic codes may leave the failure boundary, never provider text. */
export function aiFailureCode(error: unknown): string {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return 'AI_OUTPUT_INVALID';
  if (!error || typeof error !== 'object') return 'PROCESSING_ERROR';
  const value = error as { code?: unknown; message?: unknown };
  for (const candidate of [value.code, value.message])
    if (typeof candidate === 'string' && codes.has(candidate)) return candidate;
  return 'PROCESSING_ERROR';
}

export function canRetryJudgment(error: unknown): boolean {
  const code = aiFailureCode(error);
  if (code === 'UPSTREAM_FAILED') return (error as { status?: number }).status! >= 500;
  return [
    'AI_OUTPUT_INVALID',
    'AI_OUTPUT_INCOMPLETE',
    'INVALID_FACT_CHANGE',
    'INVALID_COMPLETION_FACT',
    'INVALID_INVENTORY_CHANGE',
    'INVALID_STRETCH_CANDIDATE',
    'UNKNOWN_CREATIVE_ATTEMPT',
  ].includes(code);
}
