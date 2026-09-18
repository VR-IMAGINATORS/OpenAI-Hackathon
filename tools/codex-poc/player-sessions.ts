import type { PlayerJudgments } from '../../apps/server/player-judgments.js';
import type { CodexLoginStatus } from '../../packages/shared/api.js';
import { SessionError } from '../../apps/server/control.js';
import { AiServiceError } from '../../packages/server/ai-service.js';
import { startWorker, type CodexWorker } from './worker.js';
import { createGameResponder, requireModel } from './game-responder.js';
import { CodexGameVoice, type GameVoiceReport } from './game-voice.js';
import type { OpenAITransport } from '../../packages/server/openai.js';
import { responseRequest } from '../../packages/server/openai.js';
import { generateCodexImage } from './image-responder.js';
import { PocError } from './rpc.js';

interface Entry {
  view: CodexLoginStatus;
  deadline: number;
  worker?: CodexWorker;
  responder?: ReturnType<typeof createGameResponder>;
  playId?: string;
  cancelled: boolean;
  task?: Promise<void>;
  closing?: Promise<void>;
  voice?: CodexGameVoice;
  inspector?: ReturnType<typeof createGameResponder>;
  pending: Set<Promise<unknown>>;
  playAbort?: AbortController;
  releasing?: Promise<void>;
}

export class CodexPlayerSessions implements PlayerJudgments {
  private entries = new Map<string, Entry>();
  private plays = new Map<string, Entry>();
  private disposed = false;
  private voices = new Map<string, CodexGameVoice>();
  /** No public API transport exists on this route, including optional media. */
  readonly transport: OpenAITransport = {
    createLiveSession: (body, playId) =>
      this.runForPlay(playId, async () => {
        const e = playId ? this.plays.get(playId) : undefined;
        if (!e || e.cancelled || !e.worker?.isUsable())
          throw new AiServiceError(
            503,
            'CODEX_UNAVAILABLE',
            '開始画面から再ログインしてください。',
          );
        if (e.voice && !e.voice.isClosed()) throw new Error('VOICE_ALREADY_ACTIVE');
        const previous = e.voice;
        if (previous) await previous.stop();
        if (e.voice !== previous) throw new Error('VOICE_ALREADY_ACTIVE');
        if (e.cancelled || !e.worker.isUsable()) throw new Error('CODEX_UNAVAILABLE');
        const voice = new CodexGameVoice(e.worker, this.options.model, this.options.reportVoice);
        e.voice = voice;
        this.voices.set(voice.id, voice);
        return voice.start(body);
      }),
    createResponse: (body, signal, playId) =>
      this.runForPlay(playId, async (playSignal) => {
        signal = signal ? AbortSignal.any([signal, playSignal]) : playSignal;
        if (!playId) throw new Error('SUBSCRIPTION_API_DISABLED');
        const e = this.mediaEntry(playId);
        const request = responseRequest.parse(body);
        if (request.text.format.name !== 'scene_inspection')
          throw new Error('SUBSCRIPTION_API_DISABLED');
        e.inspector ??= createGameResponder(e.worker!, request.model, undefined, {
          preserveWorkerOnCompletedFailure: true,
        });
        return e.inspector(request, signal);
      }),
    createImage: (body, signal, playId) =>
      this.runForPlay(playId, async (playSignal) => {
        signal = signal ? AbortSignal.any([signal, playSignal]) : playSignal;
        if (!playId) throw new Error('SUBSCRIPTION_API_DISABLED');
        const e = this.mediaEntry(playId);
        const started = performance.now();
        let status = 'failed';
        let code: string | undefined;
        this.options.reportImage?.({ status: 'starting', durationMs: 0 });
        try {
          const image = await generateCodexImage(e.worker!, this.options.model, body, signal);
          status = 'completed';
          return image;
        } catch (error) {
          code = error instanceof PocError ? error.code : 'CODEX_IMAGE_FAILED';
          throw error;
        } finally {
          this.options.reportImage?.({
            status,
            code,
            durationMs: Math.round(performance.now() - started),
          });
        }
      }),
    createImageEdit: async () => {
      throw new Error('SUBSCRIPTION_API_DISABLED');
    },
    hangup: async (id) => {
      const voice = this.voices.get(id);
      if (!voice) throw new Error('VOICE_UNKNOWN');
      await voice.stop();
    },
    isLiveSessionClosed: (id) => this.voices.get(id)?.isClosed() === true,
    releaseClosedLiveSession: (id) => {
      if (this.voices.get(id)?.isClosed()) this.voices.delete(id);
    },
  };
  private readonly now: () => number;
  private async runForPlay<T>(
    playId: string | undefined,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (!playId) throw new Error('SUBSCRIPTION_API_DISABLED');
    const e = this.mediaEntry(playId);
    const task = run(e.playAbort!.signal);
    e.pending.add(task);
    try {
      return await task;
    } finally {
      e.pending.delete(task);
    }
  }
  private mediaEntry(playId: string) {
    const e = this.plays.get(playId);
    if (!e || e.cancelled || e.playAbort?.signal.aborted || !e.worker?.isUsable())
      throw new AiServiceError(503, 'CODEX_UNAVAILABLE', 'Codexへ再ログインしてください。');
    return e;
  }
  constructor(
    private options: {
      model: string;
      capacity: number;
      now?: () => number;
      factory?: typeof startWorker;
      checkModel?: typeof requireModel;
      responder?: typeof createGameResponder;
      report?: (entry: { status: string; durationMs: number; playId?: string }) => void;
      reportVoice?: (entry: GameVoiceReport) => void;
      reportImage?: (entry: { status: string; durationMs: number; code?: string }) => void;
    },
  ) {
    this.now = options.now ?? Date.now;
  }

  status(owner: string): CodexLoginStatus {
    const e = this.entries.get(owner);
    if (!e) return { status: 'disconnected' };
    if ((!e.playId && this.now() >= e.deadline) || (e.worker && !e.worker.isUsable())) {
      void this.close(e).catch(() => {});
      return { status: 'failed' };
    }
    return { ...e.view };
  }

  start(owner: string): CodexLoginStatus {
    if (this.disposed) throw new SessionError('DRAINING', 503);
    const previous = this.entries.get(owner);
    if (previous) return this.status(owner);
    if (this.entries.size >= this.options.capacity) throw new SessionError('CODEX_CAPACITY', 429);
    const e: Entry = {
      view: { status: 'starting' },
      deadline: this.now() + 180_000,
      cancelled: false,
      pending: new Set(),
    };
    this.entries.set(owner, e); // Reserve synchronously, including worker startup.
    e.task = this.connect(e);
    return { ...e.view };
  }

  private async connect(e: Entry) {
    try {
      e.worker = await (this.options.factory ?? startWorker)();
      if (e.cancelled) {
        await e.worker.close();
        return;
      }
      await e.worker.authenticate('device', ({ url, code }) => {
        if (e.cancelled) return;
        const parsed = new URL(url);
        if (
          parsed.origin !== 'https://auth.openai.com' ||
          parsed.username ||
          parsed.password ||
          !code
        )
          throw new Error('INVALID_LOGIN_RESPONSE');
        e.view = {
          status: 'pending',
          verificationUrl: parsed.href,
          userCode: code,
          expiresAt: e.deadline,
        };
      });
      if (e.cancelled || this.now() >= e.deadline) throw new Error('LOGIN_EXPIRED');
      await (this.options.checkModel ?? requireModel)(e.worker, this.options.model);
      if (e.cancelled) return;
      e.worker.rpc.clearEvents();
      e.responder = (this.options.responder ?? createGameResponder)(
        e.worker,
        this.options.model,
        (event) => this.options.report?.({ ...event, playId: e.playId }),
      );
      e.deadline = this.now() + 600_000;
      e.view = { status: 'ready', model: this.options.model, expiresAt: e.deadline };
    } catch {
      e.view = { status: 'failed' };
      await this.close(e).catch(() => {});
    }
  }

  private close(e: Entry): Promise<void> {
    e.cancelled = true;
    e.playAbort?.abort();
    e.view = { status: 'failed' }; // Erase the code before waiting for provider cleanup.
    e.responder = undefined;
    if (!e.closing)
      e.closing = (async () => {
        try {
          await e.voice?.stop();
        } catch {
          /* AiService retains unconfirmed voice closure; always destroy credentials. */
        } finally {
          await e.worker?.close();
        }
      })();
    return e.closing;
  }

  async logout(owner: string) {
    const e = this.entries.get(owner);
    if (!e) return;
    if (e.playId) throw new SessionError('CODEX_PLAY_ACTIVE', 409);
    await this.remove(owner, e);
  }
  private async remove(owner: string, e: Entry) {
    await this.close(e);
    await e.task; // Also wait for a late worker creation to be destroyed.
    if (e.worker) await e.worker.close();
    if (this.entries.get(owner) === e) this.entries.delete(owner);
  }
  bind(owner: string, playId: string) {
    const e = this.entries.get(owner);
    if (!e || this.status(owner).status !== 'ready' || !e.responder || e.cancelled)
      throw new SessionError('CODEX_LOGIN_REQUIRED', 401);
    if (e.playId) throw new SessionError('CODEX_PLAY_ACTIVE', 409);
    e.playId = playId;
    e.playAbort = new AbortController();
    this.plays.set(playId, e);
  }
  respond = (body: unknown, signal: AbortSignal | undefined, playId: string) =>
    this.runForPlay(playId, async (playSignal) => {
      signal = signal ? AbortSignal.any([signal, playSignal]) : playSignal;
      const e = this.plays.get(playId);
      if (!e?.responder || e.cancelled || !e.worker?.isUsable())
        throw new AiServiceError(503, 'CODEX_UNAVAILABLE', '開始画面から再ログインしてください。');
      return e.responder(body, signal);
    });
  async release(playId: string) {
    const e = this.plays.get(playId);
    if (!e) return;
    if (!e.releasing)
      e.releasing = (async () => {
        // Reject old-play requests immediately; don't allow replay until cleanup settles.
        e.playAbort?.abort();
        await Promise.allSettled([...e.pending]);
        try {
          await e.voice?.stop();
          if (e.cancelled || !e.worker?.isUsable()) throw new Error('CODEX_UNAVAILABLE');
          e.voice = undefined;
          e.inspector = undefined;
          e.deadline = this.now() + 600_000;
          e.view = { status: 'ready', model: this.options.model, expiresAt: e.deadline };
        } catch {
          for (const [owner, entry] of this.entries) if (entry === e) await this.remove(owner, e);
        } finally {
          this.plays.delete(playId);
          e.playId = undefined;
          e.playAbort = undefined;
        }
      })();
    await e.releasing;
    e.releasing = undefined;
  }
  async sweep() {
    for (const [owner, e] of this.entries)
      if (!e.playId && this.now() >= e.deadline) await this.remove(owner, e);
  }
  async dispose() {
    this.disposed = true;
    const results = await Promise.allSettled(
      [...this.entries].map(([owner, e]) => this.remove(owner, e)),
    );
    this.plays.clear();
    this.voices.clear();
    if (results.some((r) => r.status === 'rejected')) throw new Error('CODEX_CLEANUP_FAILED');
  }
}
