import { randomUUID } from 'node:crypto';
import { assertController, claimController, SessionError, type Controller } from './control.js';
import type { AuthSession } from './session-store.js';
import type { Difficulty } from '../../packages/shared/difficulty.js';

export type PlayLifecycle =
  | 'connecting'
  | 'active'
  | 'recovering'
  | 'closing'
  | 'terminal'
  | 'quarantined';
export interface PlayRuntime<T, R = unknown> extends Controller {
  id: string;
  ownerDigest: string;
  createdAt: number;
  deadline: number;
  expiresAt: string;
  lifecycle: PlayLifecycle;
  recoveryDeadline: number | null;
  lastHeartbeat: number;
  voiceState: string;
  runtime: T | null;
  result?: R;
  terminalUntil?: number;
  closingPromise?: Promise<void>;
  closeUnconfirmed?: boolean;
  controlPromise?: Promise<void>;
  controlPending?: boolean;
}

export interface PlayRegistryOptions<T, R> {
  factory: (
    id: string,
    deadline: number,
    owner: AuthSession,
    request: { locale?: 'ja' | 'en'; difficulty?: Difficulty },
  ) => T;
  expire: (runtime: T) => void;
  close: (runtime: T) => Promise<boolean>;
  snapshot: (runtime: T) => R;
  dispose: (runtime: T) => void;
  transferControl: (runtime: T) => Promise<boolean>;
  closeConfirmed?: (playId: string) => boolean;
  now?: () => number;
  wallNow?: () => number;
  capacity?: number;
  ttlMs?: number;
  recoveryMs?: number;
  resultTtlMs?: number;
}

/** Owns admission and deadlines; game and provider implementations are injected. */
export class PlayRegistry<T, R = unknown> {
  readonly plays = new Map<string, PlayRuntime<T, R>>();
  admission: 'open' | 'draining' = 'open';
  private readonly now: () => number;
  private readonly wallNow: () => number;
  constructor(private readonly options: PlayRegistryOptions<T, R>) {
    this.now = options.now ?? (() => performance.now());
    this.wallNow = options.wallNow ?? Date.now;
  }

  private expired(play: PlayRuntime<T, R>): boolean {
    const recovery =
      play.recoveryDeadline ?? play.lastHeartbeat + (this.options.recoveryMs ?? 60_000);
    return this.now() >= play.deadline || this.now() >= recovery;
  }
  get occupied(): number {
    return [...this.plays.values()].filter((play) => play.lifecycle !== 'terminal').length;
  }
  hasActivePlay(owner: AuthSession): boolean {
    const play = owner.activePlayId ? this.plays.get(owner.activePlayId) : undefined;
    return (
      !!play &&
      play.ownerDigest === owner.digest &&
      !this.expired(play) &&
      !['closing', 'terminal', 'quarantined'].includes(play.lifecycle)
    );
  }

  create(
    owner: AuthSession,
    request: { requestId: string; clientId: string; locale?: 'ja' | 'en'; difficulty?: Difficulty },
  ): { play: PlayRuntime<T, R>; reused: boolean } {
    if (owner.lastCreateRequestId === request.requestId) {
      if (
        owner.lastCreateClientId !== request.clientId ||
        owner.lastCreateLocale !== request.locale ||
        owner.lastCreateDifficulty !== request.difficulty
      )
        throw new SessionError('PLAY_CONFLICT', 409);
      const play = owner.lastCreatePlayId ? this.plays.get(owner.lastCreatePlayId) : undefined;
      if (!play) throw new SessionError('PLAY_EXPIRED', 410);
      return { play, reused: true };
    }
    if (this.admission !== 'open') throw new SessionError('DRAINING', 503);
    const previous = owner.activePlayId ? this.plays.get(owner.activePlayId) : undefined;
    if (previous && previous.lifecycle !== 'terminal')
      throw new SessionError('PLAY_ALREADY_ACTIVE', 409);
    if (this.occupied >= (this.options.capacity ?? 5)) throw new SessionError('PLAY_CAPACITY', 409);
    const now = this.now();
    const ttl = this.options.ttlMs ?? 600_000;
    const play: PlayRuntime<T, R> = {
      id: randomUUID(),
      ownerDigest: owner.digest,
      createdAt: now,
      deadline: now + ttl,
      expiresAt: new Date(this.wallNow() + ttl).toISOString(),
      lifecycle: 'connecting',
      clientId: request.clientId,
      controllerEpoch: 1,
      leaseUntil: now + 30_000,
      recoveryDeadline: now + (this.options.recoveryMs ?? 60_000),
      lastHeartbeat: now,
      voiceState: 'connecting',
      runtime: null,
    };
    // Reserve before invoking even a synchronous factory; reentrant creates see the slot.
    this.plays.set(play.id, play);
    owner.activePlayId = play.id;
    try {
      play.runtime = this.options.factory(play.id, play.deadline, owner, request);
    } catch (error) {
      this.plays.delete(play.id);
      owner.activePlayId = previous?.id ?? null;
      throw error;
    }
    owner.lastCreateLocale = request.locale;
    owner.lastCreateDifficulty = request.difficulty;
    owner.lastCreateRequestId = request.requestId;
    owner.lastCreateClientId = request.clientId;
    owner.lastCreatePlayId = play.id;
    return { play, reused: false };
  }

  get(owner: AuthSession, playId = owner.activePlayId): PlayRuntime<T, R> {
    if (!playId) throw new SessionError('PLAY_EXPIRED', 410);
    const play = this.plays.get(playId);
    if (!play) throw new SessionError('PLAY_EXPIRED', 410);
    if (play.ownerDigest !== owner.digest) throw new SessionError('PLAY_FORBIDDEN', 403);
    if (play.lifecycle === 'terminal' && this.now() >= (play.terminalUntil ?? 0))
      throw new SessionError('PLAY_EXPIRED', 410);
    return play;
  }

  assertControl(
    owner: AuthSession,
    playId: string,
    clientId: string,
    epoch: number,
  ): PlayRuntime<T, R> {
    const play = this.get(owner, playId);
    assertController(play, clientId, epoch);
    if (play.controlPending) throw new SessionError('CONTROL_BUSY', 409);
    if (this.expired(play) || ['closing', 'terminal', 'quarantined'].includes(play.lifecycle))
      throw new SessionError('PLAY_EXPIRED', 410);
    return play;
  }

  async control(
    owner: AuthSession,
    playId: string,
    clientId: string,
    takeover: boolean,
  ): Promise<PlayRuntime<T, R>> {
    const play = this.get(owner, playId);
    if (this.expired(play) || ['closing', 'terminal', 'quarantined'].includes(play.lifecycle))
      throw new SessionError('PLAY_EXPIRED', 410);
    if (claimController(play, clientId, takeover, this.now()) && play.runtime) {
      const runtime = play.runtime;
      const transferEpoch = play.controllerEpoch;
      play.controlPending = true;
      play.controlPromise = (async () => {
        let confirmed = false;
        let closeAttemptCompleted = false;
        try {
          confirmed = await this.options.transferControl(runtime);
          closeAttemptCompleted = true;
        } catch {
          /* Keep the slot on unknown cleanup. */
        }
        if (!confirmed && play.lifecycle !== 'terminal')
          await this.quarantine(play, closeAttemptCompleted);
        if (play.controllerEpoch === transferEpoch) play.controlPending = false;
      })();
    }
    const claimedEpoch = play.controllerEpoch;
    await play.controlPromise;
    assertController(play, clientId, claimedEpoch);
    if (this.expired(play) || ['closing', 'terminal', 'quarantined'].includes(play.lifecycle))
      throw new SessionError('PLAY_EXPIRED', 410);
    return play;
  }

  heartbeat(
    owner: AuthSession,
    playId: string,
    clientId: string,
    epoch: number,
    voiceState: string,
  ): PlayRuntime<T, R> {
    const play = this.assertControl(owner, playId, clientId, epoch);
    const now = this.now();
    play.lastHeartbeat = now;
    play.leaseUntil = now + 30_000;
    play.voiceState = voiceState;
    if (voiceState === 'connected') {
      play.lifecycle = 'active';
      play.recoveryDeadline = null;
    } else {
      if (play.recoveryDeadline === null)
        play.recoveryDeadline = now + (this.options.recoveryMs ?? 60_000);
      if (play.lifecycle !== 'connecting') play.lifecycle = 'recovering';
    }
    return play;
  }

  private async quarantine(play: PlayRuntime<T, R>, closeAttemptCompleted = false): Promise<void> {
    if (play.runtime) {
      this.options.expire(play.runtime);
      play.result = this.options.snapshot(play.runtime);
      this.options.dispose(play.runtime);
      play.runtime = null;
    }
    play.closeUnconfirmed = closeAttemptCompleted;
    play.lifecycle = 'quarantined';
  }

  private markTerminal(play: PlayRuntime<T, R>): void {
    play.closeUnconfirmed = false;
    play.lifecycle = 'terminal';
    play.terminalUntil = this.now() + (this.options.resultTtlMs ?? 120_000);
  }

  /** Reconcile only provider-confirmed closes after their runtime has been discarded. */
  reconcileConfirmedClosures(): void {
    if (!this.options.closeConfirmed) return;
    for (const play of this.plays.values()) {
      if (play.lifecycle !== 'quarantined' || !play.closeUnconfirmed) continue;
      try {
        if (this.options.closeConfirmed(play.id)) this.markTerminal(play);
      } catch {
        /* A failed confirmation check leaves the quarantined admission slot intact. */
      }
    }
  }

  end(play: PlayRuntime<T, R>): Promise<void> {
    if (play.closingPromise) return play.closingPromise;
    if (play.lifecycle === 'terminal' || play.lifecycle === 'quarantined') return Promise.resolve();
    play.lifecycle = 'closing';
    const runtime = play.runtime;
    if (runtime) {
      this.options.expire(runtime);
      play.result = this.options.snapshot(runtime);
      this.options.dispose(runtime);
    }
    play.closingPromise = (async () => {
      let confirmed = !runtime;
      let closeAttemptCompleted = false;
      try {
        if (runtime) {
          confirmed = await this.options.close(runtime);
          closeAttemptCompleted = true;
        }
      } catch {
        /* Unknown provider close retains admission. */
      }
      play.runtime = null;
      if (confirmed) this.markTerminal(play);
      else {
        play.closeUnconfirmed = closeAttemptCompleted;
        play.lifecycle = 'quarantined';
      }
    })();
    return play.closingPromise;
  }

  async sweep(waitForClose = true): Promise<void> {
    this.reconcileConfirmedClosures();
    const now = this.now();
    const closing: Promise<void>[] = [];
    for (const play of this.plays.values()) {
      if (play.lifecycle === 'terminal') {
        if (now >= (play.terminalUntil ?? 0)) this.plays.delete(play.id);
        continue;
      }
      if (play.lifecycle === 'closing' || play.lifecycle === 'quarantined') continue;
      if (play.lifecycle === 'active' && now - play.lastHeartbeat >= 30_000) {
        play.lifecycle = 'recovering';
        play.recoveryDeadline = play.lastHeartbeat + (this.options.recoveryMs ?? 60_000);
      }
      if (now >= play.deadline || (play.recoveryDeadline !== null && now >= play.recoveryDeadline))
        closing.push(this.end(play));
    }
    const completion = Promise.all(closing);
    if (waitForClose) await completion;
    else void completion.catch(() => {});
  }

  async drain(): Promise<void> {
    this.admission = 'draining';
    await Promise.all([...this.plays.values()].map((play) => this.end(play)));
    this.reconcileConfirmedClosures();
  }
  resume(): void {
    if (this.occupied !== 0) throw new SessionError('DRAIN_INCOMPLETE', 409);
    this.admission = 'open';
  }
}
