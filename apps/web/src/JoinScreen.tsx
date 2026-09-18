import OpeningSequence from './OpeningSequence.js';
import CodexLogin from './CodexLogin.js';
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
import {
  difficultySchema,
  difficultyPresets,
  type Difficulty,
} from '../../../packages/shared/difficulty.js';
export default function JoinScreen({ bootstrap }: { bootstrap: HostedBootstrap }) {
  const [locale, setLocale] = useState<'ja' | 'en'>('en');
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [codexReady, setCodexReady] = useState(false);
  const needsCodex = bootstrap.ai.playerLogin === 'codex';
  useEffect(() => {
    setApiLocale(locale);
    document.documentElement.lang = locale;
    document.title =
      locale === 'ja' ? 'Call to Past — 接続準備' : 'Call to Past — Ready to connect';
  }, [locale]);
  const t = (ja: string, en: string) => (locale === 'ja' ? ja : en);
  const [showOpening, setShowOpening] = useState(false);
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
  async function restore(includeResult = true) {
    const session = await playRequest<HostedSession>('/api/session');
    if (session.playId && (includeResult || session.lifecycle !== 'terminal')) {
      const envelope = await playRequest<HostedPlayState>('/api/play/state', undefined, 'GET', {
        playId: session.playId,
      });
      if (envelope.state.locale) setLocale(envelope.state.locale);
      if (envelope.state.difficulty) setDifficulty(envelope.state.difficulty);
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
  async function begin(selectedDifficulty: Difficulty) {
    if (needsCodex && !codexReady) return;
    if (locked.current) return;
    locked.current = true;
    setDifficulty(selectedDifficulty);
    createId.current = null;
    setLoading(true);
    setError('');
    try {
      await playRequest('/api/auth', {});
      await restore(false);
      setShowOpening(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('参加できませんでした。', 'Unable to join.'));
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
      const body = { requestId: createId.current, clientId, locale, difficulty };
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
      setError(e instanceof Error ? e.message : t('開始できませんでした。', 'Unable to start.'));
      if (e instanceof PlayApiError && e.code === 'PLAY_ALREADY_ACTIVE') await restore();
      if (e instanceof PlayApiError && e.code === 'CODEX_LOGIN_REQUIRED') {
        setShowOpening(false);
        setCodexReady(false);
      }
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
          setCodexReady(false);
          setShowOpening(false);
          setPlay(null);
          setError('');
        }}
        onReplay={() => {
          setCodexReady(false);
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
          <option value="en">English</option>
          <option value="ja">日本語</option>
        </select>
      </label>
      {needsCodex && <CodexLogin locale={locale} onReady={setCodexReady} />}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const submitter = (e.nativeEvent as SubmitEvent).submitter;
          if (!(submitter instanceof HTMLButtonElement)) return;
          const selected = difficultySchema.safeParse(submitter.value);
          if (selected.success) void begin(selected.data);
        }}
      >
        <fieldset className="difficulty-choice" disabled={loading || (needsCodex && !codexReady)}>
          <legend>{t('難易度を選んで開始', 'Choose a difficulty to start')}</legend>
          <div className="difficulty-options">
            {difficultySchema.options.map((value) => {
              const preset = difficultyPresets[value];
              const name = [preset.label[locale], preset.planLabel[locale]].join(
                locale === 'ja' ? '' : ' ',
              );
              const limits = `${preset.totalTimeSeconds / 60}${t('分', ' min')} · ${preset.initialCredits.toLocaleString(locale)}${t('クレジット', ' credits')}`;
              return (
                <button
                  className="difficulty-card"
                  key={value}
                  type="submit"
                  name="difficulty"
                  value={value}
                  aria-label={`${name} ${limits}`}
                >
                  <strong>{preset.label[locale]}</strong>
                  <span className="difficulty-card-plan">{preset.planLabel[locale]}</span>
                  <small>{limits}</small>
                </button>
              );
            })}
          </div>
        </fieldset>
      </form>
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
