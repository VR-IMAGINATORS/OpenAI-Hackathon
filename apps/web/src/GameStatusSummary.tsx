import { useEffect, useRef, useState } from 'react';

export default function GameStatusSummary({
  title,
  ended,
  remainingMs,
  actionsRemaining,
  locale,
}: {
  title: string;
  ended: boolean;
  remainingMs: number;
  actionsRemaining: number;
  locale: 'ja' | 'en';
}) {
  const t = (ja: string, en: string) => (locale === 'ja' ? ja : en);
  const lowTime = !ended && remainingMs > 0 && remainingMs <= 60_000;
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
    actionsRemaining <= 0
      ? t('行動回数が残っていません。', 'No actions remaining.')
      : actionsRemaining === 1
        ? t('行動は残り1回です。', 'One action remaining.')
        : actionsRemaining === 2
          ? t('行動は残り2回です。', 'Two actions remaining.')
          : '';

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
      {!ended && (
        <span className="messenger-counters">
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
              (actionsRemaining <= 1 ? ' is-urgent' : actionsRemaining === 2 ? ' is-caution' : '')
            }
          >
            <span className="messenger-resource-label">{t('残り行動回数', 'Actions left')}</span>
            <strong>
              {actionsRemaining}
              {actionsRemaining <= 2 && <WarningIcon />}
            </strong>
          </span>
        </span>
      )}
      <span className="messenger-status-announcement" role="status" aria-atomic="true">
        {!ended &&
          [
            lowTime ? t('残り時間は1分以下です。', 'One minute or less remaining.') : '',
            actionWarning,
          ]
            .filter(Boolean)
            .join(' ')}
      </span>
    </summary>
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
