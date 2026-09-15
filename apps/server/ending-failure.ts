import { ZodError } from 'zod';
import { AiServiceError } from '../../packages/server/ai-service.js';
import { UpstreamError } from '../../packages/server/openai.js';
import { FalSubmitError, FalTransportError } from '../../packages/server/fal.js';
import { EndingVideoMediaError } from '../../packages/server/ending-video-media.js';
import { EndingSourceError, EndingEvidenceError } from '../local-server/ending-ai.js';
import { EndingRequestError } from '../../packages/server/ending-ai-request.js';

export type EndingStage =
  | 'reference'
  | 'story'
  | 'story_retry'
  | 'extraction'
  | 'direction'
  | 'start_frame'
  | 'start_inspection'
  | 'end_frame'
  | 'end_inspection'
  | 'video_submit'
  | 'video_status'
  | 'video_result'
  | 'video_download'
  | 'video_validation'
  | 'storage';

export interface EndingFailureContext {
  clearedCount: number;
  actionCount: number;
  failedActionCount: number;
  durationMs?: number;
  remainingMs?: number;
  evidenceRecordCount?: number;
  evidenceBytes?: number;
  validationFields?: string;
  invalidSourceCount?: number;
  actionSourceMixupCount?: number;
  eventSourceMixupCount?: number;
  quoteMismatchCount?: number;
}

export function endingSourceCounts(error: unknown) {
  return error instanceof EndingSourceError || error instanceof EndingEvidenceError
    ? error.counts
    : {};
}

/** Only schema-owned field names; never include issues, inputs or upstream text. */
export function endingValidationFields(error: unknown): string | undefined {
  if (error instanceof EndingRequestError) return error.validationFields;
  if (!(error instanceof ZodError)) return undefined;
  const allowed = new Set([
    'title',
    'story',
    'evaluation',
    'tag',
    'usedEvidenceIds',
    'clues',
    'usedActionIds',
    'candidates',
    'selectionReason',
    'mode',
    'startPrompt',
    'endPrompt',
    'videoPrompt',
  ]);
  return [
    ...new Set(
      error.issues.map((issue) =>
        typeof issue.path[0] === 'string' && allowed.has(issue.path[0])
          ? issue.path[0]
          : 'response',
      ),
    ),
  ]
    .sort()
    .join(',');
}

/** Only fixed categories and HTTP status codes are public; never stringify an upstream error. */
export function endingFailureCode(error: unknown, stage: EndingStage): string {
  const prefix = 'ENDING_' + stage.toUpperCase() + '_';
  if (error instanceof EndingRequestError) return prefix + 'INVALID_REQUEST';
  if (error instanceof AiServiceError) {
    if (error.code === 'INVALID_REQUEST') return prefix + 'INVALID_REQUEST';
    if (error.code === 'REQUEST_LIMIT') return 'ENDING_AI_BUDGET_EXHAUSTED';
    if (error.code === 'ENDING_EVIDENCE_BUDGET') return prefix + 'BUDGET_RESERVED';
    if (error.code === 'ENDING_EXPIRED' || error.code === 'ENDING_CALL_TIMEOUT')
      return prefix + 'TIMEOUT';
  }
  const httpStatus = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599;
  if (error instanceof UpstreamError && httpStatus(error.upstreamStatus))
    return prefix + 'HTTP_' + error.upstreamStatus;
  if (error instanceof FalSubmitError)
    return (
      prefix +
      (error.acceptance === 'unknown'
        ? 'UNCONFIRMED'
        : httpStatus(error.httpStatus)
          ? 'HTTP_' + error.httpStatus
          : 'REJECTED')
    );
  if (error instanceof FalTransportError) return prefix + 'PROVIDER_FAILED';
  if (error instanceof EndingVideoMediaError) return 'ENDING_VIDEO_INVALID_MEDIA';
  if (error instanceof ZodError || error instanceof SyntaxError) return prefix + 'INVALID_RESPONSE';
  const known: Record<string, string> = {
    ENDING_INVALID_SOURCES: 'INVALID_SOURCES',
    ENDING_INVALID_CONTINUITY: 'INVALID_CONTINUITY',
    ENDING_INVALID_ITEM_COVERAGE: 'INVALID_ITEM_COVERAGE',
    ENDING_INVALID_EVIDENCE: 'INVALID_EVIDENCE',
    ENDING_INVALID_TAG_EVIDENCE: 'INVALID_TAG_EVIDENCE',
    ENDING_EVIDENCE_TOO_LARGE: 'EVIDENCE_TOO_LARGE',
    ENDING_EVIDENCE_TIMEOUT: 'TIMEOUT',
    ENDING_INVALID_RESPONSE: 'INVALID_RESPONSE',
    ENDING_RESPONSE_INCOMPLETE: 'RESPONSE_INCOMPLETE',
    ENDING_RESPONSE_REFUSED: 'RESPONSE_REFUSED',
    ENDING_FRAME_DIMENSIONS: 'INVALID_DIMENSIONS',
    ENDING_FRAME_REJECTED: 'REJECTED',
    ENDING_INSPECTION_UNKNOWN: 'UNCERTAIN',
    ENDING_REFERENCE_MISSING: 'MISSING',
    ENDING_REFERENCE_FAILED: 'FAILED',
    SCENE_VERSION: 'VERSION_MISMATCH',
    RESULT_CAPACITY: 'CAPACITY',
    VIDEO_CAPACITY: 'CAPACITY',
  };
  return (
    prefix +
    (error instanceof Error && Object.hasOwn(known, error.message)
      ? known[error.message]
      : 'FAILED')
  );
}
