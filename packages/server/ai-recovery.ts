import { AiServiceError } from './ai-service.js';
import { EndingRequestError } from './ending-ai-request.js';
import { UpstreamError } from './openai.js';

/** Caller still enforces its cancellation signal, deadline and attempt budget. */
export function recoverableAiError(error: unknown): boolean {
  if (error instanceof AiServiceError)
    return error.code === 'ENDING_CALL_TIMEOUT' || error.code === 'MEDIA_CALL_TIMEOUT';
  if (error instanceof EndingRequestError) return false;
  if (error instanceof UpstreamError) {
    const status = error.upstreamStatus;
    return status === undefined || status === 408 || status === 429 || status >= 500;
  }
  if (
    error instanceof Error &&
    [
      'ENDING_RESPONSE_REFUSED',
      'INSPECTION_REFUSED',
      'ENDING_CANCELLED',
      'ENDING_EXPIRED',
      'ENDING_DRAINING',
    ].includes(error.message)
  )
    return false;
  // Malformed output, unreadable images and network errors can improve on another attempt.
  return error instanceof Error;
}

/** A local direction can also survive exhausted text budget or an oversized AI request. */
export function canUseAftermathDirection(error: unknown): boolean {
  return (
    recoverableAiError(error) ||
    error instanceof EndingRequestError ||
    (error instanceof AiServiceError && error.code === 'REQUEST_LIMIT')
  );
}
