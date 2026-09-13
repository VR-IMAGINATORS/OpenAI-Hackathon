import type { CoreLiveCommand } from '../../../packages/shared/conversation.js';
import type { HostedPlayState, ControlledPlay, PlayControl } from '../../../packages/shared/api.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicGameState, PlayUpdate } from '../../../packages/shared/game.js';
import { LiveConnection, type VoiceState } from './live.js';
import { preparePhoto, type PreparedPhoto } from './photo.js';
import { PlayApiError, playRequest, clientId, controlHeaders } from './play-api.js';

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
  onExit,
  onReplay,
}: {
  playId: string;
  initialEnvelope: HostedPlayState;
  initialControl?: PlayControl;
  preparedConnection?: LiveConnection;
  onExit: () => void;
  onReplay: () => void;
}) {
  const initialState = initialEnvelope.state;
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
        'この画面で再接続して操作権を引き継いでください。',
        409,
        'CONTROL_BUSY',
      );
    const snapshot = control.current;
    try {
      const result = await playRequest<T>(path, body, method, snapshot ?? { playId });
      if (body !== undefined && snapshot !== control.current)
        throw new PlayApiError('別の画面に操作が移りました。', 409, 'CONTROL_STALE');
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
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [photos, setPhotos] = useState<PreparedPhoto[]>([]);
  const [retryPhotos, setRetryPhotos] = useState<{
    photos: PreparedPhoto[];
    requestId: string;
  } | null>(null);
  const [blockedAudio, setBlockedAudio] = useState(false);
  const [pendingInput, setPendingInput] = useState(0);
  const [lostInput, setLostInput] = useState(false);
  const [uncertainAction, setUncertainAction] = useState<{
    actionId: string;
    proposalRevision: number;
  } | null>(null);
  const live = useRef<LiveConnection | null>(null);
  const locked = useRef(false);
  const mounted = useRef(true);
  const camera = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const eventQueue = useRef<Promise<unknown>>(Promise.resolve());
  const commandAck = useRef({ key: '', seq: 0 });
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
          commands: CoreLiveCommand[];
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
        if (batch.commands.some((c) => c.messageId && c.seq > commandAck.current.seq)) {
          try {
            apply(
              (await playRequest<HostedPlayState>('/api/play/state', undefined, 'GET', owner))
                .state,
            );
          } catch {
            /* Audio can still carry the confirmed result. */
          }
        }
        if (cancelled || live.current !== connection || control.current !== owner) return;
        for (const command of batch.commands) {
          if (command.seq <= commandAck.current.seq) continue;
          if (command.seq !== commandAck.current.seq + 1)
            throw new Error('音声通知の順序を確認できません。再接続してください。');
          const { type, event_id, delegation_id, content } = command;
          if (!connection.send([{ type, event_id, delegation_id, content }])) break;
          commandAck.current.seq = command.seq;
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
      state.status !== 'briefing' ||
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
        current.current.status !== 'briefing'
      )
        return;
      if (connection.send([connection.opening!])) markOpeningDelivered();
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [voice, state.status, blockedAudio, openingKey]);
  const apply = useCallback((next: PublicGameState) => {
    if (!mounted.current || next.generation < current.current.generation) return;
    const previous = current.current;
    if (next.automaticActions && next.actionsRemaining < previous.actionsRemaining) setPhotos([]);
    if (
      next.id === previous.id &&
      (next.inputRevision < previous.inputRevision ||
        next.actionsRemaining > previous.actionsRemaining)
    )
      return;
    if (next.id === previous.id)
      next = {
        ...next,
        remainingMs: Math.min(previous.remainingMs, next.remainingMs),
        waitingRemainingMs: Math.min(previous.waitingRemainingMs, next.waitingRemainingMs),
      };
    current.current = next;
    setState(next);
  }, []);
  async function heartbeat(connection = live.current) {
    if (!connection || !control.current || terminal(current.current)) return;
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
    };
  }, [apply]);
  useEffect(() => {
    if (!terminal(state)) return;
    setPhotos([]);
    setRetryPhotos(null);
    const timer = window.setTimeout(
      () => {
        live.current?.close();
        live.current = null;
      },
      state.status === 'expired' ? 0 : 12_000,
    );
    return () => window.clearTimeout(timer);
  }, [state.status]);
  async function connect(prepared?: LiveConnection) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
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
      onEvent: (event, generation) => {
        if (
          event.type === 'session.input_transcript.delta' ||
          event.type === 'session.output_transcript.delta'
        )
          markOpeningDelivered();
        const changesInput = event.type !== 'session.output_transcript.delta';
        if (changesInput) setPendingInput((count) => count + 1);
        eventQueue.current = eventQueue.current
          .catch(() => {})
          .then(async () => {
            if (
              live.current !== connection ||
              (terminal(current.current) && !current.current.automaticActions)
            )
              return;
            try {
              const update = await request<PlayUpdate | { accepted: true }>('/api/play/events', {
                generation,
                event,
              });
              if ('state' in update) {
                apply(update.state);
                connection.send(update.commands);
              }
              if (changesInput && mounted.current) setLostInput(false);
            } catch (error) {
              if (mounted.current) {
                setError(
                  changesInput
                    ? '声の内容を送信できませんでした。使い方をもう一度話してください。'
                    : message(error),
                );
                if (changesInput) {
                  setLostInput(true);
                  if (current.current.automaticActions) {
                    connection.close();
                    void heartbeat(connection);
                  }
                }
              }
            }
          })
          .finally(() => {
            if (changesInput && mounted.current) setPendingInput((count) => Math.max(0, count - 1));
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
  async function start() {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      const next = await request<PlayUpdate>('/api/play/start', {});
      apply(next.state);
      live.current?.send(next.commands);
    } catch (error) {
      setError(message(error));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function sendPhotos(next: PreparedPhoto[], requestId: string = crypto.randomUUID()) {
    if (locked.current) return;
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
      setPhotos(next);
      setRetryPhotos(null);
      setUncertainAction(null);
    } catch (error) {
      setRetryPhotos({
        photos: next,
        requestId:
          error instanceof PlayApiError && error.status === 0 ? requestId : crypto.randomUUID(),
      });
      setError(message(error));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function choosePhoto(file?: File) {
    if (!file || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      const photo = await preparePhoto(file);
      locked.current = false;
      await sendPhotos([...photos, photo].slice(0, current.current.maxPhotos));
    } catch (error) {
      setError(message(error));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function commit() {
    if (locked.current || (!state.proposal && !uncertainAction)) return;
    locked.current = true;
    setBusy(true);
    setError('');
    const action = uncertainAction ?? {
      actionId: crypto.randomUUID(),
      proposalRevision: state.proposal!.revision,
    };
    try {
      const update = await request<PlayUpdate>('/api/play/actions', action);
      setUncertainAction(null);
      apply(update.state);
      live.current?.send(update.commands);
      setPhotos([]);
    } catch (error) {
      setUncertainAction(
        error instanceof PlayApiError &&
          (error.status === 0 || (error.status === 409 && uncertainAction !== null))
          ? action
          : null,
      );
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
  const canExecute =
    pendingInput === 0 &&
    !lostInput &&
    !retryPhotos &&
    !busy &&
    !state.busy &&
    state.status === 'playing' &&
    voice === 'connected' &&
    !!state.proposal &&
    state.proposal.items.length > 0 &&
    !!state.proposal.usage.trim() &&
    state.proposal.inputRevision === state.inputRevision;
  return (
    <main className="play-shell">
      <header className="play-header">
        <span className="play-brand">
          CALL <span>TO</span> PAST
        </span>
        <span className="play-badge">PLAYTEST</span>
      </header>
      {!ended && (
        <div className="play-resources" aria-label="残り資源">
          <div>
            <span>残り時間</span>
            <strong>{time(state.remainingMs)}</strong>
          </div>
          <div>
            <span>残り行動</span>
            <strong>
              {state.actionsRemaining}
              <small> 回</small>
            </strong>
          </div>
          <div>
            <span>障害</span>
            <strong>
              {state.obstacle.index + 1}
              <small> / {state.obstacle.count}</small>
            </strong>
          </div>
        </div>
      )}
      {!ended && (
        <figure className="opening-scene">
          <img
            src="/images/trapped-silhouette.png"
            alt="薄暗い倉庫の閉じた扉の前で、電話を手に助けを求める人物のシルエット"
          />
          <figcaption>
            未来から届いた映像 <span>イメージ</span>
          </figcaption>
        </figure>
      )}
      <section className="play-story">
        <p className="play-eyebrow">{ended ? 'CALL ENDED' : 'CONNECTED TO THE FUTURE'}</p>
        <h1>
          {ended
            ? state.status === 'won'
              ? '脱出できた！'
              : state.status === 'lost'
                ? '通信の、その先へ。'
                : '接続を終了しました'
            : state.status === 'briefing'
              ? state.title
              : state.obstacle.title}
        </h1>
        <p>
          {ended
            ? (state.lastResult?.narrative ?? '終了確認後、もう一度プレイできます。')
            : state.status === 'briefing'
              ? state.briefing
              : state.situation}
        </p>
        {state.status === 'lost' && <p>今回は脱出できませんでした。別の使い方でもう一度。</p>}
      </section>
      {!ended && (
        <>
          <section className={'voice-panel voice-' + voice} aria-label="音声接続">
            <div className="voice-symbol" aria-hidden="true">
              ↗
            </div>
            <div>
              <strong>{voiceLabels[voice]}</strong>
              <p>
                {voice === 'connected'
                  ? state.status === 'briefing'
                    ? 'まもなく相手から声が届きます。聞こえたら返事を。'
                    : '質問も、使い方の相談も、声で。'
                  : 'マイクを許可して、未来へつなごう。'}
              </p>
            </div>
          </section>
          {voice !== 'connected' && (
            <section className="play-panel">
              <button className="primary-button" disabled={busy} onClick={() => void connect()}>
                {busy ? '接続準備中…' : hasControl ? '音声を接続 / 再開する' : 'この画面で再接続'}
                <span>↗</span>
              </button>
              <p className="play-footnote">
                {hasControl
                  ? '撮影後に音声が途切れたときも、ここから再開できます。'
                  : '別の画面で接続中の場合は、その接続を終了してこの画面へ引き継ぎます。復帰猶予は最大60秒です。'}
              </p>
            </section>
          )}
          {blockedAudio && (
            <button
              className="secondary-button"
              onClick={() =>
                void live.current
                  ?.resumeAudio()
                  .then(() => setBlockedAudio(false))
                  .catch(() =>
                    setError('音声を再生できません。端末の音量とブラウザ設定を確認してください。'),
                  )
              }
            >
              タップして相手の音声を再生
            </button>
          )}
          {state.paused && (
            <p className="play-wait" role="status">
              接続・処理を待っています。時計は停止中（待機枠 {time(state.waitingRemainingMs)}）
            </p>
          )}
          {state.status === 'briefing' && (
            <section className="tutorial-panel">
              <p className="play-eyebrow">はじめての通信</p>
              <h2>まずは「聞こえるよ」と話してみよう。</h2>
              <ol>
                <li>
                  <strong>声で返事をする</strong>
                  <span>相手の状況を聞こう。質問しても行動は減りません。</span>
                </li>
                <li>
                  <strong>身近なものを1枚撮影</strong>
                  <span>下の撮影ボタンから送って、使い方を相談しよう。</span>
                </li>
                <li>
                  <strong>準備できたら本編へ</strong>
                  <span>この説明中は制限時間が進みません。</span>
                </li>
              </ol>
            </section>
          )}
          {state.status === 'briefing' && (
            <button
              className="primary-button start-button"
              onClick={() => void start()}
              disabled={busy || voice !== 'connected'}
            >
              状況を聞いたら、プレイ開始<span>→</span>
            </button>
          )}
          <>
            {state.transcript && (
              <details className="transcript">
                <summary>あなたの声をこう聞き取りました</summary>
                <p>{state.transcript}</p>
              </details>
            )}
            <section className="play-panel proposal-panel" aria-live="polite">
              <div className="play-section-label">
                <span>いま伝わっているアイデア</span>
                <span>{state.proposal ? '確認' : '相談中'}</span>
              </div>
              {state.proposal ? (
                <>
                  <h2>
                    {state.proposal.items.map((item) => item.name).join(' ＋ ') ||
                      '持ち物を使う工夫'}
                  </h2>
                  <p>{state.proposal.summary}</p>
                  <p className="proposal-usage">{state.proposal.usage}</p>
                </>
              ) : (
                <p>身近なものを撮影して、どう使うか話してみよう。</p>
              )}
              <p className="play-footnote">
                {state.automaticActions
                  ? '相談では行動しません。使い方を指示すると、そのまま試します。'
                  : '違っていたら声で訂正。下のボタンを押すまで実行されません。'}
              </p>
            </section>
            <section className="photo-section">
              <div className="play-section-label">
                <span>今回送る写真</span>
                <span>
                  {state.photoCount} / {state.maxPhotos}
                </span>
              </div>
              <div className="photo-strip">
                {photos.map((photo, index) => (
                  <div className="photo-thumb" key={photo.preview}>
                    <img src={photo.preview} alt={'送信した道具の写真 ' + (index + 1)} />
                    <button
                      aria-label={'写真 ' + (index + 1) + ' を取り消す'}
                      disabled={busy || state.busy || !!uncertainAction}
                      onClick={() => void sendPhotos(photos.filter((_, i) => i !== index))}
                    >
                      ×
                    </button>
                  </div>
                ))}
                {!photos.length && (
                  <p className="photo-empty">
                    {state.photoCount
                      ? '送信した写真はサーバー側で保持しています。差し替える場合は新しく撮影してください。'
                      : '道具の形や素材がわかるように撮影しよう。'}
                  </p>
                )}
              </div>
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
              <button
                className="file-choice"
                disabled={
                  voice !== 'connected' ||
                  busy ||
                  state.busy ||
                  photos.length >= state.maxPhotos ||
                  !!uncertainAction
                }
                onClick={() => files.current?.click()}
              >
                写真ライブラリ / PCのファイルから選ぶ
              </button>
            </section>
            {state.inventory.length > 0 && (
              <section className="inventory-section">
                <h2>未来へ送ったもの</h2>
                <ul>
                  {state.inventory.map((item) => (
                    <li key={item.id}>
                      <span>{item.name}</span>
                      <small>
                        {item.status === 'available'
                          ? '使用できる'
                          : item.status === 'damaged'
                            ? '破損あり'
                            : '使用済み'}
                      </small>
                      <p>{item.description}</p>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {state.lastResult && (
              <section className="play-panel last-result">
                <h2>{state.lastResult.success ? '道がひらけた。' : '次の工夫を考えよう。'}</h2>
                <p>{state.lastResult.narrative}</p>
              </section>
            )}
          </>
        </>
      )}
      {retryPhotos && !ended && (
        <div className="play-panel">
          <p>写真の送信を完了できませんでした。</p>
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() => void sendPhotos(retryPhotos.photos, retryPhotos.requestId)}
          >
            写真の送信を再試行
          </button>
          <button
            className="file-choice"
            disabled={busy}
            onClick={() => {
              setRetryPhotos(null);
              setError('');
            }}
          >
            この写真の送信を取り消す
          </button>
        </div>
      )}
      {(error || state.error) && (
        <div className="play-error" role="alert">
          {error || state.error}
          {uncertainAction && (
            <p>結果が未確認です。「結果を再確認」で同じ行動の結果を取得できます。</p>
          )}
        </div>
      )}
      {!ended && (
        <div className="play-actions">
          <button
            className="photo-button"
            disabled={
              voice !== 'connected' ||
              busy ||
              state.busy ||
              photos.length >= state.maxPhotos ||
              !!uncertainAction
            }
            onClick={() => camera.current?.click()}
          >
            <span aria-hidden="true">＋</span> 撮影
          </button>
          {state.status !== 'briefing' && !state.automaticActions && (
            <button
              className="primary-button"
              disabled={uncertainAction ? busy : !canExecute}
              onClick={() => void commit()}
            >
              {busy || state.busy
                ? '確認しています…'
                : uncertainAction
                  ? '結果を再確認'
                  : 'この使い方で実行'}
              <span>→</span>
            </button>
          )}
        </div>
      )}
      <footer className="play-footer">
        <p>写真と声で遊ぶ試遊版 · 画像・動画演出は準備中</p>
        {!ended && (
          <button onClick={() => void end()} disabled={busy}>
            プレイを終了
          </button>
        )}
        {invalid ? (
          <button className="primary-button" onClick={onExit}>
            合言葉で参加し直す
          </button>
        ) : (
          ended && (
            <button
              className="primary-button"
              disabled={lifecycle !== 'terminal'}
              onClick={onReplay}
            >
              もう一度プレイ
            </button>
          )
        )}
        {['closing', 'quarantined'].includes(lifecycle) && (
          <p role="status">
            {lifecycle === 'closing'
              ? '音声の終了を確認しています。'
              : '音声の終了を確認できません。運営による確認が必要です。'}
          </p>
        )}
      </footer>
    </main>
  );
}
