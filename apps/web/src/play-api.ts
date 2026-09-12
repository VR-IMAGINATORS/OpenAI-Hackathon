export class PlayApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}
export async function playRequest<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 40_000);
  try {
    const response = await fetch(path, {
      method: body === undefined && method === 'POST' ? 'GET' : method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const value = await response.json();
    if (!response.ok)
      throw new PlayApiError(
        value?.error?.message || '通信を完了できませんでした。',
        response.status,
      );
    return value as T;
  } catch (error) {
    if (error instanceof PlayApiError) throw error;
    throw new PlayApiError(
      controller.signal.aborted
        ? '通信がタイムアウトしました。状態を確認して再試行してください。'
        : '通信できません。ネットワークとPCの起動状態を確認してください。',
      0,
    );
  } finally {
    window.clearTimeout(timer);
  }
}
