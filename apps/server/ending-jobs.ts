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
import { validateEndingMp4 } from '../../packages/server/ending-video-media.js';
import { createEndingFrames } from '../../packages/server/ending-image-service.js';
import {
  abortableDelay,
  createEndingDesign,
  createEndingText,
  type EndingReference,
} from '../local-server/ending-ai.js';
import type { EndingPacket } from '../local-server/ending.js';
import { publicEndingStory } from '../local-server/ending-tags.js';
import type { EndingStory, EndingVideoStatus } from '../../packages/shared/ending.js';
import { ResultStore } from './result-store.js';
import { endingFailureCode, type EndingStage } from './ending-failure.js';

export interface PreparedEnding {
  start: Buffer;
  end: Buffer;
  prompt: string;
  story: EndingStory;
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
  before: EndingReference[];
  video: boolean;
  storyReady: boolean;
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
  prepare?: (
    jobId: string,
    packet: EndingPacket,
    signal: AbortSignal,
    publishStory: (story: EndingStory) => void,
  ) => Promise<PreparedEnding>;
  onFailure?: (playId: string, stage: EndingStage | 'admission', errorCode: string) => void;
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
    if (config.enabled && ai.config.mode === 'live')
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
  private reportFailure(playId: string, stage: EndingStage | 'admission', errorCode: string) {
    try {
      this.options.onFailure?.(playId, stage, errorCode);
    } catch {
      /* Diagnostics cannot interrupt cleanup. */
    }
  }
  enqueue(packet: EndingPacket, seal: () => EndingPacket): void {
    const enabled = !!this.fal;
    const writeStory = packet.outcome !== null && this.ai.config.mode === 'live';
    const status: EndingVideoStatus =
      packet.outcome === null ? 'not_applicable' : enabled ? 'queued' : 'disabled';
    if (
      !this.results.initializeEnding(packet.playId, {
        playId: packet.playId,
        outcome: packet.outcome,
        clearedCount: packet.clearedIds.length,
        status,
        errorCode: null,
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
    const before = packet.actions.slice(-2).flatMap((action) => {
      const reference = ready.find((r) => r.gameVersion === action.beforeVersion);
      return reference ? [reference] : [];
    });
    if (video) this.reserved++;
    this.jobs.set(packet.playId, {
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
    });
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
        (other) => !!other.running && other.video === job.video,
      ).length;
      // A slow or unconfirmed video must not prevent text-only results from being written.
      if (running + (job.video ? this.unknown.size : 0) >= this.config.concurrent) continue;
      // Set the marker synchronously before invoking any producer callbacks.
      job.running = Promise.resolve().then(() => this.run(job));
    }
  }
  private assertCurrent(job: Job): void {
    job.controller.signal.throwIfAborted();
    if (this.stopped || this.now() >= job.deadline || !this.results.has(job.playId))
      throw new Error('ENDING_EXPIRED');
  }
  private publishStory(job: Job, story: EndingStory): void {
    this.assertCurrent(job);
    this.results.updateEnding(job.playId, { story, storyStatus: 'ready' });
    job.storyReady = true;
  }
  private async prepare(job: Job, packet: EndingPacket): Promise<PreparedEnding | null> {
    const signal = job.controller.signal;
    if (this.options.prepare && job.video)
      return this.options.prepare(job.id, packet, signal, (story) => this.publishStory(job, story));
    const scene = job.scene;
    if (!job.video || !scene) {
      job.stage = 'story';
      const design = await createEndingText(this.ai, job.id, packet, signal);
      this.publishStory(job, publicEndingStory(design));
      if (job.video) {
        job.stage = 'reference';
        throw new Error('ENDING_REFERENCE_MISSING');
      }
      return null;
    }
    const availableBefore = job.before;
    job.stage = 'story';
    const design = await createEndingDesign(
      this.ai,
      job.id,
      packet,
      scene,
      availableBefore[0],
      signal,
      availableBefore,
    );
    const story = publicEndingStory(design);
    this.publishStory(job, story);
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
    );
    return {
      ...frames,
      prompt: design.videoPrompt,
      story,
    };
  }
  private async run(job: Job): Promise<void> {
    const signal = job.controller.signal;
    try {
      this.assertCurrent(job);
      this.update(job.playId, {
        ...(job.video ? { status: 'preparing' as const } : {}),
        storyStatus: 'generating',
      });
      const graceUntil = job.packet.endedAt + (this.options.graceMs ?? 12_000);
      if (this.now() < graceUntil) await abortableDelay(graceUntil - this.now(), signal);
      this.assertCurrent(job);
      const packet = job.seal();
      const prepared = await this.prepare(job, packet);
      this.assertCurrent(job);
      if (!prepared) return;
      if (!job.storyReady) this.publishStory(job, prepared.story);
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
        throw error;
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
          // Status GET may be retried; the paid submission is never retried.
          signal.throwIfAborted();
          pollDelay = Math.min(8000, pollDelay * 2);
        }
        await abortableDelay(pollDelay, signal);
      }
      this.assertCurrent(job);
      job.stage = 'video_result';
      const result = await this.fal!.result(job.handle, signal);
      job.stage = 'video_download';
      const bytes = await this.fal!.downloadVideo(result.videoUrl, signal);
      job.stage = 'video_validation';
      validateEndingMp4(bytes);
      this.assertCurrent(job);
      job.stage = 'storage';
      this.results.putVideo(job.playId, bytes);
      this.update(job.playId, {
        status: 'ready',
        errorCode: null,
        videoPath: '/api/play/ending/video?playId=' + encodeURIComponent(job.playId),
      });
    } catch (error) {
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
              status:
                signal.reason === 'ENDING_TIMEOUT' ? ('expired' as const) : ('failed' as const),
            }
          : {}),
        storyStatus: job.storyReady ? 'ready' : 'failed',
        errorCode,
        videoPath: null,
      });
      this.reportFailure(job.playId, job.stage, errorCode);
    } finally {
      clearTimeout(job.timer);
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
