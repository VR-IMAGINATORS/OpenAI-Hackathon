import { createHash, randomUUID } from 'node:crypto';
import type { AiService } from '../../packages/server/ai-service.js';
import type { EndingConfig } from '../../packages/server/ending-config.js';
import {
  createFalTransport,
  FalSubmitError,
  FalTransportError,
  type FalRequestHandle,
  type FalTransport,
} from '../../packages/server/fal.js';
import {
  EndingVideoMediaError,
  validateEndingMp4,
} from '../../packages/server/ending-video-media.js';
import { createEndingFrames } from '../../packages/server/ending-image-service.js';
import { canUseAftermathDirection } from '../../packages/server/ai-recovery.js';
import { aftermathDirection } from '../local-server/ending-fallback.js';
import {
  abortableDelay,
  createEndingDesign,
  createEndingText,
  type EndingNarrative,
  type EndingReference,
} from '../local-server/ending-ai.js';
import type { EndingPacket } from '../local-server/ending.js';
import { publicEndingStory } from '../local-server/ending-tags.js';
import type { EndingStory, EndingVideoStatus } from '../../packages/shared/ending.js';
import { ResultStore } from './result-store.js';
import {
  endingFailureCode,
  endingValidationFields,
  endingSourceCounts,
  type EndingFailureContext,
  type EndingStage,
} from './ending-failure.js';

export interface PreparedEnding {
  start: Buffer;
  end: Buffer;
  prompt: string;
}
function retryableVideoRead(error: unknown): boolean {
  return (
    error instanceof EndingVideoMediaError ||
    (error instanceof FalTransportError &&
      !error.terminal &&
      ![
        'FAL_INVALID_URL',
        'FAL_REDIRECT_REJECTED',
        'FAL_RESPONSE_TOO_LARGE',
        'FAL_CONFIG_INVALID',
      ].includes(error.code))
  );
}
interface Job {
  id: string;
  playId: string;
  deadline: number;
  packet: EndingPacket;
  seal: () => EndingPacket;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  running?: Promise<void>;
  submitted: boolean;
  upstreamPending: boolean;
  handle?: FalRequestHandle;
  inputHash?: string;
  stage: EndingStage;
  scene: EndingReference | null;
  referenceWait?: Promise<EndingReference | null>;
  before: EndingReference[];
  video: boolean;
  storyReady: boolean;
  storyErrorCode?: string;
  phase: 'text' | 'video';
  narrative?: EndingNarrative;
  sealedPacket?: EndingPacket;
}
interface UnconfirmedRequest {
  handle?: FalRequestHandle;
  checking: boolean;
}
export interface EndingJobsOptions {
  now?: () => number;
  fal?: FalTransport;
  graceMs?: number;
  pollMs?: number;
  storyTimeoutMs?: number;
  evidenceTimeoutMs?: number;
  retryDelayMs?: number;
  referenceWaitMs?: number;
  onRecovery?: (playId: string, stage: EndingStage, errorCode: string) => void;
  prepare?: (
    jobId: string,
    packet: EndingPacket,
    signal: AbortSignal,
    publishedStory: EndingStory | null,
  ) => Promise<PreparedEnding>;
  onFailure?: (
    playId: string,
    stage: EndingStage | 'admission',
    errorCode: string,
    context?: EndingFailureContext,
  ) => void;
}

/** One job per retained result. Unconfirmed submissions retain capacity after local cancellation. */
export class EndingJobs {
  private readonly jobs = new Map<string, Job>();
  private readonly unknown = new Map<string, UnconfirmedRequest>();
  private readonly fal?: FalTransport;
  private submitted = 0;
  private reserved = 0;
  private stopped = false;
  private disposed = false;
  private monitor?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly ai: AiService,
    private readonly config: EndingConfig,
    private readonly results: ResultStore,
    private readonly options: EndingJobsOptions = {},
  ) {
    if (config.enabled && ai.config.mode === 'live' && ai.config.provider !== 'codex')
      this.fal = options.fal ?? createFalTransport(config.apiKey!);
  }
  private now() {
    return this.options.now?.() ?? performance.now();
  }
  private update(playId: string, patch: Parameters<ResultStore['updateEnding']>[1]) {
    try {
      this.results.updateEnding(playId, patch);
    } catch {
      /* Result eviction cancels separately. */
    }
  }
  private reportFailure(
    playId: string,
    stage: EndingStage | 'admission',
    errorCode: string,
    error?: unknown,
  ) {
    try {
      const job = this.jobs.get(playId);
      const packet = job?.sealedPacket ?? job?.packet;
      this.options.onFailure?.(
        playId,
        stage,
        errorCode,
        packet
          ? {
              clearedCount: packet.clearedIds.length,
              actionCount: packet.actions.length,
              failedActionCount: packet.actions.filter((action) => !action.success).length,
              durationMs: Math.max(0, this.now() - packet.endedAt),
              remainingMs: Math.max(0, job!.deadline - this.now()),
              evidenceRecordCount: packet.evidence.records.length,
              evidenceBytes: Buffer.byteLength(JSON.stringify(packet.evidence.records)),
              validationFields: endingValidationFields(error),
              ...endingSourceCounts(error),
            }
          : undefined,
      );
    } catch {
      /* Diagnostics cannot interrupt cleanup. */
    }
  }
  private reportRecovery(job: Job, error: unknown): void {
    try {
      this.options.onRecovery?.(job.playId, job.stage, endingFailureCode(error, job.stage));
    } catch {
      /* Diagnostics cannot interrupt recovery. */
    }
  }
  private async readVideo<T>(job: Job, read: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      this.assertCurrent(job);
      try {
        return await read();
      } catch (error) {
        this.assertCurrent(job);
        if (!retryableVideoRead(error) || attempt >= 2) throw error;
        this.reportRecovery(job, error);
        await abortableDelay(
          (this.options.retryDelayMs ?? 1000) * 2 ** attempt,
          job.controller.signal,
        );
      }
    }
  }
  enqueue(packet: EndingPacket, seal: () => EndingPacket): void {
    const enabled = !!this.fal;
    const writeStory =
      packet.outcome !== null &&
      this.ai.config.mode === 'live' &&
      this.ai.config.provider !== 'codex';
    const status: EndingVideoStatus =
      packet.outcome === null ? 'not_applicable' : enabled ? 'queued' : 'disabled';
    if (
      !this.results.initializeEnding(packet.playId, {
        playId: packet.playId,
        outcome: packet.outcome,
        clearedCount: packet.clearedIds.length,
        status,
        errorCode: null,
        storyErrorCode: null,
        retainUntil: null,
        videoPath: null,
        story: null,
        storyStatus:
          packet.outcome === null ? 'not_applicable' : writeStory ? 'queued' : 'disabled',
      })
    )
      return;
    if (!writeStory) return;
    const failed = (errorCode: string) => {
      this.update(packet.playId, {
        status: enabled ? 'failed' : status,
        storyStatus: 'failed',
        storyErrorCode: errorCode,
        errorCode,
      });
      this.reportFailure(packet.playId, 'admission', errorCode);
    };
    if (this.stopped) return failed('ENDING_DRAINING');
    const video = enabled && this.submitted + this.reserved < this.config.globalAttempts;
    if (enabled && !video) {
      this.update(packet.playId, { status: 'failed', errorCode: 'ENDING_BUDGET_EXHAUSTED' });
      this.reportFailure(packet.playId, 'admission', 'ENDING_BUDGET_EXHAUSTED');
    }
    if ([...this.jobs.values()].filter((j) => !j.running).length >= 10)
      return failed('ENDING_QUEUE_FULL');
    const id = randomUUID(),
      deadline =
        packet.endedAt + (video ? this.config.timeoutMs : Math.min(120_000, this.config.timeoutMs));
    try {
      this.ai.registerEnding(packet.playId, id, deadline);
    } catch {
      return failed('ENDING_UNAVAILABLE');
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => this.cancelPlay(packet.playId, 'ENDING_TIMEOUT'),
      Math.max(1, deadline - this.now()),
    );
    timer.unref?.();
    // Freeze visual inputs at game end, before the transcript grace period or queue wait.
    const ready = video ? this.results.readySceneReferences(packet.playId, packet.gameVersion) : [];
    const beforeVersions = new Set(packet.actions.map((action) => action.beforeVersion));
    const before = ready
      .filter((reference) => {
        if (!beforeVersions.delete(reference.gameVersion)) return false;
        return true;
      })
      .sort((a, b) => a.gameVersion - b.gameVersion);
    if (video) this.reserved++;
    const job: Job = {
      id,
      playId: packet.playId,
      packet,
      seal,
      deadline,
      controller,
      timer,
      submitted: false,
      upstreamPending: false,
      stage: 'reference',
      scene: ready[0] ?? null,
      before,
      video,
      storyReady: false,
      phase: 'text',
    };
    this.jobs.set(packet.playId, job);
    if (video && !job.scene && !this.options.prepare) {
      // Wait alongside the story, starting at game end; queueing must not restart this window.
      job.referenceWait = this.waitForReference(job).catch(() => null);
    }
    // Defer until runtime has emitted its final scene and stored the ended result.
    queueMicrotask(() => this.pump());
  }
  private occupancy() {
    return [...this.jobs.values()].filter((j) => !!j.running).length + this.unknown.size;
  }
  private pump(): void {
    if (this.stopped) return;
    for (const job of this.jobs.values()) {
      if (job.running) continue;
      const running = [...this.jobs.values()].filter(
        (other) => !!other.running && other.phase === job.phase,
      ).length;
      // A slow or unconfirmed video must not prevent text-only results from being written.
      if (running + (job.phase === 'video' ? this.unknown.size : 0) >= this.config.concurrent)
        continue;
      // Set the marker synchronously before invoking any producer callbacks.
      job.running = Promise.resolve().then(() =>
        job.phase === 'text' ? this.runStory(job) : this.run(job),
      );
    }
  }
  private assertCurrent(job: Job): void {
    job.controller.signal.throwIfAborted();
    if (this.now() >= job.deadline) {
      // The monotonic deadline can pass before the timer callback gets CPU time.
      job.controller.abort('ENDING_TIMEOUT');
      job.controller.signal.throwIfAborted();
    }
    if (this.stopped || !this.results.has(job.playId)) throw new Error('ENDING_EXPIRED');
  }
  private publishStory(job: Job, story: EndingStory): void {
    this.assertCurrent(job);
    this.results.updateEnding(job.playId, { story, storyStatus: 'ready' });
    job.storyReady = true;
  }
  private async waitForReference(job: Job): Promise<EndingReference | null> {
    const deadline = new AbortController();
    const waitMs = this.options.referenceWaitMs ?? 30_000;
    const duration = Math.max(
      0,
      Math.min(job.packet.endedAt + waitMs - this.now(), job.deadline - this.now()),
    );
    const timer = setTimeout(() => deadline.abort(), duration);
    const signal = AbortSignal.any([job.controller.signal, deadline.signal]);
    try {
      // The last committed action emits its scene just after the terminal callback.
      await abortableDelay(1, signal);
      for (;;) {
        this.assertCurrent(job);
        const scene = this.results.readySceneReferences(job.playId, job.packet.gameVersion)[0];
        if (scene) return scene;
        if (!this.results.hasPendingScene(job.playId, job.packet.gameVersion)) return null;
        await abortableDelay(Math.min(100, Math.max(1, duration / 10)), signal);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  private async prepare(job: Job, packet: EndingPacket): Promise<PreparedEnding> {
    const signal = job.controller.signal;
    const narrative = job.narrative;
    job.stage = 'direction';
    if (this.options.prepare && job.video)
      return this.options.prepare(
        job.id,
        packet,
        signal,
        narrative ? publicEndingStory(narrative) : null,
      );
    job.stage = 'reference';
    const scene = job.scene ?? (await job.referenceWait);
    this.assertCurrent(job);
    if (scene) job.scene = scene;
    if (!scene) {
      job.stage = 'reference';
      throw new Error('ENDING_REFERENCE_MISSING');
    }
    const availableBefore = job.before;
    job.stage = 'direction';
    let design;
    try {
      design = await createEndingDesign(
        this.ai,
        job.id,
        packet,
        scene,
        availableBefore[0],
        signal,
        narrative,
        availableBefore,
      );
    } catch (error) {
      this.assertCurrent(job);
      if (!canUseAftermathDirection(error)) throw error;
      this.reportRecovery(job, error);
      design = aftermathDirection(packet);
    }
    const selected = packet.actions.find((action) => action.actionId === design.usedActionIds[0]);
    const before = availableBefore.find(
      (reference) => reference.gameVersion === selected?.beforeVersion,
    );
    const frames = await createEndingFrames(
      this.ai,
      job.id,
      packet,
      design,
      scene,
      before,
      signal,
      (stage) => {
        job.stage = stage;
      },
      {
        retryDelayMs: this.options.retryDelayMs,
        onRecovery: (error) => this.reportRecovery(job, error),
      },
    );
    return {
      ...frames,
      prompt: design.videoPrompt,
    };
  }
  private async runStory(job: Job): Promise<void> {
    try {
      this.assertCurrent(job);
      job.stage = 'story';
      this.update(job.playId, { storyStatus: 'generating' });
      const graceUntil = job.packet.endedAt + (this.options.graceMs ?? 12_000);
      if (this.now() < graceUntil)
        await abortableDelay(graceUntil - this.now(), job.controller.signal);
      this.assertCurrent(job);
      const packet = job.seal();
      job.sealedPacket = packet;
      // A text-only timeout must leave time and a live permit for video work.
      const textDeadline = AbortSignal.timeout(this.options.storyTimeoutMs ?? 60_000);
      try {
        const narrative = await createEndingText(
          this.ai,
          job.id,
          packet,
          AbortSignal.any([job.controller.signal, textDeadline]),
          (error) =>
            this.reportFailure(job.playId, 'story_retry', endingFailureCode(error, 'story'), error),
          {
            evidenceTimeoutMs: this.options.evidenceTimeoutMs,
            onEvidenceFallback: (error) =>
              this.reportFailure(
                job.playId,
                'extraction',
                endingFailureCode(error, 'extraction'),
                error,
              ),
          },
        );
        textDeadline.throwIfAborted();
        this.publishStory(job, publicEndingStory(narrative));
        job.narrative = narrative;
      } catch (error) {
        this.assertCurrent(job);
        const errorCode = textDeadline.aborted
          ? 'ENDING_STORY_TIMEOUT'
          : endingFailureCode(error, 'story');
        job.storyErrorCode = errorCode;
        this.update(job.playId, { storyStatus: 'failed', storyErrorCode: errorCode });
        this.reportFailure(job.playId, 'story', errorCode, error);
      }
      this.assertCurrent(job);
      if (job.video) {
        job.phase = 'video';
      }
    } catch (error) {
      this.failJob(job, error);
    } finally {
      if (job.phase === 'video') {
        job.running = undefined;
        this.pump();
      } else {
        this.finish(job);
      }
    }
  }
  private async run(job: Job): Promise<void> {
    const signal = job.controller.signal;
    try {
      this.assertCurrent(job);
      this.update(job.playId, {
        status: 'preparing',
      });
      const packet = job.sealedPacket!;
      const prepared = await this.prepare(job, packet);
      this.assertCurrent(job);
      // Reserve before download and before incurring a video charge.
      job.stage = 'storage';
      this.results.reserveVideo(job.playId);
      job.inputHash = createHash('sha256')
        .update(prepared.prompt)
        .update(prepared.start)
        .update(prepared.end)
        .digest('hex');
      this.reserved--;
      this.submitted++;
      job.submitted = true;
      job.upstreamPending = true;
      this.update(job.playId, { status: 'generating' });
      job.stage = 'video_submit';
      try {
        job.handle = await this.fal!.submit(
          {
            prompt: prepared.prompt,
            startImageDataUrl: 'data:image/jpeg;base64,' + prepared.start.toString('base64'),
            endImageDataUrl: 'data:image/jpeg;base64,' + prepared.end.toString('base64'),
          },
          signal,
        );
      } catch (error) {
        if (error instanceof FalSubmitError) {
          job.handle = error.requestHandle;
          if (error.acceptance === 'rejected') job.upstreamPending = false;
        }
        if (!(error instanceof FalSubmitError) || error.acceptance !== 'unknown' || !job.handle)
          throw error;
        // The paid request already has an ID. Recover that exact request without resubmitting.
        this.assertCurrent(job);
        this.reportRecovery(job, error);
      }
      let polls = 0,
        pollDelay = this.options.pollMs ?? 2000;
      job.stage = 'video_status';
      for (;;) {
        this.assertCurrent(job);
        if (++polls > 240) throw new Error('ENDING_POLL_LIMIT');
        try {
          if ((await this.fal!.status(job.handle, signal)) === 'COMPLETED') {
            job.upstreamPending = false;
            break;
          }
          pollDelay = this.options.pollMs ?? 2000;
        } catch (error) {
          if (error instanceof FalTransportError && error.terminal) {
            job.upstreamPending = false;
            throw error;
          }
          if (!retryableVideoRead(error)) throw error;
          // Status GET may be retried; the paid submission is never retried.
          signal.throwIfAborted();
          pollDelay = Math.min(8000, pollDelay * 2);
        }
        await abortableDelay(pollDelay, signal);
      }
      this.assertCurrent(job);
      job.stage = 'video_result';
      const result = await this.readVideo(job, () => this.fal!.result(job.handle!, signal));
      const bytes = await this.readVideo(job, async () => {
        job.stage = 'video_download';
        const downloaded = await this.fal!.downloadVideo(result.videoUrl, signal);
        job.stage = 'video_validation';
        validateEndingMp4(downloaded);
        return downloaded;
      });
      this.assertCurrent(job);
      job.stage = 'storage';
      this.results.putVideo(job.playId, bytes);
      this.update(job.playId, {
        status: 'ready',
        errorCode: null,
        videoPath: '/api/play/ending/video?playId=' + encodeURIComponent(job.playId),
      });
    } catch (error) {
      this.failJob(job, error);
    } finally {
      this.finish(job);
    }
  }
  private failJob(job: Job, error: unknown): void {
    const signal = job.controller.signal;
    const cancelled = new Set([
      'ENDING_TIMEOUT',
      'ENDING_CANCELLED',
      'ENDING_DRAINING',
      'ENDING_RESULT_EXPIRED',
    ]);
    const errorCode = signal.aborted
      ? typeof signal.reason === 'string' && cancelled.has(signal.reason)
        ? signal.reason
        : 'ENDING_CANCELLED'
      : endingFailureCode(error, job.stage);
    this.update(job.playId, {
      ...(job.video
        ? {
            status: signal.reason === 'ENDING_TIMEOUT' ? ('expired' as const) : ('failed' as const),
          }
        : {}),
      storyStatus: job.storyReady ? 'ready' : 'failed',
      ...(!job.storyReady ? { storyErrorCode: job.storyErrorCode ?? errorCode } : {}),
      errorCode,
      videoPath: null,
    });
    this.reportFailure(job.playId, job.stage, errorCode, error);
  }
  private finish(job: Job): void {
    clearTimeout(job.timer);
    job.controller.abort('ENDING_CANCELLED');
    this.ai.releaseMedia(job.id);
    this.results.releaseVideoReservation(job.playId);
    if (job.video && !job.submitted) this.reserved--;
    if (job.upstreamPending) {
      this.unknown.set(job.id, { handle: job.handle, checking: false });
      void this.checkUnknown(job.id);
    }
    this.jobs.delete(job.playId);
    this.pump();
  }
  cancelPlay(playId: string, reason = 'ENDING_RESULT_EXPIRED'): void {
    const job = this.jobs.get(playId);
    if (!job) return;
    job.controller.abort(reason);
    this.ai.cancelMedia(job.id);
    this.update(playId, {
      ...(job.video
        ? { status: reason === 'ENDING_TIMEOUT' ? ('expired' as const) : ('failed' as const) }
        : {}),
      storyStatus: job.storyReady ? 'ready' : 'failed',
      ...(!job.storyReady ? { storyErrorCode: job.storyErrorCode ?? reason } : {}),
      errorCode: reason,
      videoPath: null,
    });
    if (!job.running) {
      clearTimeout(job.timer);
      if (job.video) this.reserved--;
      this.ai.releaseMedia(job.id);
      this.jobs.delete(playId);
      this.pump();
    }
  }
  /** 202 cancellation is not a stop confirmation. Keep unresolved requests visible to drain. */
  private async checkUnknown(id: string): Promise<void> {
    const request = this.unknown.get(id);
    if (!request?.handle || request.checking) return;
    request.checking = true;
    try {
      let stopped = false;
      try {
        stopped = (await this.fal!.cancel(request.handle)).stopConfirmed;
      } catch {
        /* Status can still positively confirm completion after cancellation fails. */
      }
      if (!stopped) {
        try {
          stopped = (await this.fal!.status(request.handle)) === 'COMPLETED';
        } catch (error) {
          if (error instanceof FalTransportError && error.terminal) stopped = true;
        }
      }
      if (stopped) this.unknown.delete(id);
    } catch {
      /* Ambiguous failures retain the reservation. */
    } finally {
      request.checking = false;
      this.scheduleMonitor();
      this.pump();
    }
  }
  private scheduleMonitor(): void {
    if (this.disposed || this.monitor || ![...this.unknown.values()].some((r) => !!r.handle))
      return;
    this.monitor = setTimeout(() => {
      this.monitor = undefined;
      for (const id of this.unknown.keys()) void this.checkUnknown(id);
    }, 5000);
    this.monitor.unref?.();
  }
  tick(): void {
    for (const job of this.jobs.values())
      if (this.now() >= job.deadline) this.cancelPlay(job.playId, 'ENDING_TIMEOUT');
  }
  snapshot() {
    return {
      remaining: this.jobs.size + this.unknown.size,
      active: this.occupancy(),
      queued: [...this.jobs.values()].filter((j) => !j.running).length,
      submitted: this.submitted,
      reserved: this.reserved,
      unconfirmed: this.unknown.size,
    };
  }
  async drain(): Promise<void> {
    this.stopped = true;
    for (const id of this.jobs.keys()) this.cancelPlay(id, 'ENDING_DRAINING');
    await Promise.all([...this.jobs.values()].map((j) => j.running));
  }
  resume(): void {
    if (!this.snapshot().remaining) {
      this.stopped = false;
      this.pump();
    }
  }
  dispose(): void {
    this.disposed = true;
    if (this.monitor) clearTimeout(this.monitor);
    this.monitor = undefined;
  }
}
