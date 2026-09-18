import { useEffect, useState } from 'react';
import type { CodexLoginStatus } from '../../../packages/shared/api.js';
import { playRequest, PlayApiError } from './play-api.js';

export default function CodexLogin({
  locale,
  onReady,
}: {
  locale: 'ja' | 'en';
  onReady: (ready: boolean) => void;
}) {
  const [view, setView] = useState<CodexLoginStatus>({ status: 'disconnected' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const t = (ja: string, en: string) => (locale === 'ja' ? ja : en);
  useEffect(() => {
    onReady(view.status === 'ready' && !busy && !error);
  }, [view.status, busy, error, onReady]);
  useEffect(() => {
    if (busy) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await playRequest<CodexLoginStatus>('/api/codex/status');
        if (!stopped) {
          setView(result);
          setError('');
        }
      } catch (e) {
        if (stopped) return;
        if (e instanceof PlayApiError && (e.status === 401 || e.status === 410)) {
          setView({ status: 'disconnected' });
        } else setError(e instanceof Error ? e.message : 'Connection failed');
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), 2000);
      }
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [busy]);
  async function login() {
    setBusy(true);
    setError('');
    try {
      await playRequest('/api/auth', {});
      if (view.status === 'failed') await playRequest('/api/codex/logout', {});
      setView(await playRequest<CodexLoginStatus>('/api/codex/login', {}));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    setBusy(true);
    setError('');
    try {
      setView(await playRequest<CodexLoginStatus>('/api/codex/logout', {}));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Logout failed');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="codex-login" aria-label={t('プレイヤーのログイン', 'Player login')}>
      <h2>{t('あなたのChatGPTアカウントで遊ぶ', 'Play with your ChatGPT account')}</h2>
      <p>
        {t(
          'ゲーム判断に、あなたのCodex利用枠を使います。音声・画像生成・動画は運営のAPIを使用します。',
          'Game decisions use your Codex allowance. Voice, image generation and video use the operator’s API.',
        )}
      </p>
      <div role="status">
        {view.status === 'starting' && t('ログインを準備しています…', 'Preparing sign-in…')}
        {view.status === 'pending' && (
          <>
            <p>
              {t(
                '下の認証ページを開き、このコードを入力してください。本人のアカウントを選び、承認後にこの画面へ戻ってください。',
                'Open the verification page and enter this code. Choose your own account, approve, then return here.',
              )}
            </p>
            <code className="codex-code">{view.userCode}</code>
            <a
              className="codex-auth-link"
              href={view.verificationUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('OpenAIの認証ページを開く', 'Open OpenAI verification')}
            </a>
            <p>
              {t(
                '承認を待っています（約3分で期限切れ）。',
                'Waiting for approval (expires in about 3 minutes).',
              )}
            </p>
          </>
        )}
        {view.status === 'ready' && (
          <p>
            {t(
              '接続済み。難易度を選んで開始できます。',
              'Connected. Choose a difficulty to start.',
            )}{' '}
            <small>{view.model}</small>
          </p>
        )}
        {view.status === 'failed' && (
          <p>
            {t(
              '接続に失敗したか、期限が切れました。利用枠・モデルの利用可否を確認して再ログインしてください。',
              'Connection failed or expired. Check your allowance and model access, then sign in again.',
            )}
          </p>
        )}
      </div>
      {error && (
        <p className="play-error" role="alert">
          {error}
        </p>
      )}
      {['disconnected', 'failed'].includes(view.status) ? (
        <button type="button" disabled={busy} onClick={() => void login()}>
          {t('ChatGPTでログイン', 'Sign in with ChatGPT')}
        </button>
      ) : (
        <button type="button" disabled={busy} onClick={() => void logout()}>
          {view.status === 'ready'
            ? t('ログアウト / 別のアカウント', 'Sign out / change account')
            : t('キャンセル', 'Cancel')}
        </button>
      )}
      <small>
        {t(
          'このブラウザのプレイ専用です。プレイ終了時に接続を解除します。',
          'This connection belongs to this browser’s play and is removed when the play ends.',
        )}
      </small>
    </section>
  );
}
