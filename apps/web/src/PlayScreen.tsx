import ChatFeed, { type Locale } from './ChatFeed.js';
import EndingVideo from './EndingVideo.js';
import type { CoreLiveCommand } from '../../../packages/shared/conversation.js';
import type { HostedPlayState, ControlledPlay, PlayControl } from '../../../packages/shared/api.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicGameState, PlayUpdate } from '../../../packages/shared/game.js';
import { LiveConnection, type VoiceState } from './live.js';
import { preparePhoto, type PreparedPhoto } from './photo.js';
import { PlayApiError, playRequest, clientId, controlHeaders, setApiLocale } from './play-api.js';
import GameStatusSummary, { GameResourceCounters, GameCreditNotice } from './GameStatusSummary.js';
import { creditCosts } from '../../../packages/shared/credits.js';
import { discardWarning } from './live-command-delivery.js';

const voiceLabels: Record<VoiceState, string> = {
  connecting: '回線を接続中',
  connected: '音声で会話できます',
  disconnected: '音声が切断されました',
  failed: '音声を接続できません',
  closed: '音声未接続',
};
const terminal = (state: PublicGameState) => ['won', 'lost', 'expired'].includes(state.status);
const message = (error: unknown) =>
  error instanceof Error ? error.message : '処理を完了できませんでした。';
function time(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}

export default function PlayScreen({
  playId,
  initialEnvelope,
  initialControl,
  preparedConnection,
  locale: selectedLocale = 'en',
  onExit,
  onReplay,
}: {
  playId: string;
  initialEnvelope: HostedPlayState;
  initialControl?: PlayControl;
  preparedConnection?: LiveConnection;
  locale?: Locale;
  onExit: () => void;
  onReplay: () => void;
}) {
  const initialState = initialEnvelope.state;
  const locale: Locale =
    (initialState as PublicGameState & { locale?: Locale }).locale ?? selectedLocale;
  useEffect(() => {
    setApiLocale(locale);
    document.documentElement.lang = locale;
  }, [locale]);
  const t = (ja: string, en: string) => (locale === 'ja' ? ja : en);
  const [sentMessageIds, setSentMessageIds] = useState<ReadonlySet<string>>(new Set());
  const [draftPhoto, setDraftPhoto] = useState<PreparedPhoto | null>(null);
  const control = useRef<PlayControl | null>(initialControl ?? null);
  const [lifecycle, setLifecycle] = useState(initialEnvelope.lifecycle);
  const [invalid, setInvalid] = useState(false);
  const [hasControl, setHasControl] = useState(!!initialControl);
  function fail(error: unknown) {
    setError(message(error));
    if (
      error instanceof PlayApiError &&
      (error.status === 401 ||
        error.status === 403 ||
        error.status === 410 ||
        ['CONTROL_BUSY', 'CONTROL_STALE', 'CONTROL_LOST', 'STALE_CONTROL'].includes(error.code))
    ) {
      const previous = live.current;
      live.current = null;
      previous?.close();
      control.current = null;
      setHasControl(false);
      setVoice('disconnected');
      if (error.status === 401 || error.status === 410) setInvalid(true);
    }
  }
  async function request<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
    if (body !== undefined && !control.current)
      throw new PlayApiError(
        t(
          'この画面で再接続して操作権を引き継いでください。',
          'Reconnect on this screen to take control.',
        ),
        409,
        'CONTROL_BUSY',
      );
    const snapshot = control.current;
    try {
      const result = await playRequest<T>(path, body, method, snapshot ?? { playId });
      if (body !== undefined && snapshot !== control.current)
        throw new PlayApiError(
          t('別の画面に操作が移りました。', 'Control moved to another screen.'),
          409,
          'CONTROL_STALE',
        );
      if (result && typeof result === 'object' && 'lifecycle' in result)
        setLifecycle((result as unknown as HostedPlayState).lifecycle);
      return result;
    } catch (error) {
      // An old request must not revoke a newly acquired controller.
      if (snapshot === control.current) fail(error);
      throw error;
    }
  }
  const [state, setState] = useState(initialState);
  const current = useRef(state);
  current.current = state;
  const [voice, setVoice] = useState<VoiceState>('closed');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [voiceDiagnostic, setVoiceDiagnostic] = useState('');
  const [photos, setPhotos] = useState<PreparedPhoto[]>([]);
  const [retryPhotos, setRetryPhotos] = useState<{
    photos: PreparedPhoto[];
    requestId: string;
  } | null>(null);
  const [blockedAudio, setBlockedAudio] = useState(false);
  const live = useRef<LiveConnection | null>(null);
  const locked = useRef(false);
  const mounted = useRef(true);
  const camera = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const eventQueue = useRef<Promise<unknown>>(Promise.resolve());
  const commandAck = useRef({ key: '', seq: 0 });
  const activityRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!state.automaticActions || voice !== 'connected') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const connection = live.current,
        owner = control.current;
      if (cancelled || !connection || !owner || connection.state !== 'connected') return;
      const key =
        'callpast-commands:' + playId + ':' + connection.generation + ':' + owner.controlEpoch;
      if (commandAck.current.key !== key) {
        let seq = 0;
        try {
          const saved = Number(sessionStorage.getItem(key));
          if (Number.isSafeInteger(saved) && saved >= 0) seq = saved;
        } catch {}
        commandAck.current = { key, seq };
      }
      try {
        const batch = await playRequest<{
          generation: number;
          controlEpoch: number;
          acknowledgedThrough: number;
          serverNow: number;
          commands: CoreLiveCommand[];
          state: PublicGameState;
        }>(
          '/api/play/commands/poll',
          { generation: connection.generation, ackThrough: commandAck.current.seq },
          'POST',
          owner,
        );
        if (
          cancelled ||
          live.current !== connection ||
          control.current !== owner ||
          batch.generation !== connection.generation ||
          batch.controlEpoch !== owner.controlEpoch
        )
          return;
        if (cancelled || live.current !== connection || control.current !== owner) return;
        // Polling final commands also delivers the terminal state, so the mic
        // stops before the final commentary is sent to Live.
        if (batch.state) apply(batch.state);
        const receivedAt = performance.now();
        for (const command of batch.commands) {
          if (command.seq <= commandAck.current.seq) continue;
          if (command.seq !== commandAck.current.seq + 1)
            throw new Error(
              t(
                '音声通知の順序を確認できません。再接続してください。',
                'Unable to verify voice notification order. Please reconnect.',
              ),
            );
          const { type, event_id, delegation_id, content } = command;
          const discard = discardWarning(
            command,
            terminal(current.current),
            batch.serverNow,
            receivedAt,
            performance.now(),
          );
          if (!discard && !connection.send([{ type, event_id, delegation_id, content }])) break;
          commandAck.current.seq = command.seq;
          if (!discard && command.messageId && command.type === 'session.commentary.append')
            setSentMessageIds((ids) => new Set([...ids, command.messageId!]));
          try {
            sessionStorage.setItem(key, String(command.seq));
          } catch {}
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof PlayApiError && error.status === 410 && terminal(current.current)) {
          connection.close();
          return;
        }
        if (mounted.current) setError(message(error));
      } finally {
        if (!cancelled) timer = setTimeout(poll, 500);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [state.automaticActions, voice, playId]);
  const openingDelivered = useRef(false);
  const openingKey = 'callpast-opening:' + initialState.id;
  function markOpeningDelivered() {
    openingDelivered.current = true;
    try {
      sessionStorage.setItem(openingKey, '1');
    } catch {
      /* Memory fallback. */
    }
  }
  useEffect(() => {
    const connection = live.current;
    if (
      voice !== 'connected' ||
      (state.status !== 'briefing' && !(state.automaticActions && state.status === 'playing')) ||
      blockedAudio ||
      !connection?.opening
    )
      return;
    try {
      if (sessionStorage.getItem(openingKey)) openingDelivered.current = true;
    } catch {
      /* Memory fallback. */
    }
    if (openingDelivered.current) return;
    const timer = window.setTimeout(() => {
      if (
        openingDelivered.current ||
        live.current !== connection ||
        connection.state !== 'connected' ||
        (current.current.status !== 'briefing' &&
          !(current.current.automaticActions && current.current.status === 'playing'))
      )
        return;
      if (connection.send([connection.opening!])) markOpeningDelivered();
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [voice, state.status, blockedAudio, openingKey]);
  const apply = useCallback((next: PublicGameState) => {
    if (!mounted.current || next.generation < current.current.generation) return;
    const previous = current.current;
    if (
      next.stateVersion !== undefined &&
      previous.stateVersion !== undefined &&
      next.stateVersion < previous.stateVersion
    )
      return;
    if (next.automaticActions && next.actionsUsed > previous.actionsUsed) setPhotos([]);
    if (next.id === previous.id && next.inputRevision < previous.inputRevision) return;
    if (next.id === previous.id)
      next = {
        ...next,
        remainingMs: Math.min(previous.remainingMs, next.remainingMs),
        waitingRemainingMs: Math.min(previous.waitingRemainingMs, next.waitingRemainingMs),
      };
    current.current = next;
    if (terminal(next)) live.current?.stopInput();
    setState(next);
  }, []);
  async function heartbeat(connection = live.current) {
    if (
      !connection ||
      !control.current ||
      (connection.state !== 'connected' && terminal(current.current))
    )
      return;
    try {
      apply(
        (
          await request<HostedPlayState>('/api/play/heartbeat', {
            generation: connection.generation,
            voiceState: connection.state,
          })
        ).state,
      );
    } catch (error) {
      if (mounted.current) setError(message(error));
    }
  }
  useEffect(() => {
    mounted.current = true;
    let polling = false;
    const refresh = async () => {
      if (polling || invalid) return;
      polling = true;
      try {
        apply((await request<HostedPlayState>('/api/play/state')).state);
      } catch (error) {
        if (mounted.current) setError(message(error));
      } finally {
        polling = false;
      }
    };
    const poll = window.setInterval(() => void refresh(), 1500);
    const beat = window.setInterval(() => void heartbeat(), 10_000);
    const visibility = () => {
      if (!document.hidden) {
        void refresh();
        void heartbeat();
      }
    };
    const pagehide = () => {
      const previous = live.current;
      live.current = null;
      previous?.close();
      setVoice('disconnected');
      if (!control.current) return;
      void fetch('/api/play/heartbeat', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', ...controlHeaders(control.current) },
        body: JSON.stringify({
          generation: current.current.generation,
          voiceState: 'disconnected',
        }),
      }).catch(() => {});
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', pagehide);
    return () => {
      mounted.current = false;
      window.clearInterval(poll);
      window.clearInterval(beat);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', pagehide);
      live.current?.close();
      activityRequest.current?.abort();
    };
  }, [apply]);
  useEffect(() => {
    if (!terminal(state)) return;
    live.current?.stopInput();
    setPhotos([]);
    setRetryPhotos(null);
  }, [state.status]);
  useEffect(() => {
    if (!['closing', 'terminal', 'quarantined'].includes(lifecycle)) return;
    live.current?.close();
    live.current = null;
  }, [lifecycle]);
  async function connect(prepared?: LiveConnection) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    setVoiceDiagnostic('');
    const previous = live.current;
    prepared ??= previous?.pendingRequest ? previous : undefined;
    live.current = null;
    if (previous !== prepared) previous?.close();
    const options: ConstructorParameters<typeof LiveConnection>[0] = {
      onState: (value) => {
        if (!mounted.current || live.current !== connection) return;
        setVoice(value);
        if (connection.generation > 0) void heartbeat(connection);
      },
      onPlaybackBlocked: () => setBlockedAudio(true),
      onError: (detail) => {
        if (mounted.current && live.current === connection) setVoiceDiagnostic(detail);
      },
      onVoiceActivity: (snapshot) => {
        const owner = control.current;
        if (
          !mounted.current ||
          live.current !== connection ||
          !owner ||
          connection.generation !== snapshot.generation ||
          activityRequest.current
        )
          return;
        // Lossy advisory channel: never queue/retry telemetry behind game input.
        const abort = new AbortController();
        activityRequest.current = abort;
        const timeout = window.setTimeout(() => abort.abort(), 2000);
        void playRequest('/api/play/voice-activity', snapshot, 'POST', owner, abort.signal)
          .catch(() => {
            /* The server treats missing telemetry as unknown. */
          })
          .finally(() => {
            window.clearTimeout(timeout);
            if (activityRequest.current === abort) activityRequest.current = null;
          });
      },
      onEvent: (event, generation) => {
        if (terminal(current.current) && event.type !== 'session.output_transcript.delta') return;
        if (
          event.type === 'session.input_transcript.delta' ||
          event.type === 'session.output_transcript.delta'
        )
          markOpeningDelivered();
        const changesInput = event.type !== 'session.output_transcript.delta';
        eventQueue.current = eventQueue.current
          .catch(() => {})
          .then(async () => {
            if (live.current !== connection || (terminal(current.current) && changesInput)) return;
            try {
              const update = await request<PlayUpdate | { accepted: true }>('/api/play/events', {
                generation,
                event,
              });
              if ('state' in update) {
                apply(update.state);
                connection.send(update.commands);
              }
            } catch (error) {
              if (mounted.current) {
                setError(
                  changesInput
                    ? t(
                        '声の内容を送信できませんでした。使い方をもう一度話してください。',
                        'Your speech could not be sent. Please repeat your instruction.',
                      )
                    : message(error),
                );
                if (changesInput && !terminal(current.current)) {
                  if (current.current.automaticActions) {
                    connection.close();
                    void heartbeat(connection);
                  }
                }
              }
            }
          });
      },
    };
    const connection = prepared ?? new LiveConnection(options);
    connection.setOptions(options);
    live.current = connection;
    try {
      if (!prepared) await connection.prepare();
      if (!control.current) {
        const acquired = await playRequest<ControlledPlay>(
          '/api/play/control',
          { clientId, takeover: true },
          'POST',
          { playId },
        );
        control.current = { playId, clientId, controlEpoch: acquired.controlEpoch };
        setHasControl(true);
        apply(acquired.state);
      }
      await connection.connect(control.current);
      await heartbeat(connection);
    } catch (error) {
      setVoiceDiagnostic((previous) => previous || message(error));
      if (!connection.pendingRequest) connection.close();
      fail(error);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  const autoConnected = useRef(false);
  useEffect(() => {
    if (preparedConnection && !autoConnected.current) {
      autoConnected.current = true;
      void connect(preparedConnection);
    }
  }, []);

  async function sendPhotos(next: PreparedPhoto[], retryRequestId?: string) {
    if (locked.current) return;
    // A same-ID retry may already have reserved its credits on the server.
    if (!retryRequestId && current.current.creditsRemaining < next.length * creditCosts.photo) {
      setError(t('写真を送るクレジットが足りません。', 'Not enough credits to send these photos.'));
      return;
    }
    const requestId = retryRequestId ?? crypto.randomUUID();
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      apply(
        (
          await request<HostedPlayState>(
            '/api/play/photos',
            { requestId, images: next.map((photo) => photo.base64) },
            'PUT',
          )
        ).state,
      );
      setPhotos(current.current.photoCount > 0 ? next : []);
      setRetryPhotos(null);
    } catch (error) {
      setRetryPhotos(
        error instanceof PlayApiError && error.code === 'INSUFFICIENT_CREDITS'
          ? null
          : {
              photos: next,
              requestId:
                error instanceof PlayApiError && error.status === 0
                  ? requestId
                  : crypto.randomUUID(),
            },
      );
      setError(message(error));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function choosePhoto(file?: File) {
    if (
      !file ||
      locked.current ||
      photos.length >= current.current.maxPhotos ||
      current.current.creditsRemaining < (photos.length + 1) * creditCosts.photo
    )
      return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      const photo = await preparePhoto(file);
      setDraftPhoto(photo);
    } catch (error) {
      setError(message(error));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  async function end() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      apply((await request<HostedPlayState>('/api/play/end', {})).state);
      live.current?.close();
    } catch (error) {
      setError(message(error));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  const ended = terminal(state) || invalid;
  const finishingVoice = ended && voice === 'connected' && !invalid;
  const nextPhotoCost = (photos.length + 1) * creditCosts.photo;
  const canAffordNextPhoto = state.creditsRemaining >= nextPhotoCost;

  const cameraDisabled =
    !canAffordNextPhoto ||
    voice !== 'connected' ||
    busy ||
    state.busy ||
    photos.length >= state.maxPhotos ||
    !!draftPhoto ||
    !!retryPhotos;
  return (
    <main
      className={'messenger-app' + (ended ? ' messenger-complete' : '')}
      aria-label={t('未来とのメッセンジャー', 'Future messenger')}
    >
      <header className="messenger-header">
        <div className="messenger-avatar" aria-hidden="true">
          AI
        </div>
        <div className="messenger-contact">
          <h1>{t('未来のあなたのAI', 'Your future AI')}</h1>
          <span>CALL TO THE PAST</span>
        </div>
        {!ended && (
          <button
            className="messenger-hangup"
            aria-label={t('プレイを終了', 'End game')}
            onClick={() => void end()}
            disabled={busy}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 15v-4c5-5 13-5 18 0v4h-5v-4M8 11v4H3" />
            </svg>
          </button>
        )}
      </header>
      <section
        className={'messenger-call voice-' + voice}
        aria-label={t('音声接続', 'Voice connection')}
      >
        <span className="messenger-dot" aria-hidden="true" />
        <strong>
          {ended
            ? finishingVoice
              ? t('最後の音声を再生中（マイク停止）', 'Playing the final message (mic off)')
              : t('通話終了', 'Call ended')
            : locale === 'ja'
              ? voiceLabels[voice]
              : {
                  connecting: 'Connecting',
                  connected: 'Voice connected',
                  disconnected: 'Voice disconnected',
                  failed: 'Unable to connect voice',
                  closed: 'Voice not connected',
                }[voice]}
        </strong>
        {!ended && voice !== 'connected' && (
          <button
            disabled={busy}
            onClick={() => void connect()}
            aria-label={
              busy
                ? t('接続準備中…', 'Connecting…')
                : hasControl
                  ? t('音声を接続 / 再開する', 'Connect / resume voice')
                  : t('この画面で再接続', 'Reconnect here')
            }
          >
            {busy ? t('接続準備中…', 'Connecting…') : t('再接続', 'Reconnect')}
          </button>
        )}
        {blockedAudio && (!ended || finishingVoice) && (
          <button
            aria-label={t('タップして相手の音声を再生', 'Tap to play incoming audio')}
            onClick={() =>
              void live.current
                ?.resumeAudio()
                .then(() => setBlockedAudio(false))
                .catch(() => setError(t('音声を再生できません。', 'Unable to play audio.')))
            }
          >
            {t('音声を再生', 'Play audio')}
          </button>
        )}
      </section>
      {voiceDiagnostic && (
        <p className="play-error" role="alert">
          {t('音声診断: ', 'Voice diagnostic: ')}{voiceDiagnostic}
        </p>
      )}
      <details className="messenger-info">
        <GameStatusSummary
          key={playId}
          title={
            ended
              ? state.status === 'won'
                ? t('脱出できた！', 'You escaped!')
                : t('接続を終了しました', 'Call ended')
              : state.obstacle.title
          }
          ended={ended}
          locale={locale}
        />
        <div className="messenger-info-body">
          <p>{ended ? state.lastResult?.narrative : state.situation}</p>
          <p>
            {t('障害', 'Obstacle')} {state.obstacle.index + 1} / {state.obstacle.count}
          </p>
          {state.inventory.length > 0 && (
            <>
              <h2>{t('未来へ送ったもの', 'Sent to the future')}</h2>
              <ul>
                {state.inventory.map((item) => (
                  <li key={item.id}>
                    {item.name} ·{' '}
                    {item.status === 'available'
                      ? t('使用できる', 'Available')
                      : item.status === 'damaged'
                        ? t('破損あり', 'Damaged')
                        : t('使用済み', 'Used')}
                    <p>{item.description}</p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </details>
      {ended && (
        <EndingVideo
          key={playId}
          playId={playId}
          locale={locale}
          outcome={state.endingOutcome}
          clearedCount={state.clearedCount}
          summary={state.lastResult?.narrative}
        />
      )}
      <ChatFeed
        embedded
        playId={playId}
        locale={locale}
        sentMessageIds={sentMessageIds}
        connected={voice === 'connected'}
        generation={state.generation}
      />
      <footer className="messenger-composer">
        {!ended && (
          <GameResourceCounters
            key={playId}
            remainingMs={state.remainingMs}
            creditsRemaining={state.creditsRemaining}
            initialCredits={state.initialCredits}
            locale={locale}
          />
        )}
        {!ended && (
          <GameCreditNotice
            creditsRemaining={state.creditsRemaining}
            initialCredits={state.initialCredits}
            locale={locale}
          />
        )}
        {state.paused && !ended && (
          <p className="messenger-notice" role="status">
            {t('接続・処理待ち：時計は停止中', 'Waiting: timer paused')} (
            {time(state.waitingRemainingMs)})
          </p>
        )}
        {(error || state.error) && (
          <p className="messenger-notice messenger-error" role="alert">
            {error || state.error}
          </p>
        )}
        {retryPhotos && !ended && (
          <div className="messenger-retry">
            <p>{t('写真の送信を完了できませんでした。', 'Photo upload did not complete.')}</p>
            <button
              disabled={busy}
              onClick={() => void sendPhotos(retryPhotos.photos, retryPhotos.requestId)}
            >
              {t('写真の送信を再試行', 'Retry photo upload')}
            </button>
            <button
              disabled={busy}
              onClick={() => {
                setRetryPhotos(null);
                setError('');
              }}
            >
              {t('この写真の送信を取り消す', 'Cancel this upload')}
            </button>
          </div>
        )}
        {!ended && draftPhoto && (
          <div className="messenger-attachments">
            {draftPhoto && (
              <section
                className="messenger-draft"
                aria-label={t('送信前の写真確認', 'Photo preview')}
              >
                <img src={draftPhoto.preview} alt={t('送信前の写真', 'Photo to send')} />
                <div>
                  <h2>{t('この写真を送りますか？', 'Send this photo?')}</h2>
                  <p className="photo-credit-cost">
                    {t('消費クレジット', 'Credit cost')}: {nextPhotoCost}
                  </p>
                  <button onClick={() => setDraftPhoto(null)}>
                    {t('撮り直す・取り消す', 'Retake / cancel')}
                  </button>
                </div>
              </section>
            )}
          </div>
        )}
        {!ended ? (
          <>
            <input
              ref={camera}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={(event) => {
                void choosePhoto(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            <input
              ref={files}
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => {
                void choosePhoto(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            <div className="messenger-compose-row">
              <button
                className="messenger-icon"
                aria-label={t('撮影', 'Camera')}
                disabled={cameraDisabled}
                onClick={() => camera.current?.click()}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3 7h4l2-3h6l2 3h4v13H3z" />
                  <circle cx="12" cy="13" r="4" />
                </svg>
              </button>
              <button
                className="messenger-icon"
                aria-label={t(
                  '写真ライブラリ / PCのファイルから選ぶ',
                  'Choose from photo library / files',
                )}
                disabled={cameraDisabled}
                onClick={() => files.current?.click()}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="3" y="3" width="18" height="18" rx="3" />
                  <circle cx="8" cy="8" r="1" />
                  <path d="m3 17 5-5 4 4 4-6 5 7" />
                </svg>
              </button>
              <div className="messenger-voice-placeholder">
                {draftPhoto
                  ? t('写真を送信 →', 'Send photo →')
                  : t('使い方は声で伝えてね', 'Tell me how to use it')}
                <small>
                  {state.photoCount} / {state.maxPhotos}
                </small>
              </div>
              <button
                className="messenger-icon messenger-send"
                aria-label={t('この写真を送信', 'Send photo')}
                disabled={
                  !canAffordNextPhoto ||
                  !draftPhoto ||
                  busy ||
                  state.busy ||
                  !!retryPhotos ||
                  voice !== 'connected'
                }
                onClick={() => {
                  if (!draftPhoto) return;
                  const next = [...photos, draftPhoto].slice(0, state.maxPhotos);
                  setDraftPhoto(null);
                  void sendPhotos(next);
                }}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m5 12 7-7 7 7M12 5v15" />
                </svg>
              </button>
            </div>
          </>
        ) : (
          <div className="messenger-ended">
            <button
              onClick={invalid ? onExit : onReplay}
              disabled={!invalid && lifecycle !== 'terminal'}
            >
              {invalid ? t('開始画面に戻る', 'Return to start') : t('もう一度プレイ', 'Play again')}
            </button>
          </div>
        )}
        {['closing', 'quarantined'].includes(lifecycle) && (
          <p className="messenger-notice" role="status">
            {lifecycle === 'closing'
              ? t('音声の終了を確認しています。', 'Waiting for the call to end.')
              : t(
                  '音声の終了を確認できません。運営による確認が必要です。',
                  'Unable to confirm the call ended. Please contact the host.',
                )}
          </p>
        )}
        {state.scenarioId && (
          <p className="scenario-id">
            {t('シナリオID', 'Scenario ID')}: {state.scenarioId}
          </p>
        )}
      </footer>
    </main>
  );
}
