import sharp from 'sharp';
import { GameError } from '../local-server/game.js';

interface Waiter {
  start: () => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

/** Limits expensive image decoding, separately from asynchronous AI requests. */
export class PhotoQueue {
  private active = false;
  private waiting: Waiter[] = [];
  private disposed = false;

  constructor(private timeoutMs = 5000) {
    sharp.concurrency(1);
  }

  async run<T>(
    operation: () => Promise<T>,
    valid: () => boolean,
    signal?: AbortSignal,
  ): Promise<T> {
    const available = () => !this.disposed && !signal?.aborted && valid();
    if (!available()) throw new GameError(410, 'プレイが失効しました。');
    if (this.active) {
      if (this.waiting.length >= 4)
        throw new GameError(503, '写真を処理中です。少し待って再試行してください。');
      await new Promise<void>((resolve, reject) => {
        const remove = (error: Error) => {
          this.waiting = this.waiting.filter((item) => item !== waiter);
          waiter.cleanup();
          reject(error);
        };
        const aborted = () => remove(new GameError(410, '写真処理が中止されました。'));
        const timer = setTimeout(
          () => remove(new GameError(503, '写真を処理中です。少し待って再試行してください。')),
          this.timeoutMs,
        );
        const expiry = setInterval(() => {
          if (!available()) aborted();
        }, 50);
        const waiter: Waiter = {
          start: resolve,
          reject,
          cleanup: () => {
            clearTimeout(timer);
            clearInterval(expiry);
            signal?.removeEventListener('abort', aborted);
          },
        };
        signal?.addEventListener('abort', aborted, { once: true });
        this.waiting.push(waiter);
      });
    } else this.active = true;
    try {
      if (!available()) throw new GameError(410, 'プレイが失効しました。');
      return await operation();
    } finally {
      const next = this.waiting.shift();
      if (next) {
        next.cleanup();
        next.start();
      } else this.active = false;
    }
  }

  dispose() {
    this.disposed = true;
    for (const waiter of this.waiting) {
      waiter.cleanup();
      waiter.reject(new GameError(503, 'サーバーは終了中です。'));
    }
    this.waiting = [];
  }
}
