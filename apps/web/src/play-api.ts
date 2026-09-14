import type { PlayControl } from '../../../packages/shared/api.js';
import type { EndingView } from '../../../packages/shared/ending.js';
let apiLocale: 'ja' | 'en' = 'en';
export function setApiLocale(locale: 'ja' | 'en') {
  apiLocale = locale;
}
const englishMessages: Record<string, string> = {
  AUTH_REQUIRED: 'Enter the shared passphrase to join.',
  AUTH_FAILED: 'Incorrect passphrase. Check the passphrase shared by the host.',
  AUTH_RATE_LIMIT: 'Too many attempts. Wait a moment and try again.',
  SESSION_EXPIRED: 'Your session expired. Please join again.',
  PLAY_EXPIRED: 'This play has ended or expired. Please start again.',
  CONTROL_BUSY: 'Another screen is connected. Reconnect here to take over.',
  CONTROL_STALE: 'Control has moved to another screen.',
  REQUEST_LIMIT: 'The service is busy or waiting for a previous call to end. Try again shortly.',
  PHOTO_BUSY: 'Your photo is being processed. Please wait.',
  DRAINING: 'The server is updating. Please join again shortly.',
  LIVE_CREATE_UNCONFIRMED: 'The voice connection could not be confirmed. Please contact the host.',
  PLAY_CAPACITY: 'All play slots are occupied. Please try again shortly.',
};
export const clientId = crypto.randomUUID();
export function controlHeaders(control: PlayControl | { playId: string }) {
  return {
    'X-Play-Id': control.playId,
    ...('clientId' in control
      ? { 'X-Client-Id': control.clientId, 'X-Control-Epoch': String(control.controlEpoch) }
      : {}),
  };
}
const publicMessages: Record<string, string> = {
  AUTH_REQUIRED: '合言葉を入力して参加してください。',
  AUTH_FAILED: '合言葉が違います。運営から共有された内容を確認してください。',
  AUTH_RATE_LIMIT: '合言葉の確認回数が上限に達しました。しばらく待って再試行してください。',
  AUTH_CAPACITY: '現在参加を受け付けられません。しばらく待って再試行してください。',
  SESSION_EXPIRED:
    'セッションが失効しました。期限切れやサーバー更新の可能性があります。合言葉で参加し直してください。',
  PLAY_EXPIRED: '体験が終了したか、復帰できる時間を過ぎました。最初から遊び直してください。',
  CONTROL_BUSY: '別の画面で接続中です。「この画面で再接続」で引き継げます。',
  REQUEST_LIMIT:
    'APIの利用上限、または前の音声の終了確認待ちです。時間をおいて再試行してください。',
  LIVE_CREATE_UNCONFIRMED: '音声接続の作成結果を確認できません。運営による確認が必要です。',
  PHOTO_BUSY: '写真を処理しています。少し待って再試行してください。',
  DRAINING: 'サーバー更新中です。更新後にもう一度参加してください。',
};
export class PlayApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code = 'NETWORK_ERROR',
  ) {
    super(message);
  }
}
export async function playRequest<T>(
  path: string,
  body?: unknown,
  method = 'POST',
  control?: PlayControl | { playId: string },
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = window.setTimeout(() => controller.abort(), 40000);
  try {
    const response = await fetch(path, {
      method: body === undefined && method === 'POST' ? 'GET' : method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(control ? controlHeaders(control) : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const value = await response.json();
    if (!response.ok)
      throw new PlayApiError(
        apiLocale === 'en'
          ? (englishMessages[value?.error?.code] ??
            'Unable to complete the request. Please try again.')
          : publicMessages[value?.error?.code] ||
            value?.error?.message ||
            '通信を完了できませんでした。',
        response.status,
        value?.error?.code,
      );
    return value as T;
  } catch (error) {
    if (error instanceof PlayApiError) throw error;
    throw new PlayApiError(
      apiLocale === 'en'
        ? controller.signal.aborted
          ? 'The request timed out. Retry to check its result.'
          : 'Unable to connect. Please check your network.'
        : controller.signal.aborted
          ? '通信がタイムアウトしました。同じ要求で再確認してください。'
          : '通信できません。ネットワークを確認してください。',
      0,
    );
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
export function endingVideoPath(playId: string): string {
  return '/api/play/ending/video?playId=' + encodeURIComponent(playId);
}
/** Reading an ending never creates or retries a generation job. */
export function getEnding(playId: string, signal?: AbortSignal): Promise<EndingView> {
  return playRequest(
    '/api/play/ending?playId=' + encodeURIComponent(playId),
    undefined,
    'GET',
    undefined,
    signal,
  );
}
export async function retryUncertain<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof PlayApiError && error.status === 0) return request();
    throw error;
  }
}
