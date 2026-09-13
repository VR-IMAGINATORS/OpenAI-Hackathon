import { useEffect, useRef, useState } from 'react';
import type {
  HostedBootstrap,
  HostedSession,
  HostedPlayState,
  CreatedPlay,
  PlayControl,
} from '../../../packages/shared/api.js';
import { clientId, playRequest, PlayApiError, retryUncertain } from './play-api.js';
import { LiveConnection } from './live.js';
import PlayScreen from './PlayScreen.js';
export default function JoinScreen({ bootstrap }: { bootstrap: HostedBootstrap }) {
  const [authenticated, setAuthenticated] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [play, setPlay] = useState<{
    id: string;
    envelope: HostedPlayState;
    control?: PlayControl;
    connection?: LiveConnection;
  } | null>(null);
  const locked = useRef(false);
  const createId = useRef<string | null>(null);
  async function restore() {
    const session = await playRequest<HostedSession>('/api/session');
    setAuthenticated(true);
    if (session.playId) {
      const envelope = await playRequest<HostedPlayState>('/api/play/state', undefined, 'GET', {
        playId: session.playId,
      });
      setPlay({ id: session.playId, envelope });
    }
  }
  useEffect(() => {
    void restore()
      .catch((e) => {
        if (!(e instanceof PlayApiError && e.status === 401 && e.code !== 'SESSION_EXPIRED'))
          setError(e.message);
      })
      .finally(() => setLoading(false));
  }, []);
  async function authenticate() {
    if (locked.current) return;
    locked.current = true;
    setLoading(true);
    setError('');
    try {
      await playRequest('/api/auth', { passphrase });
      setPassphrase('');
      await restore();
    } catch (e) {
      setError(e instanceof Error ? e.message : '参加できませんでした。');
    } finally {
      locked.current = false;
      setLoading(false);
    }
  }
  async function start() {
    if (locked.current) return;
    locked.current = true;
    setLoading(true);
    setError('');
    const connection = new LiveConnection({
      onState: () => {},
      onEvent: () => {},
      onPlaybackBlocked: () => {},
    });
    try {
      await connection.prepare();
      createId.current ??= crypto.randomUUID();
      const body = { requestId: createId.current, clientId };
      const created = await retryUncertain(() => playRequest<CreatedPlay>('/api/plays', body));
      setPlay({
        id: created.playId,
        envelope: {
          ...created,
          lifecycle: created.lifecycle ?? 'connecting',
          recoveryExpiresAt: created.recoveryExpiresAt ?? null,
        },
        control: { playId: created.playId, clientId, controlEpoch: created.controlEpoch },
        connection,
      });
      createId.current = null;
    } catch (e) {
      connection.close();
      if (e instanceof PlayApiError && e.status !== 0) createId.current = null;
      setError(e instanceof Error ? e.message : '開始できませんでした。');
      if (e instanceof PlayApiError && e.code === 'PLAY_ALREADY_ACTIVE') await restore();
    } finally {
      locked.current = false;
      setLoading(false);
    }
  }
  if (play)
    return (
      <PlayScreen
        key={play.id}
        playId={play.id}
        initialEnvelope={play.envelope}
        initialControl={play.control}
        preparedConnection={play.connection}
        onExit={() => {
          setPlay(null);
          setError('');
          void restore().catch(() => setAuthenticated(false));
        }}
        onReplay={() => {
          setPlay(null);
          setError('');
        }}
      />
    );
  return (
    <main className="play-shell join-shell">
      <p className="play-brand">
        CALL <span>TO</span> PAST
      </p>
      <div className="join-orbit" aria-hidden="true">
        ↗
      </div>
      <p className="play-eyebrow">A CALL FROM THE FUTURE</p>
      <h1>
        未来からの着信。
        <br />
        <span>応答しますか？</span>
      </h1>
      <p className="join-copy">
        あなたの声と、身近なものの写真が
        <br />
        脱出への手がかりになる。
      </p>
      {error && (
        <p className="play-error" role="alert">
          {error}
        </p>
      )}
      {!authenticated ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void authenticate();
          }}
        >
          <label className="play-field">
            参加の合言葉
            <input
              type="password"
              autoComplete="off"
              value={passphrase}
              maxLength={256}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </label>
          <button className="primary-button" disabled={loading || !passphrase}>
            合言葉で参加
          </button>
        </form>
      ) : (
        <button className="primary-button" disabled={loading} onClick={() => void start()}>
          {loading ? '接続準備中…' : '音声接続・体験開始'}
          <span>↗</span>
        </button>
      )}
      <p className="play-footnote">
        カメラとマイクを使用します。
        <br />
        体験は説明を含めて最大10分です。
        {bootstrap.ai.mode === 'mock' ? '（現在はモックモードです）' : ''}
      </p>
    </main>
  );
}
