import { useEffect, useRef, useState } from 'react';
import type { Bootstrap } from '../../../packages/shared/api.js';
import type { PublicGameState } from '../../../packages/shared/game.js';
import { PlayApiError, playRequest } from './play-api.js';
import PlayScreen from './PlayScreen.js';

export default function JoinScreen({ bootstrap, initialInvite }: { bootstrap: Bootstrap; initialInvite: string | null }) {
  const [state, setState] = useState<PublicGameState | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const invite = useRef<string | null>(null);
  const initialized = useRef(false);
  async function join() {
    setLoading(true); setError('');
    try {
      try { setState(await playRequest<PublicGameState>('/api/play/state')); return; } catch (error) { if (!(error instanceof PlayApiError) || error.status !== 401) throw error; }
      if (invite.current) {
        await playRequest('/api/play/claim', { invite: invite.current });
        invite.current = null;
      }
      setState(await playRequest<PublicGameState>('/api/play/state'));
    } catch (error) {
      setError(error instanceof PlayApiError && error.status === 401
        ? 'この招待は使用できません。PCの管理画面で新しいQRコードを表示してください。'
        : error instanceof Error ? error.message : '参加できませんでした。');
    } finally { setLoading(false); }
  }
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    invite.current = initialInvite;
    if (window.location.hash) history.replaceState(null, '', window.location.pathname + window.location.search);
    void join();
  }, []);
  if (state) return <PlayScreen initialState={state} needsPassphrase={bootstrap.relay.authMode !== 'none'} />;
  return <main className="play-shell join-shell">
    <p className="play-brand">CALL <span>TO</span> PAST</p>
    <div className="join-orbit" aria-hidden="true">↗</div>
    <p className="play-eyebrow">A CALL FROM THE FUTURE</p>
    <h1>未来からの着信。<br /><span>応答しますか？</span></h1>
    <p className="join-copy">あなたの声と、身近なものの写真が<br />脱出への手がかりになる。</p>
    <div className="play-panel" role="status">{loading ? '招待を確認しています…' : error}</div>
    {!loading && <button className="primary-button" onClick={() => void join()}>参加を再試行</button>}
    <p className="play-footnote">スマートフォンでのプレイをおすすめします。<br />カメラとマイクを使用します。</p>
  </main>;
}