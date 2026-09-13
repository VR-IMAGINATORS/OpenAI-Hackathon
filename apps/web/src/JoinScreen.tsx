import OpeningSequence from './OpeningSequence.js';
import { useEffect, useRef, useState } from 'react';
import type {
  HostedBootstrap,
  HostedSession,
  HostedPlayState,
  CreatedPlay,
  PlayControl,
} from '../../../packages/shared/api.js';
import { clientId, playRequest, PlayApiError, retryUncertain, setApiLocale } from './play-api.js';
import { LiveConnection } from './live.js';
import PlayScreen from './PlayScreen.js';
export default function JoinScreen({ bootstrap }: { bootstrap: HostedBootstrap }) {
  const [locale, setLocale] = useState<'ja' | 'en'>('ja');
  useEffect(() => {
    setApiLocale(locale);
    document.documentElement.lang = locale;
  }, [locale]);
  const t = (ja: string, en: string) => (locale === 'ja' ? ja : en);
  const [showOpening, setShowOpening] = useState(false);
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
      const body = { requestId: createId.current, clientId, locale };
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
        locale={locale}
        initialEnvelope={play.envelope}
        initialControl={play.control}
        preparedConnection={play.connection}
        onExit={() => {
          setShowOpening(false);
          setPlay(null);
          setError('');
          void restore().catch(() => setAuthenticated(false));
        }}
        onReplay={() => {
          setShowOpening(false);
          setPlay(null);
          setError('');
        }}
      />
    );
  if (showOpening)
    return (
      <OpeningSequence locale={locale} busy={loading} error={error} onAnswer={() => void start()} />
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
        {t('未来からの着信。', 'A call from the future.')}
        <br />
        <span>{t('応答しますか？', 'Will you answer?')}</span>
      </h1>
      <p className="join-copy">
        {t('あなたの声と、身近なものの写真が', 'Your voice and photos of everyday objects')}
        <br />
        {t('脱出への手がかりになる。', 'could be the key to escape.')}
      </p>
      {error && (
        <p className="play-error" role="alert">
          {error}
        </p>
      )}
      <label className="language-choice">
        Language / 言語
        <select
          value={locale}
          disabled={loading}
          onChange={(e) => {
            setLocale(e.target.value as 'ja' | 'en');
            createId.current = null;
          }}
        >
          <option value="ja">日本語</option>
          <option value="en">English</option>
        </select>
      </label>
      {!authenticated ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void authenticate();
          }}
        >
          <label className="play-field">
            {t('参加の合言葉', 'Passphrase')}
            <input
              type="password"
              autoComplete="off"
              value={passphrase}
              maxLength={256}
              onChange={(e) => setPassphrase(e.target.value)}
            />
          </label>
          <button className="primary-button" disabled={loading || !passphrase}>
            {t('合言葉で参加', 'Join')}
          </button>
        </form>
      ) : (
        <button className="primary-button" disabled={loading} onClick={() => setShowOpening(true)}>
          {loading ? t('接続準備中…', 'Connecting…') : t('体験を始める', 'Begin experience')}
          <span aria-hidden="true">↗</span>
        </button>
      )}
      <p className="play-footnote">
        {t('カメラとマイクを使用します。', 'Camera and microphone access is required.')}
        <br />
        {t(
          '応答後の体験は最大10分です。',
          'The experience lasts up to 10 minutes after answering.',
        )}
        {bootstrap.ai.mode === 'mock' ? t('（現在はモックモードです）', ' (Mock mode)') : ''}
      </p>
    </main>
  );
}
