import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../../../packages/shared/conversation.js';
import { playRequest, PlayApiError, controlHeaders } from './play-api.js';
export type Locale = 'ja' | 'en';
export type Feed = {
  playId: string;
  locale: Locale;
  version: number;
  reset: boolean;
  upserts: ChatMessage[];
  removedIds: string[];
  retainUntil: string | null;
};
export function mergeFeed(previous: ChatMessage[], feed: Feed): ChatMessage[] {
  const removed = new Set(feed.removedIds);
  const messages = new Map(
    (feed.reset ? [] : previous).filter((m) => !removed.has(m.id)).map((m) => [m.id, m]),
  );
  for (const message of feed.upserts)
    if (
      !removed.has(message.id) &&
      (!messages.has(message.id) ||
        messages.get(message.id)!.updatedVersion <= message.updatedVersion)
    )
      messages.set(message.id, message);
  return [...messages.values()].sort((a, b) => a.createdOrder - b.createdOrder);
}
function PrivateImage({
  playId,
  assetId,
  locale,
  scene = false,
}: {
  playId: string;
  assetId: string;
  locale: Locale;
  scene?: boolean;
}) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = '';
    setUrl('');
    setFailed(false);
    void fetch('/api/play/assets/' + encodeURIComponent(assetId), {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: controlHeaders({ playId }),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (
          !response.ok ||
          response.headers.get('content-type')?.split(';')[0] !== 'image/jpeg' ||
          Number(response.headers.get('content-length') ?? 0) > 256 * 1024
        )
          throw new Error('Asset unavailable');
        const blob = await response.blob();
        if (blob.size > 256 * 1024) throw new Error('Asset too large');
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [playId, assetId]);
  return url ? (
    <a href={url} target="_blank" rel="noreferrer">
      <img
        className="chat-image"
        src={url}
        alt={locale === 'ja' ? '会話に添付された写真' : 'Photo attached to the conversation'}
      />
    </a>
  ) : (
    <p className="chat-media-status">
      {failed
        ? locale === 'ja'
          ? scene
            ? '未来から画像の受信に失敗しました'
            : '画像を読み込めませんでした'
          : scene
            ? 'Failed to receive the image from the future.'
            : 'Unable to load image'
        : locale === 'ja'
          ? '画像を読み込み中…'
          : 'Loading image…'}
    </p>
  );
}
export default function ChatFeed({
  playId,
  locale,
  sentMessageIds,
  connected,
  generation,
  embedded = false,
}: {
  playId: string;
  locale: Locale;
  sentMessageIds: ReadonlySet<string>;
  connected: boolean;
  generation: number;
  embedded?: boolean;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  const [tick, setTick] = useState(0);
  const firstSeen = useRef(new Map<string, number>());
  const historical = useRef(new Set<string>());
  const scroll = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const content = useRef<HTMLDivElement>(null);
  const userScrollUntil = useRef(0);
  const markUserScroll = () => {
    userScrollUntil.current = performance.now() + 1000;
  };
  // Layout growth must not be mistaken for a user leaving the latest message.
  // Only explicit scrolling changes the follow intent; image load is handled by ResizeObserver.
  useEffect(() => {
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (nearBottom.current && scroll.current)
          scroll.current.scrollTop = scroll.current.scrollHeight;
      });
    });
    if (content.current) observer.observe(content.current);
    if (scroll.current) observer.observe(scroll.current);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  useEffect(() => {
    let stopped = false,
      version = 0,
      first = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const feed = await playRequest<Feed>('/api/play/feed?after=' + version, undefined, 'GET', {
          playId,
        });
        if (stopped) return;
        const now = Date.now();
        for (const m of feed.upserts) {
          if (!firstSeen.current.has(m.id)) firstSeen.current.set(m.id, now);
          // A restored history has no corresponding active playback to wait for.
          let restored = false;
          try {
            restored = !!sessionStorage.getItem('callpast-feed:' + playId);
          } catch {}
          if (first && restored) historical.current.add(m.id);
        }
        if (feed.reset) {
          const kept = new Set(feed.upserts.map((m) => m.id));
          for (const id of firstSeen.current.keys())
            if (!kept.has(id)) {
              firstSeen.current.delete(id);
              historical.current.delete(id);
            }
        }
        for (const id of feed.removedIds) {
          firstSeen.current.delete(id);
          historical.current.delete(id);
        }
        setMessages((old) => mergeFeed(old, feed));
        version = feed.version;
        first = false;
        setError('');
        try {
          sessionStorage.setItem('callpast-feed:' + playId, '1');
        } catch {}
      } catch (e) {
        if (stopped) return;
        if (e instanceof PlayApiError && [401, 403, 410].includes(e.status)) {
          setExpired(true);
          setMessages([]);
          return;
        }
        setError(
          locale === 'ja'
            ? '会話の受信が途切れています。再接続中…'
            : 'Conversation interrupted. Reconnecting…',
        );
      }
      if (!stopped) timer = setTimeout(poll, 500);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [playId, locale]);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(timer);
  }, []);
  useLayoutEffect(() => {
    if (nearBottom.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages, tick]);
  return (
    <section
      className="chat-panel"
      aria-label={locale === 'ja' ? '未来との会話' : 'Conversation with the future'}
    >
      {!embedded && (
        <div className="chat-heading">
          <span>{locale === 'ja' ? '未来のあなたのAI' : 'Your future AI'}</span>
          <small>
            {locale === 'ja' ? '写真と声でつながる' : 'Connected through photos and voice'}
          </small>
        </div>
      )}
      <div
        className="chat-messages"
        ref={scroll}
        tabIndex={0}
        onWheel={markUserScroll}
        onTouchMove={markUserScroll}
        onPointerDown={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          if (event.clientX >= rect.right - 20) markUserScroll();
        }}
        onKeyDown={(event) => {
          if (
            ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
          )
            markUserScroll();
        }}
        onScroll={() => {
          const el = scroll.current!;
          if (performance.now() < userScrollUntil.current)
            nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
      >
        <div
          ref={content}
          style={{ display: 'flex', flexDirection: 'column', gap: 14, flexShrink: 0 }}
        >
          {!messages.length && !expired && (
            <p className="chat-empty">
              {locale === 'ja'
                ? '声が届くと、ここに会話が表示されます。'
                : 'Your conversation will appear here.'}
            </p>
          )}
          {messages.map((m) => {
            const needsVoice = m.kind === 'result' && m.relatedCommandSeq !== null;
            const delivered = sentMessageIds.has(m.id);
            const fallback =
              historical.current.has(m.id) ||
              !connected ||
              generation !== m.liveGeneration ||
              Date.now() - (firstSeen.current.get(m.id) ?? 0) >= 2000;
            if (needsVoice && !delivered && !fallback) return null;
            const slot = m.imageSlot;
            return (
              <article
                className={'chat-bubble chat-' + m.side + ' chat-' + m.kind}
                key={m.id}
                data-message-id={m.id}
              >
                <span className="chat-speaker">
                  {m.side === 'user'
                    ? locale === 'ja'
                      ? 'あなた'
                      : 'You'
                    : locale === 'ja'
                      ? '未来のあなたのAI'
                      : 'Your future AI'}
                </span>
                {m.text && <p>{m.text}</p>}
                {m.assetIds.map((id) => (
                  <PrivateImage key={id} playId={playId} assetId={id} locale={locale} />
                ))}
                {slot &&
                  (slot.status === 'ready' && slot.assetId ? (
                    <PrivateImage playId={playId} assetId={slot.assetId} locale={locale} scene />
                  ) : ['failed', 'cancelled'].includes(slot.status) ? (
                    <p className="chat-media-status">
                      {locale === 'ja'
                        ? '未来から画像の受信に失敗しました'
                        : 'Failed to receive the image from the future.'}
                    </p>
                  ) : (
                    <div className="scene-receiving" role="status">
                      <span className="signal-animation" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                      <span>
                        {locale === 'ja'
                          ? '未来から画像を受信中…'
                          : 'Receiving an image from the future…'}
                      </span>
                    </div>
                  ))}
                {needsVoice && !delivered && fallback && (
                  <small className="chat-audio-note">
                    {locale === 'ja'
                      ? '音声を送信できなかったため、文章でお届けします。'
                      : 'Shown as text because the audio could not be sent.'}
                  </small>
                )}
              </article>
            );
          })}
          {error && <p role="status">{error}</p>}
          {expired && (
            <p role="status">
              {locale === 'ja'
                ? 'この会話の閲覧期限が終了しました。'
                : 'This conversation is no longer available.'}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
