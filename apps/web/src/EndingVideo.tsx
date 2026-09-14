import { useEffect, useId, useRef, useState } from 'react';
import type { EndingOutcome, EndingView } from '../../../packages/shared/ending.js';
import type { Locale } from './ChatFeed.js';
import { endingVideoPath, getEnding, PlayApiError } from './play-api.js';
import { endingErrorText } from './ending-error.js';

type Unavailable = 'auth' | 'expired' | 'missing' | 'network' | null;
const pending = new Set<EndingView['status']>(['queued', 'preparing', 'generating']);

/** Key the component by playId so a replay cannot render the previous play's media. */
export default function EndingVideo({
  playId,
  locale,
  outcome,
  clearedCount,
  summary,
}: {
  playId: string;
  locale: Locale;
  outcome?: EndingOutcome | null;
  clearedCount?: number;
  summary?: string;
}) {
  const [view, setView] = useState<EndingView | null>(null);
  const [unavailable, setUnavailable] = useState<Unavailable>(null);
  const [showStory, setShowStory] = useState(false);
  const [mediaFailed, setMediaFailed] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const detailsId = useId();
  const videoRef = useRef<HTMLVideoElement>(null);
  const t = (ja: string, en: string) => (locale === 'ja' ? ja : en);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    let expiryTimer: number | undefined;
    let failures = 0;
    const clientDeadline = Date.now() + 600_000;
    setView(null);
    setUnavailable(null);
    setShowStory(false);
    setMediaFailed(false);
    setExpanded(true);
    const expire = () => {
      controller.abort();
      window.clearTimeout(timer);
      setUnavailable('expired');
    };
    expiryTimer = window.setTimeout(expire, 600_000);
    async function poll() {
      try {
        const next = await getEnding(playId, controller.signal);
        if (controller.signal.aborted) return;
        if (next.playId !== playId) {
          setUnavailable('missing');
          return;
        }
        setView(next);
        setUnavailable(null);
        failures = 0;
        if (next.retainUntil) {
          const deadline = Math.min(Date.parse(next.retainUntil), clientDeadline);
          if (Number.isFinite(deadline)) {
            window.clearTimeout(expiryTimer);
            if (deadline <= Date.now()) return expire();
            expiryTimer = window.setTimeout(expire, deadline - Date.now());
          }
        }
        if (pending.has(next.status)) timer = window.setTimeout(() => void poll(), 2000);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof PlayApiError) {
          if (error.status === 401 || error.status === 403) return setUnavailable('auth');
          if (error.status === 410) return setUnavailable('expired');
          if (error.status === 404) return setUnavailable('missing');
        }
        setUnavailable('network');
        failures += 1;
        timer = window.setTimeout(() => void poll(), Math.min(8000, 2000 * failures));
      }
    }
    void poll();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      window.clearTimeout(expiryTimer);
    };
  }, [playId]);

  const finalOutcome = view?.outcome ?? outcome;
  const count = view?.clearedCount ?? clearedCount;
  const ready = view?.status === 'ready' && !unavailable;
  const failureText = view?.status === 'failed' ? endingErrorText(view.errorCode, locale) : null;
  let statusText = t('エンディングを確認しています…', 'Checking your ending…');
  if (unavailable) {
    statusText = {
      auth: t(
        '動画を閲覧する認証が失効しました。',
        'Your authorization to view the video expired.',
      ),
      expired: t('エンディング動画の閲覧期限が切れました。', 'The ending video has expired.'),
      missing: t('このプレイの動画を取得できません。', 'The video for this play is unavailable.'),
      network: t(
        '接続を確認しています。動画の状態を再取得します。',
        'Checking your connection. The video status will update when it reconnects.',
      ),
    }[unavailable];
  } else if (view) {
    statusText = {
      disabled: t(
        'この環境では動画生成を利用できません。',
        'Video generation is unavailable here.',
      ),
      not_applicable: t('この終了には動画はありません。', 'There is no video for this ending.'),
      queued: t('エンディング動画の順番を待っています。', 'Your ending video is waiting in line.'),
      preparing: t(
        'このプレイの結末と映像を準備しています。',
        'Preparing the story and scenes from your play.',
      ),
      generating: t('エンディング動画を生成しています。', 'Generating your ending video.'),
      ready: t(
        '再生ボタンを押して、あなたが変えた未来を見届けましょう。',
        'Press play to see the future you changed.',
      ),
      failed: t(
        '動画を生成できませんでした。プレイの結果は確定しています。',
        'The video could not be generated. Your game result is final.',
      ),
      expired: t(
        '制限時間内に動画を生成できませんでした。プレイの結果は確定しています。',
        'Video generation timed out. Your game result is final.',
      ),
    }[view.status];
  }
  return (
    <section className="ending-video" aria-label={t('このプレイの結末', 'Your ending')}>
      <div className="ending-heading">
        <h2>
          {finalOutcome
            ? {
                happy: t('ハッピーエンド', 'Happy ending'),
                normal: t('ノーマルエンド', 'Normal ending'),
                bad: t('バッドエンド', 'Bad ending'),
              }[finalOutcome]
            : t('プレイ終了', 'Game ended')}
        </h2>
        {count !== undefined && (
          <p className="ending-count">{t(`解除：${count}個`, `Cleared: ${count}`)}</p>
        )}
      </div>
      <p className="ending-status" role="status">
        {view && pending.has(view.status) && !unavailable && (
          <span className="ending-spinner" aria-hidden="true" />
        )}
        {ready && !expanded ? t('動画が完成しました', 'Your video is ready') : statusText}
      </p>
      <button
        type="button"
        className="ending-toggle"
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => {
          if (expanded) videoRef.current?.pause();
          setExpanded(!expanded);
        }}
      >
        {expanded
          ? t('閉じて会話を見返す', 'Collapse to revisit the conversation')
          : ready
            ? t('動画を見る', 'Watch video')
            : t('結果の詳細を開く', 'Show result details')}
        <span aria-hidden="true">{expanded ? '⌃' : '⌄'}</span>
      </button>
      <div id={detailsId} className="ending-details" hidden={!expanded}>
        {summary && <p className="ending-summary">{summary}</p>}
        {view && pending.has(view.status) && !unavailable && (
          <p className="ending-note">
            {t(
              '結果を閉じると、下の会話履歴を広く表示できます。動画の準備状況は閉じても確認できます。',
              'Collapse the result to make room for the conversation below. The video status stays visible.',
            )}
          </p>
        )}
        {failureText && !unavailable && <p>{failureText}</p>}
        {view?.status === 'failed' &&
          view.errorCode &&
          /^ENDING_[A-Z0-9_]{1,80}$/.test(view.errorCode) &&
          !unavailable && (
            <details className="ending-note">
              <summary>{t('不具合報告用の情報', 'Information for reporting this issue')}</summary>
              <code>{view.errorCode}</code>
            </details>
          )}
        {ready && !mediaFailed && (
          <video
            ref={videoRef}
            key={playId}
            src={endingVideoPath(playId)}
            controls
            playsInline
            preload="metadata"
            aria-label={t('エンディング動画', 'Ending video')}
            onEnded={() => setShowStory(true)}
            onError={() => setMediaFailed(true)}
          />
        )}
        {ready && mediaFailed && (
          <p role="status">
            {t(
              '動画を再生できません。下のボタンから結末を確認できます。',
              'The video could not be played. Use the button below to read your ending.',
            )}
          </p>
        )}
        {view?.story && !showStory && (
          <button type="button" className="ending-reveal" onClick={() => setShowStory(true)}>
            {t('結果を見る', 'Read the ending')}
          </button>
        )}
        {view?.story && showStory && (
          <div className="ending-story">
            <h3>{view.story.title}</h3>
            <p>{view.story.text}</p>
            <p>{view.story.evaluation}</p>
          </div>
        )}
      </div>
    </section>
  );
}
