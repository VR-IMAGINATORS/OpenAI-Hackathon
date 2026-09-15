const MAX_IMAGE_BYTES = 256 * 1024;

class MediaReadError extends Error {
  constructor(readonly retryable: boolean) {
    super('Image unavailable');
  }
}

/** Retry retrieval of an existing asset only; this never requests image generation. */
export async function readImageAsset(
  url: string,
  headers: HeadersInit,
  signal: AbortSignal,
  options: { fetch?: typeof fetch; retryMs?: number; timeoutMs?: number } = {},
): Promise<Blob> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), options.timeoutMs ?? 15_000);
    const current = AbortSignal.any([signal, deadline.signal]);
    try {
      const response = await (options.fetch ?? fetch)(url, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers,
        signal: current,
      });
      const length = response.headers.get('content-length');
      if (
        !response.ok ||
        response.headers.get('content-type')?.split(';')[0] !== 'image/jpeg' ||
        (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_IMAGE_BYTES))
      ) {
        await response.body?.cancel().catch(() => {});
        throw new MediaReadError(
          response.status === 408 || response.status === 429 || response.status >= 500,
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new MediaReadError(true);
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let size = 0;
      const abort = () => {
        void reader.cancel().catch(() => {});
      };
      current.addEventListener('abort', abort, { once: true });
      try {
        for (;;) {
          current.throwIfAborted();
          const chunk = await reader.read();
          current.throwIfAborted();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MAX_IMAGE_BYTES) throw new MediaReadError(false);
          chunks.push(new Uint8Array(chunk.value));
        }
        if (!size) throw new MediaReadError(true);
        return new Blob(chunks, { type: 'image/jpeg' });
      } finally {
        current.removeEventListener('abort', abort);
        await reader.cancel().catch(() => {});
      }
    } catch (error) {
      signal.throwIfAborted();
      if (attempt >= 2 || (error instanceof MediaReadError && !error.retryable)) throw error;
    } finally {
      clearTimeout(timer);
    }
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        clearTimeout(wait);
        reject(signal.reason);
      };
      const wait = setTimeout(
        () => {
          signal.removeEventListener('abort', stop);
          resolve();
        },
        (options.retryMs ?? 1000) * 2 ** attempt,
      );
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
    });
  }
}
