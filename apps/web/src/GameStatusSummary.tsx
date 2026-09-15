import { useEffect, useRef, useState } from 'react';

export default function GameStatusSummary({
  title,
  ended,
  locale,
}: {
  title: string;
  ended: boolean;
  locale: 'ja' | 'en';
}) {
  const t = (ja: string, en: string) => (locale === 'ja' ? ja : en);
  return (
    <summary className="messenger-status">
      <span className="messenger-objective">
        {!ended && (
          <span className="messenger-resource-label">{t('現在の目標', 'Current objective')}</span>
        )}
        <strong>{title}</strong>
      </span>
      <svg className="messenger-details-chevron" viewBox="0 0 24 24" aria-hidden="true">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </summary>
  );
}

export function GameResourceCounters({
  remainingMs,
  photoSendsRemaining,
  locale,
}: {
  remainingMs: number;
  photoSendsRemaining: number;
  locale: 'ja' | 'en';
}) {
  const t = (ja: string, en: string) => (locale === 'ja' ? ja : en);
  const lowTime = remainingMs > 0 && remainingMs <= 60_000;
  const previousTime = useRef(remainingMs);
  // Restoring a play already below one minute should not replay the threshold warning.
  const warned = useRef(remainingMs <= 60_000);
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    if (lowTime && previousTime.current > 60_000 && !warned.current) {
      warned.current = true;
      setPulse(true);
    }
    previousTime.current = remainingMs;
  }, [remainingMs, lowTime]);
  useEffect(() => {
    if (!pulse) return;
    const timeout = window.setTimeout(() => setPulse(false), 1000);
    return () => window.clearTimeout(timeout);
  }, [pulse]);

  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const clock =
    String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  const actionWarning =
    photoSendsRemaining <= 0
      ? t(
          '送信回数を使い切りました。手持ちの道具で続けられます。',
          'No photo sends left. You can continue with your existing tools.',
        )
      : photoSendsRemaining === 1
        ? t('送信は残り1回です。', 'One photo send remaining.')
        : photoSendsRemaining === 2
          ? t('送信は残り2回です。', 'Two photo sends remaining.')
          : '';

  return (
    <div className="messenger-counters">
      <span
        className={
          'messenger-resource messenger-clock' +
          (lowTime ? ' is-urgent' : '') +
          (pulse ? ' clock-warning-pulse' : '')
        }
      >
        <span className="messenger-resource-label">{t('残り時間', 'Time left')}</span>
        <strong>
          {clock}
          {lowTime && <WarningIcon />}
        </strong>
      </span>
      <span
        className={
          'messenger-resource messenger-action-count' +
          (photoSendsRemaining <= 1 ? ' is-urgent' : photoSendsRemaining === 2 ? ' is-caution' : '')
        }
      >
        <span className="messenger-resource-label">{t('残り送信回数', 'Photo sends left')}</span>
        <strong>
          {photoSendsRemaining}
          {photoSendsRemaining <= 2 && <WarningIcon />}
        </strong>
      </span>
      <span className="messenger-status-announcement" role="status" aria-atomic="true">
        {[
          lowTime ? t('残り時間は1分以下です。', 'One minute or less remaining.') : '',
          actionWarning,
        ]
          .filter(Boolean)
          .join(' ')}
      </span>
    </div>
  );
}

function WarningIcon() {
  return (
    <svg className="messenger-warning-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3 2 21h20L12 3Z" />
      <path d="M12 9v5m0 3v.5" />
    </svg>
  );
}
