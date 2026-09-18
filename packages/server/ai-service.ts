import type { AiConfig } from './ai-config.js';
import {
  endingImageRequest,
  parseEndingResponseRequest,
  type EndingCallKind,
} from './ending-ai-request.js';
import {
  createOpenAITransport,
  liveAnswer,
  liveRequest,
  responseRequest,
  gameResponseRequest,
  UpstreamError,
  type OpenAITransport,
} from './openai.js';

export class AiServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly upstreamStatus?: number,
  ) {
    super(message);
  }
}
export interface MediaPermit {
  jobId: string;
  ownerPlayId: string;
  cancellationEpoch: number;
  expiresAt: number;
  generationAttempts: number;
  inspectionAttempts: number;
  busy: number;
  cancelled: boolean;
  controllers: Set<AbortController>;
  ending?: {
    extraction: number;
    story: number;
    direction: number;
    start: number;
    end: number;
    inspection: number;
  };
}
interface LiveReservation {
  playId: string;
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
  private readonly media = new Map<string, MediaPermit>();
  private readonly mediaPlayAttempts = new Map<string, number>();
  private readonly mediaPlayLimits = new Map<string, number>();
  private imageAttempts = 0;
  private inspectionAttempts = 0;
  private imageBusy = 0;
  private inspectionBusy = 0;
  private imageStarts: number[] = [];
  private liveAttempts = 0;
  private responseAttempts = 0;
  private liveBusy = 0;
  private responseBusy = 0;
  private gameWaiting = 0;
  constructor(
    readonly config: AiConfig,
    transport?: OpenAITransport,
    private readonly now: () => number = () => performance.now(),
    private readonly gameResponder?: (
      body: unknown,
      signal: AbortSignal | undefined,
      playId: string,
    ) => Promise<unknown>,
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

  registerMedia(
    playId: string,
    jobId: string,
    expiresAt: number,
    sceneActionBudget: number,
  ): MediaPermit {
    this.active(playId);
    if (
      this.media.has(jobId) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= this.now() ||
      expiresAt > this.now() + this.config.imageJobTimeoutMs ||
      !Number.isInteger(sceneActionBudget) ||
      sceneActionBudget < 1 ||
      sceneActionBudget > 100
    )
      throw new AiServiceError(400, 'INVALID_MEDIA_PERMIT', 'Invalid media permit');
    this.mediaPlayLimits.set(
      playId,
      Math.max(this.mediaPlayLimits.get(playId) ?? 0, 2 * (sceneActionBudget + 2)),
    );
    const permit: MediaPermit = {
      jobId,
      ownerPlayId: playId,
      cancellationEpoch: 0,
      expiresAt,
      generationAttempts: 0,
      inspectionAttempts: 0,
      busy: 0,
      cancelled: false,
      controllers: new Set(),
    };
    this.media.set(jobId, permit);
    return permit;
  }
  registerEnding(playId: string, jobId: string, expiresAt: number): MediaPermit {
    this.active(playId);
    if (
      this.media.has(jobId) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= this.now() ||
      expiresAt > this.now() + 540_000 ||
      [...this.media.values()].some((p) => p.ownerPlayId === playId && p.ending)
    )
      throw new AiServiceError(400, 'INVALID_ENDING_PERMIT', 'Invalid ending permit');
    const permit: MediaPermit = {
      jobId,
      ownerPlayId: playId,
      expiresAt,
      cancellationEpoch: 0,
      generationAttempts: 0,
      inspectionAttempts: 0,
      busy: 0,
      cancelled: false,
      controllers: new Set(),
      ending: { extraction: 0, story: 0, direction: 0, start: 0, end: 0, inspection: 0 },
    };
    this.media.set(jobId, permit);
    return permit;
  }
  endingDelay(kind: EndingCallKind): number {
    if (this.draining) return Infinity;
    if (kind === 'frame') return this.mediaDelay('generation');
    if (kind === 'inspection') return this.mediaDelay('inspection');
    return this.responseBusy < this.config.responseConcurrentGlobal ? 0 : 25;
  }
  async endingCall(
    jobId: string,
    epoch: number,
    kind: EndingCallKind,
    body: unknown,
    signal: AbortSignal,
    frame: 'start' | 'end' = 'start',
  ): Promise<unknown> {
    const permit = this.media.get(jobId),
      attempts = permit?.ending;
    if (
      this.draining ||
      !permit ||
      !attempts ||
      permit.cancelled ||
      signal.aborted ||
      permit.cancellationEpoch !== epoch ||
      this.now() >= permit.expiresAt
    )
      throw new AiServiceError(410, 'ENDING_EXPIRED', 'Ending request expired');
    const frameRequest = kind === 'frame' ? endingImageRequest.parse(body) : undefined;
    const response = kind !== 'frame' ? parseEndingResponseRequest(body) : undefined;
    const inspection = kind === 'inspection';
    if (frameRequest) {
      if (frameRequest.model !== this.config.imageModel || !this.transport.createImageEdit)
        throw new AiServiceError(400, 'INVALID_REQUEST', 'Invalid ending image request');
      if (attempts[frame] >= 2 || this.imageAttempts >= this.config.globalImageAttempts)
        this.limit();
    } else {
      if (
        response!.model !==
          (inspection ? this.config.inspectionModel : this.config.responseModel) ||
        (kind === 'extraction' && response!.max_output_tokens > 2048) ||
        (inspection && response!.max_output_tokens > 1000)
      )
        throw new AiServiceError(400, 'INVALID_REQUEST', 'Invalid ending response request');
      if (inspection) {
        // Two frames, two generation attempts each, two inspections per generated image.
        if (
          attempts.inspection >= 8 ||
          this.inspectionAttempts >= this.config.globalInspectionAttempts
        )
          this.limit();
      } else if (
        attempts[kind as 'story' | 'direction' | 'extraction'] >=
          (kind === 'extraction' ? 6 : kind === 'story' ? 2 : 1) ||
        this.responseAttempts >= this.config.globalResponseAttempts
      )
        this.limit();
    }
    if (this.endingDelay(kind) > 0 || permit.busy) this.limit();
    if (kind === 'extraction') {
      // Optional clue work must leave one first writer call for each admitted
      // ending. This check and the attempt charge below are synchronous.
      const waitingStories = [...this.media.values()].filter(
        (candidate) =>
          candidate.ending?.story === 0 && !candidate.cancelled && this.now() < candidate.expiresAt,
      ).length;
      if (this.config.globalResponseAttempts - this.responseAttempts <= waitingStories)
        throw new AiServiceError(
          429,
          'ENDING_EVIDENCE_BUDGET',
          'Response budget reserved for endings',
        );
    }
    const controller = new AbortController();
    permit.controllers.add(controller);
    permit.busy++;
    if (frameRequest) {
      attempts[frame]++;
      permit.generationAttempts++;
      this.imageAttempts++;
      this.imageBusy++;
      this.imageStarts.push(this.now());
    } else if (inspection) {
      attempts.inspection++;
      permit.inspectionAttempts++;
      this.inspectionAttempts++;
      this.inspectionBusy++;
    } else {
      attempts[kind as 'story' | 'direction' | 'extraction']++;
      this.responseAttempts++;
      this.responseBusy++;
    }
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(
        1,
        Math.min(
          kind === 'frame' ? 60_000 : inspection ? 15_000 : 30_000,
          permit.expiresAt - this.now(),
        ),
      ),
    );
    const combined = AbortSignal.any([signal, controller.signal]);
    try {
      const value = await (frameRequest
        ? this.transport.createImageEdit!(frameRequest, combined)
        : this.transport.createResponse(response, combined));
      if (combined.aborted || permit.cancelled || this.now() >= permit.expiresAt)
        throw new AiServiceError(410, 'ENDING_EXPIRED', 'Ending request expired');
      return value;
    } catch (error) {
      // Aborted fetches reject before returning a value, so the check above cannot classify them.
      if (combined.aborted) {
        if (!signal.aborted && !permit.cancelled && this.now() < permit.expiresAt)
          throw new AiServiceError(504, 'ENDING_CALL_TIMEOUT', 'Ending call timed out');
        throw new AiServiceError(410, 'ENDING_EXPIRED', 'Ending request expired');
      }
      throw error;
    } finally {
      clearTimeout(timer);
      permit.controllers.delete(controller);
      permit.busy--;
      if (frameRequest) this.imageBusy--;
      else if (inspection) this.inspectionBusy--;
      else this.responseBusy--;
      if (permit.cancelled && !permit.busy) {
        this.media.delete(jobId);
        if (this.plays.get(permit.ownerPlayId)?.retired) this.forget(permit.ownerPlayId);
      }
    }
  }
  cancelMedia(jobId: string): void {
    const permit = this.media.get(jobId);
    if (!permit) return;
    permit.cancelled = true;
    permit.cancellationEpoch++;
    for (const controller of permit.controllers) controller.abort();
    if (!permit.busy) {
      this.media.delete(jobId);
      if (this.plays.get(permit.ownerPlayId)?.retired) this.forget(permit.ownerPlayId);
    }
  }
  releaseMedia(jobId: string): void {
    this.cancelMedia(jobId);
  }
  mediaDelay(kind: 'generation' | 'inspection'): number {
    if (this.draining) return Infinity;
    if (kind === 'inspection')
      return this.inspectionBusy < this.config.inspectionConcurrent ? 0 : 25;
    if (this.imageBusy >= this.config.imageConcurrent) return 25;
    this.imageStarts = this.imageStarts.filter((time) => time > this.now() - 60000);
    return this.imageStarts.length < this.config.imageRequestsPerMinute
      ? 0
      : Math.max(1, this.imageStarts[0]! + 60000 - this.now());
  }
  async mediaCall(
    jobId: string,
    epoch: number,
    kind: 'generation' | 'inspection',
    body: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const permit = this.media.get(jobId);
    if (
      this.draining ||
      !permit ||
      !!permit.ending ||
      permit.cancelled ||
      permit.cancellationEpoch !== epoch ||
      this.now() >= permit.expiresAt
    )
      throw new AiServiceError(410, 'MEDIA_EXPIRED', 'Image request expired');
    if (kind === 'generation') {
      const b = body as Record<string, unknown>;
      if (
        b.model !== this.config.imageModel ||
        b.n !== 1 ||
        b.size !== '1024x1024' ||
        b.quality !== 'low' ||
        b.output_format !== 'jpeg' ||
        typeof b.prompt !== 'string' ||
        b.prompt.length > 16000 ||
        Object.keys(b).some(
          (key) => !['model', 'n', 'size', 'quality', 'output_format', 'prompt'].includes(key),
        )
      )
        throw new AiServiceError(400, 'INVALID_REQUEST', 'Invalid image request');
      if (
        !this.transport.createImage ||
        permit.generationAttempts >= 2 ||
        this.imageAttempts >= this.config.globalImageAttempts ||
        (this.mediaPlayAttempts.get(permit.ownerPlayId) ?? 0) >=
          (this.mediaPlayLimits.get(permit.ownerPlayId) ?? 0)
      )
        this.limit();
    } else {
      const parsed = responseRequest.safeParse(body);
      if (
        !parsed.success ||
        parsed.data.model !== this.config.inspectionModel ||
        parsed.data.input.flatMap((i) => i.content).filter((i) => i.type === 'input_image')
          .length !== 1 ||
        parsed.data.input
          .flatMap((i) => i.content)
          .some(
            (i) =>
              i.type === 'input_image' &&
              Buffer.byteLength(i.image_url.slice(23), 'base64') > 1024 * 1024,
          )
      )
        throw new AiServiceError(400, 'INVALID_REQUEST', 'Invalid inspection request');
      if (
        permit.inspectionAttempts >= 4 ||
        this.inspectionAttempts >= this.config.globalInspectionAttempts
      )
        this.limit();
    }
    if (this.mediaDelay(kind) > 0) this.limit();
    const controller = new AbortController();
    permit.controllers.add(controller);
    permit.busy++;
    if (kind === 'generation') {
      permit.generationAttempts++;
      this.imageAttempts++;
      this.imageBusy++;
      this.imageStarts.push(this.now());
      this.mediaPlayAttempts.set(
        permit.ownerPlayId,
        (this.mediaPlayAttempts.get(permit.ownerPlayId) ?? 0) + 1,
      );
    } else {
      permit.inspectionAttempts++;
      this.inspectionAttempts++;
      this.inspectionBusy++;
    }
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1, Math.min(timeoutMs, permit.expiresAt - this.now())),
    );
    // Await transport settlement, including abort/read cancellation, before releasing a concurrency slot.
    try {
      const value = await (kind === 'generation'
        ? this.transport.createImage!(body, controller.signal)
        : this.transport.createResponse(body, controller.signal));
      if (
        controller.signal.aborted ||
        permit.cancelled ||
        permit.cancellationEpoch !== epoch ||
        this.now() >= permit.expiresAt
      )
        throw new AiServiceError(410, 'MEDIA_EXPIRED', 'Image request expired');
      return value;
    } catch (error) {
      if (controller.signal.aborted) {
        if (
          !permit.cancelled &&
          permit.cancellationEpoch === epoch &&
          this.now() < permit.expiresAt
        )
          throw new AiServiceError(504, 'MEDIA_CALL_TIMEOUT', 'Image call timed out');
        throw new AiServiceError(410, 'MEDIA_EXPIRED', 'Image request expired');
      }
      throw error;
    } finally {
      clearTimeout(timer);
      permit.controllers.delete(controller);
      permit.busy--;
      if (kind === 'generation') this.imageBusy--;
      else this.inspectionBusy--;
      if (permit.cancelled && !permit.busy) {
        this.media.delete(jobId);
        if (this.plays.get(permit.ownerPlayId)?.retired) this.forget(permit.ownerPlayId);
      }
    }
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
  private async bounded<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    let abort: (() => void) | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new UpstreamError(502)), this.config.timeoutMs);
      if (signal) {
        abort = () =>
          reject(new AiServiceError(409, 'CONTROL_CANCELLED', '制御の確認を中止しました。'));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer!);
      if (abort) signal?.removeEventListener('abort', abort);
    }
  }
  async createLive(playId: string, body: unknown, deadline?: number) {
    if (deadline !== undefined) this.register(playId, deadline);
    const play = this.active(playId);
    const parsed = liveRequest.safeParse(body);
    if (!parsed.success || !this.config.liveModels.includes(parsed.data.session.model))
      throw new AiServiceError(400, 'INVALID_REQUEST', '音声接続の設定を確認してください。');
    for (const budget of this.plays.values())
      if (budget.live) this.reconcileLiveClosure(budget.live);
    if (
      (play.live && !play.live.closed) ||
      play.liveAttempts >= this.config.liveAttemptsPerPlay ||
      this.liveAttempts >= this.config.globalLiveAttempts ||
      this.liveBusy >= this.config.liveConcurrentGlobal
    )
      this.limit();
    const live: LiveReservation = {
      playId,
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
  respond(playId: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.respondInLane(playId, body, signal);
  }

  /** Server-owned game calls only; never selected by an HTTP request field. */
  respondGame(playId: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.respondInLane(playId, body, signal, true);
  }

  private async respondInLane(
    playId: string,
    body: unknown,
    signal?: AbortSignal,
    game = false,
  ): Promise<unknown> {
    if (signal?.aborted)
      throw new AiServiceError(409, 'CONTROL_CANCELLED', '制御の確認を中止しました。');
    const play = this.active(playId);
    const parsed = (game ? gameResponseRequest : responseRequest).safeParse(body);
    if (
      !parsed.success ||
      !this.config.responseModels.includes(parsed.data.model) ||
      (!game && parsed.data.max_output_tokens > this.config.outputTokens) ||
      (game && parsed.data.model !== this.config.gameModel)
    )
      throw new AiServiceError(400, 'INVALID_REQUEST', '認識要求の設定を確認してください。');
    // Concurrent players can briefly occupy all slots. Waiting is not a new
    // provider attempt, and must never bypass a spent request budget.
    if (
      game &&
      (play.responseBusy >= this.config.responseConcurrentPerPlay ||
        this.responseBusy >= this.config.responseConcurrentGlobal)
    ) {
      if (this.gameWaiting >= 20) this.limit();
      this.gameWaiting++;
      const deadline = performance.now() + 5000;
      try {
        while (
          play.responseBusy >= this.config.responseConcurrentPerPlay ||
          this.responseBusy >= this.config.responseConcurrentGlobal
        ) {
          this.active(playId);
          if (signal?.aborted)
            throw new AiServiceError(409, 'CONTROL_CANCELLED', '処理を中止しました。');
          if (
            play.responseAttempts >= this.config.responsesPerPlay ||
            this.responseAttempts >= this.config.globalResponseAttempts ||
            performance.now() >= deadline
          )
            this.limit();
          await new Promise<void>((resolve) => setTimeout(resolve, 25));
        }
        this.active(playId);
        if (signal?.aborted)
          throw new AiServiceError(409, 'CONTROL_CANCELLED', '処理を中止しました。');
      } finally {
        this.gameWaiting--;
      }
    }
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
    const controller = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const request = game
      ? {
          ...parsed.data,
          max_output_tokens: Math.min(parsed.data.max_output_tokens, this.config.gameOutputTokens),
        }
      : parsed.data;
    const raw = Promise.resolve().then(() => {
      if (signal?.aborted)
        throw new AiServiceError(409, 'CONTROL_CANCELLED', '制御の確認を中止しました。');
      return game && this.gameResponder
        ? this.gameResponder(request, requestSignal, playId)
        : this.transport.createResponse(request, requestSignal);
    });
    const release = () => {
      play.responseBusy--;
      this.responseBusy--;
      if (play.retired) this.forget(playId);
    };
    void raw.then(release, release);
    try {
      const value = await this.bounded(raw, signal);
      this.active(playId);
      return value;
    } catch (error) {
      if (error instanceof AiServiceError) throw error;
      throw new AiServiceError(
        error instanceof UpstreamError ? error.status : 502,
        'UPSTREAM_FAILED',
        'AIへの接続に失敗しました。',
        error instanceof UpstreamError ? error.upstreamStatus : undefined,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  private closeReservation(live: LiveReservation): Promise<boolean> {
    live.closeRequested = true;
    this.reconcileLiveClosure(live);
    if (live.closed) return Promise.resolve(true);
    if (!live.providerId) return Promise.resolve(false);
    if (live.closing) return live.closing;
    live.closing = (async () => {
      while (!live.closed && live.attempts < 3) {
        live.attempts++;
        const raw = Promise.resolve().then(() => this.transport.hangup(live.providerId!));
        void raw.then(
          () => this.confirmLiveClosed(live),
          () => {},
        );
        try {
          await this.bounded(raw);
          this.confirmLiveClosed(live);
          return true;
        } catch {
          /* An abort or timeout is not a confirmed hangup. */
        }
      }
      return live.closed;
    })();
    return live.closing;
  }
  private confirmLiveClosed(live: LiveReservation): void {
    if (live.closed) return;
    live.closed = true;
    this.liveBusy--;
    if (live.providerId) this.transport.releaseClosedLiveSession?.(live.providerId);
    if (this.plays.get(live.playId)?.retired) this.forget(live.playId);
  }
  private reconcileLiveClosure(live: LiveReservation): void {
    if (!live.closed && live.providerId && this.transport.isLiveSessionClosed?.(live.providerId))
      this.confirmLiveClosed(live);
  }
  /** True only when this play has no Live reservation or its provider close was confirmed. */
  isLiveCloseConfirmed(playId: string): boolean {
    const live = this.plays.get(playId)?.live;
    if (live) this.reconcileLiveClosure(live);
    return !live || live.closed;
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
    if (
      !play.retired ||
      play.responseBusy ||
      (play.live && !play.live.closed) ||
      [...this.media.values()].some((p) => p.ownerPlayId === playId)
    )
      return false;
    this.mediaPlayAttempts.delete(playId);
    this.mediaPlayLimits.delete(playId);
    return this.plays.delete(playId);
  }
  async shutdown(): Promise<boolean> {
    this.draining = true;
    for (const id of this.media.keys()) this.cancelMedia(id);
    await Promise.all([...this.plays.keys()].map((id) => this.retire(id)));
    const counts = this.snapshot();
    return (
      counts.liveBusy === 0 &&
      counts.pendingCreates === 0 &&
      counts.responseBusy === 0 &&
      counts.mediaBusy === 0
    );
  }
  resume(): boolean {
    const counts = this.snapshot();
    if (counts.liveBusy || counts.pendingCreates || counts.responseBusy || counts.mediaBusy)
      return false;
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
    for (const reservation of live) this.reconcileLiveClosure(reservation);
    return {
      mediaBusy: this.imageBusy + this.inspectionBusy,
      imageBusy: this.imageBusy,
      inspectionBusy: this.inspectionBusy,
      imageAttempts: this.imageAttempts,
      inspectionAttempts: this.inspectionAttempts,
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
