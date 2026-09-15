import { useEffect, useRef, useState } from 'react';

/** Opening media. This screen creates no game or Live connection. */
export default function OpeningSequence({
  locale,
  busy,
  error,
  onAnswer,
}: {
  locale: 'ja' | 'en';
  busy: boolean;
  error: string;
  onAnswer: () => void;
}) {
  const [phase, setPhase] = useState<'movie' | 'calling'>('movie');
  const [blocked, setBlocked] = useState(false);
  const [movieFailed, setMovieFailed] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const ring = useRef<HTMLAudioElement>(null);
  const t = (ja: string, en: string) => (locale === 'ja' ? ja : en);
  const stopRing = () => {
    if (ring.current) {
      ring.current.pause();
      ring.current.currentTime = 0;
    }
  };
  const playMedia = () => {
    const media = phase === 'movie' ? video.current : ring.current;
    if (!media || document.hidden || busy) return;
    void media
      .play()
      .then(() => setBlocked(false))
      .catch(() => setBlocked(true));
  };
  useEffect(() => {
    setBlocked(false);
    playMedia();
    const visibility = () => {
      if (document.hidden) {
        video.current?.pause();
        ring.current?.pause();
      } else playMedia();
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      video.current?.pause();
      ring.current?.pause();
    };
  }, [phase, busy]);
  function finishMovie() {
    video.current?.pause();
    setBlocked(false);
    setPhase('calling');
  }
  return (
    <main className="opening-sequence">
      <audio ref={ring} src="/media/incoming-call.mp3" loop preload="auto" />
      {phase === 'movie' ? (
        <section className="opening-movie" aria-label={t('オープニング動画', 'Opening movie')}>
          <video
            ref={video}
            src="/media/Intro_movie.mp4"
            playsInline
            preload="auto"
            onEnded={finishMovie}
            onError={() => setMovieFailed(true)}
          />
          {(blocked || movieFailed) && (
            <div className="opening-play-prompt">
              {movieFailed ? (
                <p>
                  {t(
                    '動画を再生できません。Skipで着信へ進めます。',
                    'The movie could not load. Select Skip to continue.',
                  )}
                </p>
              ) : (
                <button className="primary-button" onClick={playMedia}>
                  {t('動画を再生', 'Play opening')}
                </button>
              )}
            </div>
          )}
          <button className="opening-skip" onClick={finishMovie}>
            Skip <span aria-hidden="true">↗</span>
          </button>
        </section>
      ) : (
        <>
          <div className="incoming-messenger" aria-hidden="true">
            <p className="play-brand">
              CALL <span>TO</span> PAST
            </p>
            <section className="chat-panel">
              <div className="chat-heading">
                <span>{t('未来からの通信', 'Connection from the future')}</span>
                <small>●</small>
              </div>
              <div className="incoming-empty">
                <span>↗</span>
                <p>
                  {t(
                    '通話が始まると、ここに会話が届きます。',
                    'Your conversation will appear here when the call begins.',
                  )}
                </p>
              </div>
            </section>
            <div className="incoming-composer">
              ＋ <span>{t('声と写真でつながる', 'Connect through voice and photos')}</span>
            </div>
          </div>
          <section
            className="incoming-overlay"
            role="dialog"
            aria-modal="true"
            aria-label={t('未来からの着信', 'Incoming call')}
          >
            <div className="incoming-card">
              <div className="incoming-avatar" aria-hidden="true">
                ↗
              </div>
              <p className="incoming-label">Calling</p>
              <h1>{t('未来からの着信', 'A call from the future')}</h1>
              <p>
                {t(
                  '向こうで、あなたを待っている。',
                  'Someone is waiting for you on the other side.',
                )}
              </p>
              {error && (
                <p className="play-error" role="alert">
                  {error}
                </p>
              )}
              {blocked && !busy && (
                <button className="secondary-button" onClick={playMedia}>
                  {t('着信音を再生', 'Play ringtone')}
                </button>
              )}
              <button
                className="incoming-answer"
                disabled={busy}
                onClick={() => {
                  stopRing();
                  onAnswer();
                }}
              >
                <span aria-hidden="true">↗</span>
                {busy ? t('接続中…', 'Connecting…') : t('応答する', 'Answer')}
              </button>
              <small>{t('応答するとマイクを使用します', 'Answer to enable your microphone')}</small>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
