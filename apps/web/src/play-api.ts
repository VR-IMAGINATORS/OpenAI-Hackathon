import type { PlayControl } from '../../../packages/shared/api.js';
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
): Promise<T> {
  const controller = new AbortController();
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
        publicMessages[value?.error?.code] ||
          value?.error?.message ||
          '通信を完了できませんでした。',
        response.status,
        value?.error?.code,
      );
    return value as T;
  } catch (error) {
    if (error instanceof PlayApiError) throw error;
    throw new PlayApiError(
      controller.signal.aborted
        ? '通信がタイムアウトしました。同じ要求で再確認してください。'
        : '通信できません。ネットワークを確認してください。',
      0,
    );
  } finally {
    window.clearTimeout(timer);
  }
}
export async function retryUncertain<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (error instanceof PlayApiError && error.status === 0) return request();
    throw error;
  }
}
