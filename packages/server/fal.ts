import { MAX_ENDING_VIDEO_BYTES } from './ending-video-media.js';

export const FAL_VIDEO_MODEL = 'minimax/h3-max-turbo/image-to-video';
const QUEUE_ORIGIN = 'https://queue.fal.run';
const QUEUE_APP = 'minimax/h3-max-turbo';
const SUBMIT_RESPONSE_BYTES = 64 * 1024;
const QUERY_RESPONSE_BYTES = 256 * 1024;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface FalVideoInput {
  prompt: string;
  startImageDataUrl: string;
  endImageDataUrl: string;
}
export interface FalRequestHandle {
  requestId: string;
  statusUrl: string;
  resultUrl: string;
  cancelUrl: string;
}
export interface FalTransport {
  submit(input: FalVideoInput, signal?: AbortSignal): Promise<FalRequestHandle>;
  status(
    handle: FalRequestHandle,
    signal?: AbortSignal,
  ): Promise<'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED'>;
  result(handle: FalRequestHandle, signal?: AbortSignal): Promise<{ videoUrl: string }>;
  cancel(handle: FalRequestHandle, signal?: AbortSignal): Promise<{ stopConfirmed: boolean }>;
  downloadVideo(videoUrl: string, signal?: AbortSignal): Promise<Buffer>;
}

// Never attach provider response bodies, prompts, URLs, or authorization to errors.
export class FalTransportError extends Error {
  constructor(
    public readonly code: string = 'FAL_TRANSPORT_FAILED',
    public readonly terminal = false,
  ) {
    super('Ending video provider request failed');
    this.name = 'FalTransportError';
  }
}
export class FalSubmitError extends FalTransportError {
  constructor(
    public readonly acceptance: 'rejected' | 'unknown',
    public readonly requestHandle?: FalRequestHandle,
    public readonly httpStatus?: number,
  ) {
    super('FAL_SUBMIT_FAILED', acceptance === 'rejected');
    this.name = 'FalSubmitError';
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FalTransportError('FAL_INVALID_RESPONSE');
  }
  return value as Record<string, unknown>;
}

function canonicalHandle(requestId: unknown): FalRequestHandle {
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
    throw new FalTransportError('FAL_INVALID_RESPONSE');
  }
  const base = `${QUEUE_ORIGIN}/${QUEUE_APP}/requests/${requestId}`;
  return { requestId, statusUrl: base + '/status', resultUrl: base, cancelUrl: base + '/cancel' };
}

function queueUrl(value: unknown, requestId: string, kind: 'status' | 'result' | 'cancel'): string {
  const suffixes = kind === 'result' ? ['', '/response'] : ['/' + kind];
  // Compare complete strings; URL normalization must not hide encoded paths or traversal.
  for (const app of [QUEUE_APP, FAL_VIDEO_MODEL]) {
    for (const suffix of suffixes) {
      const expected = `${QUEUE_ORIGIN}/${app}/requests/${requestId}${suffix}`;
      if (value === expected) return expected;
    }
  }
  throw new FalTransportError('FAL_INVALID_URL');
}

function validateHandle(handle: FalRequestHandle): FalRequestHandle {
  canonicalHandle(handle.requestId);
  return {
    requestId: handle.requestId,
    statusUrl: queueUrl(handle.statusUrl, handle.requestId, 'status'),
    resultUrl: queueUrl(handle.resultUrl, handle.requestId, 'result'),
    cancelUrl: queueUrl(handle.cancelUrl, handle.requestId, 'cancel'),
  };
}

function validateMediaUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 || /[\s\\]/.test(value)) {
    throw new FalTransportError('FAL_INVALID_URL');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new FalTransportError('FAL_INVALID_URL');
  }
  if (
    url.protocol !== 'https:' ||
    (url.hostname !== 'fal.media' && !url.hostname.endsWith('.fal.media')) ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    throw new FalTransportError('FAL_INVALID_URL');
  }
  return url.href;
}

function validateImage(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 1_398_127 ||
    !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new FalSubmitError('rejected');
  }
  const base64 = value.slice('data:image/jpeg;base64,'.length);
  const bytes = Buffer.from(base64, 'base64');
  if (
    bytes.length > 1024 * 1024 ||
    bytes.length < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes.toString('base64') !== base64
  ) {
    throw new FalSubmitError('rejected');
  }
  return value;
}

async function boundedBody(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    void response.body?.cancel().catch(() => {});
    throw new FalTransportError('FAL_RESPONSE_TOO_LARGE');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new FalTransportError('FAL_INVALID_RESPONSE');
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new FalTransportError('FAL_RESPONSE_TOO_LARGE');
      chunks.push(chunk.value);
    }
    if (
      declared !== null &&
      !response.headers.get('content-encoding') &&
      Number(declared) !== size
    ) {
      throw new FalTransportError('FAL_INVALID_RESPONSE');
    }
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
  }
}

export function createFalTransport(apiKey: string, request: typeof fetch = fetch): FalTransport {
  if (!apiKey || /[\r\n]/.test(apiKey)) throw new FalTransportError('FAL_CONFIG_INVALID');

  async function exchange<T>(
    url: string,
    options: RequestInit,
    signal: AbortSignal | undefined,
    read: (response: Response, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 30_000);
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try {
      combined.throwIfAborted();
      const response = await request(url, { ...options, redirect: 'error', signal: combined });
      // Also reject redirected responses from injected implementations.
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        void response.body?.cancel().catch(() => {});
        throw new FalTransportError('FAL_REDIRECT_REJECTED');
      }
      return await read(response, combined);
    } catch (error) {
      if (error instanceof FalTransportError) throw error;
      throw new FalTransportError(combined.aborted ? 'FAL_ABORTED' : 'FAL_TRANSPORT_FAILED');
    } finally {
      clearTimeout(timer);
    }
  }

  async function json(response: Response, signal: AbortSignal, limit = QUERY_RESPONSE_BYTES) {
    try {
      return object(JSON.parse((await boundedBody(response, limit, signal)).toString('utf8')));
    } catch (error) {
      if (error instanceof FalTransportError) throw error;
      throw new FalTransportError('FAL_INVALID_RESPONSE');
    }
  }
  const headers = { Authorization: 'Key ' + apiKey, Accept: 'application/json' };

  return {
    async submit(input, signal) {
      if (
        typeof input.prompt !== 'string' ||
        !input.prompt.trim() ||
        Buffer.byteLength(input.prompt) > 32_000
      ) {
        throw new FalSubmitError('rejected');
      }
      const body = JSON.stringify({
        prompt: input.prompt,
        image_url: validateImage(input.startImageDataUrl),
        end_image_url: validateImage(input.endImageDataUrl),
        duration: 15,
        resolution: '768P',
        prompt_expansion_mode: 'balanced',
        enable_safety_checker: true,
      });
      if (signal?.aborted) throw new FalSubmitError('rejected');
      let recovery: FalRequestHandle | undefined;
      try {
        return await exchange(
          `${QUEUE_ORIGIN}/${FAL_VIDEO_MODEL}`,
          {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json', 'X-Fal-No-Retry': '1' },
            body,
          },
          signal,
          async (response, currentSignal) => {
            if (!response.ok) {
              void response.body?.cancel().catch(() => {});
              // These statuses conclusively reject an input/auth/capacity request. Network,
              // timeout, conflict, and 5xx errors may have happened after queue acceptance.
              const rejected = [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(
                response.status,
              );
              throw new FalSubmitError(
                rejected ? 'rejected' : 'unknown',
                undefined,
                response.status,
              );
            }
            const payload = await json(response, currentSignal, SUBMIT_RESPONSE_BYTES);
            recovery = canonicalHandle(payload.request_id);
            return validateHandle({
              requestId: recovery.requestId,
              statusUrl:
                payload.status_url === undefined
                  ? recovery.statusUrl
                  : (payload.status_url as string),
              resultUrl:
                payload.response_url === undefined
                  ? recovery.resultUrl
                  : (payload.response_url as string),
              cancelUrl:
                payload.cancel_url === undefined
                  ? recovery.cancelUrl
                  : (payload.cancel_url as string),
            });
          },
        );
      } catch (error) {
        if (error instanceof FalSubmitError) throw error;
        throw new FalSubmitError('unknown', recovery);
      }
    },
    async status(handle, signal) {
      const trusted = validateHandle(handle);
      return exchange(trusted.statusUrl, { headers }, signal, async (response, currentSignal) => {
        const payload = await json(response, currentSignal);
        if (payload.request_id !== undefined && payload.request_id !== trusted.requestId) {
          throw new FalTransportError('FAL_INVALID_RESPONSE');
        }
        if (response.status === 404 && payload.status === 'NOT_FOUND') {
          throw new FalTransportError('FAL_REQUEST_NOT_FOUND', true);
        }
        if (!response.ok) throw new FalTransportError();
        if (payload.response_url !== undefined)
          queueUrl(payload.response_url, trusted.requestId, 'result');
        if (payload.status === 'COMPLETED') {
          if (payload.error || payload.error_type)
            throw new FalTransportError('FAL_REQUEST_FAILED', true);
          return 'COMPLETED';
        }
        if (payload.status === 'IN_QUEUE' || payload.status === 'IN_PROGRESS')
          return payload.status;
        throw new FalTransportError('FAL_INVALID_RESPONSE');
      });
    },
    async result(handle, signal) {
      const trusted = validateHandle(handle);
      return exchange(trusted.resultUrl, { headers }, signal, async (response, currentSignal) => {
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new FalTransportError('FAL_RESULT_FAILED');
        }
        const payload = await json(response, currentSignal);
        if (payload.request_id !== undefined && payload.request_id !== trusted.requestId) {
          throw new FalTransportError('FAL_INVALID_RESPONSE');
        }
        const video = object(payload.video);
        if (
          video.file_size !== undefined &&
          (typeof video.file_size !== 'number' ||
            !Number.isSafeInteger(video.file_size) ||
            video.file_size <= 0 ||
            video.file_size > MAX_ENDING_VIDEO_BYTES)
        )
          throw new FalTransportError('FAL_RESPONSE_TOO_LARGE');
        return { videoUrl: validateMediaUrl(video.url) };
      });
    },
    async cancel(handle, signal) {
      const trusted = validateHandle(handle);
      return exchange(
        trusted.cancelUrl,
        { method: 'PUT', headers },
        signal,
        async (response, currentSignal) => {
          const payload = await json(response, currentSignal);
          if (payload.request_id !== undefined && payload.request_id !== trusted.requestId) {
            throw new FalTransportError('FAL_INVALID_RESPONSE');
          }
          if (
            (response.status === 400 && payload.status === 'ALREADY_COMPLETED') ||
            (response.status === 404 && payload.status === 'NOT_FOUND')
          )
            return { stopConfirmed: true };
          if (response.status === 202 && payload.status === 'CANCELLATION_REQUESTED') {
            return { stopConfirmed: false };
          }
          throw new FalTransportError('FAL_CANCEL_UNCONFIRMED');
        },
      );
    },
    async downloadVideo(videoUrl, signal) {
      const trusted = validateMediaUrl(videoUrl);
      // Media requests deliberately have no queue credentials, cookies, or custom headers.
      return exchange(trusted, { credentials: 'omit' }, signal, async (response, currentSignal) => {
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new FalTransportError('FAL_DOWNLOAD_FAILED');
        }
        return boundedBody(response, MAX_ENDING_VIDEO_BYTES, currentSignal);
      });
    },
  };
}
