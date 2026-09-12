import JoinScreen from './JoinScreen.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ApiError, Bootstrap, ConnectionResult } from '../../../packages/shared/api.js';

type CheckState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'success'; result: ConnectionResult }
  | { kind: 'error'; message: string };

async function requestJson<T>(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = window.setTimeout(abort, 20_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error('応答を読み取れませんでした。ローカルサーバーの状態を確認してください。');
    }
    if (!response.ok) {
      const apiError = body as Partial<ApiError> | null;
      const message = apiError?.error?.message;
      throw new Error(typeof message === 'string' ? message : '接続を確認できませんでした。時間をおいて再度お試しください。');
    }
    return body as T;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('通信が時間内に完了しませんでした。サーバーの状態を確認して再度お試しください。');
    if (error instanceof TypeError) throw new Error('ローカルサーバーに接続できません。起動状態を確認して再度お試しください。');
    throw error;
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes ? `${minutes}分` : ''}${remainder ? `${remainder}秒` : ''}`;
}

function PhoneIcon({ className = '' }: { className?: string }) {
  return <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6.7 3.5 4 4.3c-1 .3-1.4 1.3-1.1 2.3 2 7 7.5 12.5 14.5 14.5 1 .3 2-.1 2.3-1.1l.8-2.7a1.5 1.5 0 0 0-.8-1.8l-3.1-1.4c-.6-.3-1.3-.1-1.7.4l-1 1.2a13.2 13.2 0 0 1-5.6-5.6l1.2-1c.5-.4.7-1.1.4-1.7L8.5 4.3a1.5 1.5 0 0 0-1.8-.8Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function ArrowIcon() {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function FoundationScreen() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [check, setCheck] = useState<CheckState>({ kind: 'idle' });
  const submitting = useRef(false);

  const loadBootstrap = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError('');
    setCheck({ kind: 'idle' });
    try {
      const data = await requestJson<Bootstrap>('/api/bootstrap', {}, signal);
      if (!data?.scenario?.rules || data.app?.stage !== 'foundation' || !data.relay) {
        throw new Error('設定の応答形式が正しくありません。ローカルサーバーの状態を確認してください。');
      }
      if (!signal?.aborted) setBootstrap(data);
    } catch (error) {
      if (!signal?.aborted) {
        setBootstrap(null);
        setLoadError(error instanceof Error ? error.message : '設定を読み込めませんでした。');
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadBootstrap(controller.signal);
    return () => controller.abort();
  }, [loadBootstrap]);

  const needsPassphrase = bootstrap?.relay.authMode === 'required';
  const reachable = bootstrap?.relay.reachable === true;
  const pending = check.kind === 'pending';
  const success = check.kind === 'success';

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current || loading || !reachable || (needsPassphrase && !passphrase)) return;
    submitting.current = true;
    setCheck({ kind: 'pending' });
    try {
      const result = await requestJson<ConnectionResult>('/api/connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(needsPassphrase ? { passphrase } : {}),
      });
      if (result?.kind !== 'mock' || typeof result.message !== 'string' || !Array.isArray(result.path) || !result.path.every((part) => typeof part === 'string')) {
        throw new Error('モック接続の確認結果を読み取れませんでした。');
      }
      setPassphrase('');
      setCheck({ kind: 'success', result });
    } catch (error) {
      setCheck({ kind: 'error', message: error instanceof Error ? error.message : '接続を確認できませんでした。' });
    } finally {
      submitting.current = false;
    }
  }

  const status = loading ? '設定を読み込み中' : loadError || !reachable ? '接続先を確認してください' : pending ? '回線を確認しています' : success ? 'モック接続を確認済み' : '接続確認を待っています';

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="wordmark" href="#main" aria-label="Call to Past、メインへ"><span className="brand-icon"><PhoneIcon /></span><span>CALL <span className="wordmark-to">TO</span> PAST</span></a>
        <span className="stage-badge"><span className="status-dot" />開発用・モック接続</span>
      </header>

      <main id="main" className="main-grid">
        <section className="story-column" aria-labelledby="intro-title">
          <p className="eyebrow"><span className="eyebrow-line" /> A CALL FROM THE FUTURE</p>
          <h1 id="intro-title">一枚の写真が、<br /><span>未来を変える。</span></h1>
          <p className="intro-copy">身近なものを、未来の誰かの切り札に。<br className="desktop-break" />写真とあなたのアイデアで、脱出への道を切りひらく。</p>
          <div className="scenario-card" aria-busy={loading}>
            <div className="card-caption"><span>SCENARIO / 01</span><span className="caption-tag">設定プレビュー</span></div>
            {bootstrap ? <>
              <h2>{bootstrap.scenario.title}</h2>
              <p className="scenario-briefing">{bootstrap.scenario.playerBriefing}</p>
              <dl className="rules-grid">
                <div><dt>突破する障害</dt><dd>{bootstrap.scenario.obstacleCount}<span>つ</span></dd></div>
                <div><dt>行動上限</dt><dd>{bootstrap.scenario.rules.maxActions}<span>回</span></dd></div>
                <div><dt>写真 / 行動</dt><dd>{bootstrap.scenario.rules.maxPhotosPerAction}<span>枚まで</span></dd></div>
                <div><dt>制限時間</dt><dd className="time-value">{formatTime(bootstrap.scenario.rules.totalTimeSeconds)}</dd></div>
              </dl>
              <p className="settings-note">プレイ開始時の設定値です。この画面では時計は進みません。</p>
            </> : <div className="scenario-placeholder"><h2>{loading ? 'シナリオを読み込み中…' : 'シナリオを取得できませんでした'}</h2><p>ローカルサーバーから、現在のシナリオと設定を読み込みます。</p></div>}
          </div>
          <p className="concept-note"><span className="small-cross">＋</span> 正解の道具より、あなたならではの使い方。</p>
        </section>

        <section className={`connection-card${success ? ' is-connected' : ''}`} aria-labelledby="connection-title">
          <div className="connection-topline"><span>FUTURE LINK</span><span className="channel-label">MOCK CHANNEL</span></div>
          <div className={`signal-visual${pending ? ' is-checking' : ''}`} aria-hidden="true">
            <div className="orbit orbit-outer" /><div className="orbit orbit-inner" />
            <div className="phone-core"><PhoneIcon /></div>
            <div className="waveform">{[10, 18, 28, 15, 35, 23, 42, 25, 16, 32, 20, 12].map((height, index) => <span key={index} style={{ height: `${height}px`, animationDelay: `${index * 80}ms` }} />)}</div>
          </div>
          <div className="connection-heading"><p className="connection-kicker">CONNECTION SETUP</p><h2 id="connection-title">まずは、接続の準備から。</h2><p>未来への回線をつなぐ、その前に。<br />モックで通信経路を確認します。</p></div>
          <div className={`connection-status${success ? ' status-success' : ''}${check.kind === 'error' || loadError || (!loading && !reachable) ? ' status-error' : ''}`} role="status" aria-live="polite" aria-atomic="true"><span className="status-dot" />{status}</div>

          {loadError || (!loading && !reachable) ? <div className="recovery-panel">
            <p role="alert">{loadError || '中継サーバーに接続できません。起動状態と接続先の設定を確認してください。'}</p>
            <button className="secondary-button" type="button" onClick={() => void loadBootstrap()} disabled={loading}>{loading ? '確認中…' : '状態を再確認'}<ArrowIcon /></button>
          </div> : <form onSubmit={handleSubmit} className="connection-form" aria-busy={pending || loading}>
            {needsPassphrase && <div className="field-group"><label htmlFor="passphrase">接続用の合言葉</label><input id="passphrase" type="password" name="passphrase" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={256} required disabled={pending || loading} aria-describedby="passphrase-help" placeholder="共有された合言葉を入力" /><p id="passphrase-help" className="field-help">運営から共有された合言葉を入力してください。</p></div>}
            {!loading && !needsPassphrase && <p className="auth-note">この中継サーバーでは合言葉の入力は不要です。</p>}
            <button className="primary-button" type="submit" disabled={loading || pending || !reachable || (needsPassphrase && !passphrase)}><span>{loading ? '設定を読み込み中…' : pending ? '通信経路を確認中…' : success ? 'もう一度接続を確認' : 'モック接続を確認'}</span><ArrowIcon /></button>
          </form>}

          <div className="result-region" aria-live="polite" aria-atomic="true">
            {check.kind === 'error' && <p className="result-message error-message" role="alert">{check.message}</p>}
            {check.kind === 'success' && <div className="result-message success-message"><strong>モックの往復通信を確認しました。</strong><p>{check.result.message}</p><p className="request-path">{check.result.path.join(' → ')}</p></div>}
          </div>
          <div className="foundation-note"><span className="note-icon" aria-hidden="true">i</span><p>現在は通信確認用の開発画面です。<br />音声会話・写真送信・ゲーム進行は、まだ利用できません。</p></div>
        </section>
      </main>

      <footer className="site-footer"><span>現代のひらめきを、未来へ。</span><span>FOUNDATION BUILD <span className="footer-divider">/</span> NO LIVE AI</span></footer>
    </div>
  );
}
const initialInvite = new URLSearchParams(window.location.hash.slice(1)).get('invite');
if (initialInvite) history.replaceState(null, '', window.location.pathname + window.location.search);

export default function App() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [error, setError] = useState('');
  const load = () => { setError(''); void requestJson<Bootstrap>('/api/bootstrap').then(setBootstrap).catch(error => setError(error.message)); };
  useEffect(load, []);
  if (!bootstrap) return <main className="play-shell join-shell"><p className="play-brand">CALL TO PAST</p><h1>未来への回線を<br />準備しています。</h1><p role="status">{error || '接続先を確認中…'}</p>{error && <button className="primary-button" onClick={load}>もう一度確認</button>}</main>;
  return bootstrap.app.stage === 'mobile-playtest' ? <JoinScreen bootstrap={bootstrap} initialInvite={initialInvite} /> : <FoundationScreen />;
}