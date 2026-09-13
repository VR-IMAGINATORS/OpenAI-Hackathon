import type { AiConfig } from './ai-config.js';
import {
  createOpenAITransport,
  liveAnswer,
  liveRequest,
  responseRequest,
  UpstreamError,
  type OpenAITransport,
} from './openai.js';

export class AiServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
interface LiveReservation {
  providerId?: string;
  pending?: Promise<unknown>;
  closing?: Promise<boolean>;
  closeRequested: boolean;
  attempts: number;
  closed: boolean;
  unknown: boolean;
}
interface PlayBudget {
  deadline: number;
  retired: boolean;
  liveAttempts: number;
  responseAttempts: number;
  responseBusy: number;
  live?: LiveReservation;
}

/** Process-wide reservations. HTTP ownership and replay protection belong to the caller. */
export class AiService {
  private readonly plays = new Map<string, PlayBudget>();
  private readonly transport: OpenAITransport;
  private draining = false;
  private liveAttempts = 0;
  private responseAttempts = 0;
  private liveBusy = 0;
  private responseBusy = 0;
  constructor(
    readonly config: AiConfig,
    transport?: OpenAITransport,
    private readonly now: () => number = () => performance.now(),
  ) {
    if (!transport && (config.mode !== 'live' || !config.apiKey)) {
      throw new Error('Mock mode requires an injected OpenAITransport');
    }
    this.transport = transport ?? createOpenAITransport(config.apiKey!);
  }
  register(playId: string, deadline: number): void {
    if (this.draining) throw new AiServiceError(503, 'DRAINING', '更新準備中です。');
    const existing = this.plays.get(playId);
    if (existing) {
      if (existing.deadline !== deadline || existing.retired)
        throw new AiServiceError(410, 'PLAY_EXPIRED', '体験は終了しています。');
      return;
    }
    if (!Number.isFinite(deadline) || deadline <= this.now())
      throw new AiServiceError(410, 'PLAY_EXPIRED', '体験は終了しています。');
    this.plays.set(playId, {
      deadline,
      retired: false,
      liveAttempts: 0,
      responseAttempts: 0,
      responseBusy: 0,
    });
  }
  private active(playId: string): PlayBudget {
    if (this.draining) throw new AiServiceError(503, 'DRAINING', '更新準備中です。');
    const play = this.plays.get(playId);
    if (!play || play.retired || this.now() >= play.deadline)
      throw new AiServiceError(410, 'PLAY_EXPIRED', '体験は終了しています。');
    return play;
  }
  private limit(): never {
    throw new AiServiceError(429, 'REQUEST_LIMIT', '利用上限または終了確認待ちです。');
  }
  private async bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new UpstreamError(502)), this.config.timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }
  async createLive(playId: string, body: unknown, deadline?: number) {
    if (deadline !== undefined) this.register(playId, deadline);
    const play = this.active(playId);
    const parsed = liveRequest.safeParse(body);
    if (!parsed.success || !this.config.liveModels.includes(parsed.data.session.model))
      throw new AiServiceError(400, 'INVALID_REQUEST', '音声接続の設定を確認してください。');
    if (
      (play.live && !play.live.closed) ||
      play.liveAttempts >= this.config.liveAttemptsPerPlay ||
      this.liveAttempts >= this.config.globalLiveAttempts ||
      this.liveBusy >= this.config.liveConcurrentGlobal
    )
      this.limit();
    const live: LiveReservation = {
      closeRequested: false,
      attempts: 0,
      closed: false,
      unknown: false,
    };
    play.live = live;
    play.liveAttempts++;
    this.liveAttempts++;
    this.liveBusy++;
    // Reserve synchronously before invoking even an injected transport.
    const raw = Promise.resolve()
      .then(() => this.transport.createLiveSession(parsed.data))
      .then((value) => {
        const answer = liveAnswer.parse(value);
        const duplicate = [...this.plays.values()].some(
          (other) => other.live !== live && other.live?.providerId === answer.session.id,
        );
        if (duplicate) throw new UpstreamError(502);
        live.providerId = answer.session.id;
        return answer;
      });
    live.pending = raw;
    void raw
      .then(
        async (value) => {
          const answer = liveAnswer.safeParse(value);
          if (!answer.success) return;
          live.providerId = answer.data.session.id;
          live.unknown = false;
          if (live.closeRequested || play.retired || this.draining || this.now() >= play.deadline)
            await this.closeReservation(live);
        },
        () => {},
      )
      .finally(() => {
        live.pending = undefined;
      });
    try {
      const answer = liveAnswer.parse(await this.bounded(raw));
      live.providerId = answer.session.id;
      if (live.closeRequested || play.retired || this.draining || this.now() >= play.deadline) {
        await this.closeReservation(live);
        throw new AiServiceError(410, 'PLAY_EXPIRED', '体験は終了しています。');
      }
      return answer;
    } catch (error) {
      if (error instanceof AiServiceError) throw error;
      if (!live.providerId) live.unknown = true;
      live.closeRequested = true;
      throw new AiServiceError(
        502,
        'LIVE_CREATE_UNCONFIRMED',
        '音声接続の作成結果を確認できません。運営に確認してください。',
      );
    }
  }
  async respond(playId: string, body: unknown): Promise<unknown> {
    const play = this.active(playId);
    const parsed = responseRequest.safeParse(body);
    if (
      !parsed.success ||
      !this.config.responseModels.includes(parsed.data.model) ||
      parsed.data.max_output_tokens > this.config.outputTokens
    )
      throw new AiServiceError(400, 'INVALID_REQUEST', '認識要求の設定を確認してください。');
    if (
      play.responseBusy >= this.config.responseConcurrentPerPlay ||
      play.responseAttempts >= this.config.responsesPerPlay ||
      this.responseAttempts >= this.config.globalResponseAttempts ||
      this.responseBusy >= this.config.responseConcurrentGlobal
    )
      this.limit();
    play.responseBusy++;
    play.responseAttempts++;
    this.responseBusy++;
    this.responseAttempts++;
    const raw = Promise.resolve().then(() => this.transport.createResponse(parsed.data));
    const release = () => {
      play.responseBusy--;
      this.responseBusy--;
      if (play.retired) this.forget(playId);
    };
    void raw.then(release, release);
    try {
      const value = await this.bounded(raw);
      this.active(playId);
      return value;
    } catch (error) {
      if (error instanceof AiServiceError) throw error;
      throw new AiServiceError(
        error instanceof UpstreamError ? error.status : 502,
        'UPSTREAM_FAILED',
        'AIへの接続に失敗しました。',
      );
    }
  }
  private closeReservation(live: LiveReservation): Promise<boolean> {
    live.closeRequested = true;
    if (live.closed) return Promise.resolve(true);
    if (!live.providerId) return Promise.resolve(false);
    if (live.closing) return live.closing;
    live.closing = (async () => {
      while (live.attempts < 3) {
        live.attempts++;
        try {
          await this.bounded(Promise.resolve().then(() => this.transport.hangup(live.providerId!)));
          live.closed = true;
          this.liveBusy--;
          return true;
        } catch {
          /* An abort or timeout is not a confirmed hangup. */
        }
      }
      return false;
    })();
    return live.closing;
  }
  async closeLive(playId: string): Promise<boolean> {
    const live = this.plays.get(playId)?.live;
    if (!live) return true;
    live.closeRequested = true;
    if (live.pending) {
      try {
        await this.bounded(live.pending);
      } catch {
        /* Retain the reservation. */
      }
    }
    return this.closeReservation(live);
  }
  async retire(playId: string): Promise<boolean> {
    const play = this.plays.get(playId);
    if (play) play.retired = true;
    return this.closeLive(playId);
  }
  /** Caller invokes only after discarding the terminal runtime; never forget an unknown Live. */
  forget(playId: string): boolean {
    const play = this.plays.get(playId);
    if (!play) return true;
    if (!play.retired || play.responseBusy || (play.live && !play.live.closed)) return false;
    return this.plays.delete(playId);
  }
  async shutdown(): Promise<boolean> {
    this.draining = true;
    await Promise.all([...this.plays.keys()].map((id) => this.retire(id)));
    const counts = this.snapshot();
    return counts.liveBusy === 0 && counts.pendingCreates === 0 && counts.responseBusy === 0;
  }
  resume(): boolean {
    const counts = this.snapshot();
    if (counts.liveBusy || counts.pendingCreates || counts.responseBusy) return false;
    this.draining = false;
    return true;
  }
  playSnapshot(playId: string) {
    const play = this.plays.get(playId);
    return play
      ? {
          liveAttempts: play.liveAttempts,
          responseAttempts: play.responseAttempts,
          responseBusy: play.responseBusy,
          unknownCreate: play.live?.unknown ?? false,
          liveBusy: !!play.live && !play.live.closed,
        }
      : undefined;
  }
  snapshot() {
    const live = [...this.plays.values()].flatMap((p) => (p.live ? [p.live] : []));
    return {
      liveBusy: this.liveBusy,
      responseBusy: this.responseBusy,
      liveAttempts: this.liveAttempts,
      responseAttempts: this.responseAttempts,
      pendingCreates: live.filter((l) => l.pending).length,
      unknownCreates: live.filter((l) => l.unknown).length,
      unconfirmedLive: live.filter((l) => !l.closed && l.attempts >= 3).length,
    };
  }
}
