import { createHash, randomBytes } from 'node:crypto';
import { SessionError } from './control.js';
import type { Difficulty } from '../../packages/shared/difficulty.js';

export interface AuthSession {
  digest: string;
  expiresAt: number;
  activePlayId: string | null;
  lastCreateRequestId?: string;
  lastCreateLocale?: 'ja' | 'en';
  lastCreateDifficulty?: Difficulty;
  lastCreateClientId?: string;
  lastCreatePlayId?: string;
}

export interface SessionStoreOptions {
  now?: () => number;
  ttlMs?: number;
  capacity?: number;
  authAttemptsPerMinute?: number;
  hasRetainedResult?: (session: AuthSession) => boolean;
  hasActivePlay?: (session: AuthSession) => boolean;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

export class SessionStore {
  private readonly sessions = new Map<string, AuthSession>();
  private readonly now: () => number;
  private attempts = 0;
  private windowStart: number;

  constructor(private readonly options: SessionStoreOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.windowStart = this.now();
  }

  createSession(existingToken?: string): { token: string; session: AuthSession } {
    const now = this.now();
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.attempts = 0;
    }
    if (++this.attempts > (this.options.authAttemptsPerMinute ?? 100))
      throw new SessionError('AUTH_RATE_LIMIT', 429);
    this.sweep();
    const existing = existingToken ? this.lookup(existingToken) : undefined;
    if (existing) {
      existing.expiresAt = now + (this.options.ttlMs ?? 1_800_000);
      return { token: existingToken!, session: existing };
    }
    if (this.sessions.size >= (this.options.capacity ?? 1000))
      throw new SessionError('AUTH_CAPACITY', 429);
    const token = randomBytes(32).toString('base64url');
    const session: AuthSession = {
      digest: digest(token).toString('hex'),
      expiresAt: now + (this.options.ttlMs ?? 1_800_000),
      activePlayId: null,
    };
    this.sessions.set(session.digest, session);
    return { token, session };
  }

  private lookup(token: string): AuthSession | undefined {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    return this.sessions.get(digest(token).toString('hex'));
  }

  authorize(token?: string): AuthSession {
    if (!token) throw new SessionError('AUTH_REQUIRED', 401);
    const session = this.lookup(token);
    if (!session || (this.now() >= session.expiresAt && !this.options.hasActivePlay?.(session))) {
      throw new SessionError('SESSION_EXPIRED', 410);
    }
    return session;
  }

  authorizeResult(token?: string): AuthSession {
    if (!token) throw new SessionError('AUTH_REQUIRED', 401);
    const session = this.lookup(token);
    if (
      !session ||
      (this.now() >= session.expiresAt &&
        !this.options.hasActivePlay?.(session) &&
        !this.options.hasRetainedResult?.(session))
    )
      throw new SessionError('SESSION_EXPIRED', 410);
    return session;
  }
  sweep(): void {
    for (const [key, session] of this.sessions) {
      if (
        this.now() >= session.expiresAt &&
        !this.options.hasActivePlay?.(session) &&
        !this.options.hasRetainedResult?.(session)
      )
        this.sessions.delete(key);
    }
  }

  get size(): number {
    return this.sessions.size;
  }
}
