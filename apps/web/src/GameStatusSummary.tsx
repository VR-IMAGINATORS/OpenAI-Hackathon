import { useEffect, useRef, useState } from 'react';
import { creditCosts, type CreditCharge } from '../../../packages/shared/credits.js';

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
  creditsRemaining,
  initialCredits,
  locale,
}: {
  remainingMs: number;
  creditsRemaining: number;
  initialCredits: number;
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
  const lowCredits = creditsRemaining <= initialCredits * 0.2;

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
          'messenger-resource messenger-credit-count' +
          (creditsRemaining <= 0 ? ' is-urgent' : lowCredits ? ' is-caution' : '')
        }
      >
        <span className="messenger-resource-label">{t('残りクレジット', 'Credits left')}</span>
        <strong>
          {creditsRemaining.toLocaleString(locale)}
          {lowCredits && <WarningIcon />}
        </strong>
      </span>
      <span className="messenger-status-announcement" role="status" aria-atomic="true">
        {lowTime ? t('残り時間は1分以下です。', 'One minute or less remaining.') : ''}
      </span>
    </div>
  );
}

export function GameCreditNotice({
  creditsRemaining,
  initialCredits,
  lastCreditCharge,
  locale,
}: {
  creditsRemaining: number;
  initialCredits: number;
  lastCreditCharge: CreditCharge | null;
  locale: 'ja' | 'en';
}) {
  const t = (ja: string, en: string) => (locale === 'ja' ? ja : en);
  // Restoring a play should not replay an old charge notification.
  const previousSequence = useRef(lastCreditCharge?.sequence ?? 0);
  const [charge, setCharge] = useState<CreditCharge | null>(null);
  useEffect(() => {
    if (!lastCreditCharge || lastCreditCharge.sequence <= previousSequence.current) return;
    previousSequence.current = lastCreditCharge.sequence;
    setCharge(lastCreditCharge);
  }, [lastCreditCharge]);
  useEffect(() => {
    if (!charge) return;
    const timeout = window.setTimeout(() => setCharge(null), 3500);
    return () => window.clearTimeout(timeout);
  }, [charge]);
  return (
    <div className="game-credit-notice">
      <div className="game-credit-rates">
        <span>
          {t('会話', 'Conversation')} {creditCosts.conversation} · {t('写真', 'Photo')}{' '}
          {creditCosts.photo}
          {t('/枚', ' each')}
        </span>
        <span className="game-credit-charge" role="status" aria-atomic="true">
          {charge && (
            <>
              {charge.kind === 'photo'
                ? t('画像認識', 'Image recognition')
                : t('音声会話', 'Voice conversation')}
              {' −'}
              {charge.amount}
            </>
          )}
        </span>
      </div>
      {creditsRemaining <= initialCredits * 0.2 && (
        <p className="game-credit-warning" role="status">
          {creditsRemaining <= 0
            ? t('クレジットを使い切りました。', 'You have used all your credits.')
            : t('ご利用可能クレジットが残りわずかです', 'Your available credits are running low.')}
        </p>
      )}
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
