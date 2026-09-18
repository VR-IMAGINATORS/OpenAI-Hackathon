import { SessionError } from '../../apps/server/control.js';
import { PocError } from './rpc.js';
import { safeLimits } from './probe.js';
import { startWorker, type CodexWorker } from './worker.js';
import { voiceDiagnostic, voiceStartupDetail } from './live-diagnostics.js';

export const liveProbeDurationMs = 60_000;
export interface LiveProbeView {
  state:
    | 'disconnected'
    | 'login'
    | 'pending'
    | 'ready'
    | 'starting'
    | 'connected'
    | 'stopping'
    | 'closed'
    | 'failed';
  requestedModel: null;
  requestedVersion: 'v3';
  diagnosticRevision: 'startup-detail-v2';
  verificationUrl?: string;
  userCode?: string;
  deadline?: number;
  errorCode?: string;
  diagnostic?: string;
  startupDetail?: string;
  versionConfirmed?: boolean;
  stopConfirmed?: boolean;
  processClosed?: boolean;
}
interface Entry {
  owner: string;
  view: LiveProbeView;
  worker?: CodexWorker;
  threadId?: string;
  cursor: number;
  speechCount: number;
  startRequested: boolean;
  stopping: boolean;
  lastSeen: number;
  loginTask?: Promise<void>;
  finishTask?: Promise<void>;
}
const initial = (): LiveProbeView => ({
  state: 'disconnected',
  requestedModel: null,
  requestedVersion: 'v3',
  diagnosticRevision: 'startup-detail-v2',
});

/** Experimental voice only. No API transport, persisted auth or game-state mutation. */
export class CodexLiveProbe {
  private entry?: Entry;
  private disposed = false;
  constructor(
    private factory = startWorker,
    private now = Date.now,
  ) {}

  private owned(owner: string): Entry {
    if (!this.entry || this.entry.owner !== owner) throw new SessionError('AUTH_REQUIRED', 401);
    return this.entry;
  }
  status(owner: string): LiveProbeView {
    if (!this.entry || this.entry.owner !== owner) return initial();
    const e = this.entry;
    e.lastSeen = this.now();
    if (e.view.state === 'connected' && e.worker) {
      const events = e.worker.rpc.since(e.cursor);
      const failure = events.find(
        (m) => m.params?.threadId === e.threadId && m.method === 'thread/realtime/error',
      );
      const stopped =
        failure ??
        events.find(
          (m) =>
            m.params?.threadId === e.threadId &&
            ['thread/realtime/closed', 'thread/realtime/error'].includes(m.method ?? ''),
        );
      if (stopped || !e.worker.isUsable()) {
        if (failure) {
          e.view.errorCode = 'VOICE_UPSTREAM_ERROR';
          e.view.diagnostic = `connected/error/${voiceDiagnostic(failure.params.message)}`;
        } else {
          e.view.errorCode = stopped ? 'VOICE_UPSTREAM_CLOSED' : 'VOICE_PROCESS_CLOSED';
          e.view.diagnostic = `connected/closed/${voiceDiagnostic(stopped?.params?.reason)}`;
        }
        void this.finish(e).catch(() => {});
      }
    }
    return { ...e.view };
  }
  login(owner: string): LiveProbeView {
    if (this.disposed) throw new SessionError('DRAINING', 503);
    if (this.entry && !this.entry.view.processClosed) {
      if (this.entry.owner === owner) return this.status(owner);
      throw new SessionError('CODEX_CAPACITY', 429);
    }
    const e: Entry = {
      owner,
      view: { ...initial(), state: 'login', deadline: this.now() + 180_000 },
      cursor: 0,
      speechCount: 0,
      startRequested: false,
      stopping: false,
      lastSeen: this.now(),
    };
    this.entry = e;
    e.loginTask = (async () => {
      try {
        e.worker = await this.factory();
        if (e.stopping) return;
        await e.worker.authenticate('device', ({ url, code }) => {
          if (e.stopping) return;
          const parsed = new URL(url);
          if (
            parsed.origin !== 'https://auth.openai.com' ||
            parsed.username ||
            parsed.password ||
            !code
          )
            throw new PocError('INVALID_LOGIN_RESPONSE');
          e.view = { ...e.view, state: 'pending', verificationUrl: parsed.href, userCode: code };
        });
        if (e.stopping) return;
        e.worker.rpc.clearEvents();
        e.view = { ...initial(), state: 'ready', deadline: this.now() + 300_000 };
      } catch (error) {
        if (!e.stopping) {
          e.view = { ...initial(), state: 'failed', errorCode: safeCode(error) };
          try {
            await e.worker?.close();
            e.view.processClosed = true;
          } catch {
            e.view.errorCode = 'CLEANUP_FAILED';
          }
        }
      } finally {
        if (e.stopping) await e.worker?.close();
      }
    })();
    void e.loginTask.catch(() => {});
    return { ...e.view };
  }

  async start(owner: string, sdp: string): Promise<{ sdp: string }> {
    const e = this.owned(owner);
    if (e.view.state !== 'ready' || e.stopping || this.now() >= (e.view.deadline ?? 0))
      throw new SessionError('VOICE_NOT_READY', 409);
    e.view = { ...initial(), state: 'starting', deadline: this.now() + liveProbeDurationMs };
    e.lastSeen = this.now();
    const w = e.worker!;
    try {
      safeLimits(await w.rpc.call('account/rateLimits/read', {}));
      const thread = await w.rpc.call('thread/start', {
        model: 'gpt-5.6-luna',
        modelProvider: 'openai',
        cwd: w.work,
        ephemeral: true,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        baseInstructions: 'You are a voice connection test. Do not use tools or execute tasks.',
      });
      e.threadId = thread.thread.id;
      if (e.stopping) throw new PocError('CANCELLED');
      e.cursor = w.rpc.cursor();
      e.startRequested = true;
      await w.rpc.call(
        'thread/realtime/start',
        {
          threadId: e.threadId,
          // The authenticated Codex route rejects session.model overrides.
          // Omit the field entirely; verify the reported model in the client.
          version: 'v3',
          outputModality: 'audio',
          transport: { type: 'webrtc', sdp },
          clientManagedHandoffs: true,
          includeStartupContext: false,
          flushTranscriptTailOnSessionEnd: false,
          // Use the subscription route's default voice instructions. A custom prompt
          // is optional in the RPC schema but may be rejected by the upstream service.
        },
        20_000,
      );
      const deadline = this.now() + 20_000;
      let answer: string | undefined,
        version = false;
      while (!answer || !version) {
        const index = w.rpc.cursor();
        const failure = w.rpc
          .since(e.cursor)
          .find((m) => m.params?.threadId === e.threadId && m.method === 'thread/realtime/error');
        if (failure) {
          e.view.diagnostic = `starting/error/${voiceDiagnostic(failure.params.message)}`;
          e.view.startupDetail = voiceStartupDetail(failure.params.message);
          throw new PocError('VOICE_UPSTREAM_ERROR');
        }
        for (const m of w.rpc.since(e.cursor)) {
          if (m.params?.threadId !== e.threadId) continue;
          if (m.method === 'thread/realtime/closed') {
            e.view.diagnostic = `starting/closed/${voiceDiagnostic(m.params.reason)}`;
            throw new PocError('VOICE_UPSTREAM_CLOSED');
          }
          if (m.method === 'thread/realtime/started') {
            if (m.params.version !== 'v3') throw new PocError('VOICE_VERSION_MISMATCH');
            version = true;
          }
          if (m.method === 'thread/realtime/sdp') answer = m.params.sdp;
        }
        if (e.stopping) throw new PocError('CANCELLED');
        if (answer && version) break;
        if (this.now() >= deadline) throw new PocError('VOICE_START_TIMEOUT');
        await w.rpc.wait(
          index,
          (m) =>
            m.params?.threadId === e.threadId && m.method?.startsWith('thread/realtime/') === true,
          Math.max(1, deadline - this.now()),
        );
      }
      if (typeof answer !== 'string' || answer.length > 65536 || !answer.startsWith('v=0'))
        throw new PocError('INVALID_VOICE_SDP');
      e.view = { ...e.view, state: 'connected', versionConfirmed: true };
      return { sdp: answer };
    } catch (error) {
      if (!e.stopping) e.view.errorCode = safeCode(error);
      await this.finish(e);
      throw new PocError(safeCode(error));
    }
  }
  async speak(owner: string) {
    const e = this.owned(owner);
    if (e.view.state !== 'connected' || e.stopping || this.now() >= (e.view.deadline ?? 0))
      throw new SessionError('VOICE_NOT_READY', 409);
    if (++e.speechCount > 3) throw new SessionError('REQUEST_LIMIT', 429);
    try {
      await e.worker!.rpc.call('thread/realtime/appendSpeech', {
        threadId: e.threadId,
        text: 'こんにちは。音声接続のテストです。こちらの声が聞こえますか。',
      });
    } catch (error) {
      e.view.errorCode = safeCode(error);
      await this.finish(e);
      throw new PocError(safeCode(error));
    }
  }
  stop(owner: string) {
    return this.finish(this.owned(owner));
  }
  private finish(e: Entry): Promise<void> {
    if (e.finishTask) return e.finishTask;
    e.stopping = true;
    e.view = {
      ...initial(),
      state: 'stopping',
      errorCode: e.view.errorCode,
      diagnostic: e.view.diagnostic,
      startupDetail: e.view.startupDetail,
      versionConfirmed: e.view.versionConfirmed,
    };
    e.finishTask = (async () => {
      if (e.startRequested && e.worker && e.threadId) {
        try {
          const alreadyClosed = e.worker.rpc
            .since(e.cursor)
            .some(
              (m) => m.method === 'thread/realtime/closed' && m.params?.threadId === e.threadId,
            );
          if (!alreadyClosed) {
            await e.worker.rpc.call('thread/realtime/stop', { threadId: e.threadId }, 2000);
            await e.worker.rpc.wait(
              e.cursor,
              (m) => m.method === 'thread/realtime/closed' && m.params?.threadId === e.threadId,
              3000,
            );
          }
          e.view.stopConfirmed = true;
        } catch {
          e.view.stopConfirmed = false;
        }
      }
      try {
        await e.worker?.close();
        await e.loginTask;
        await e.worker?.close();
        e.view.processClosed = true;
        e.view.state = e.view.errorCode ? 'failed' : 'closed';
      } catch {
        e.view.state = 'failed';
        e.view.errorCode = 'CLEANUP_FAILED';
      }
    })();
    return e.finishTask;
  }
  async tick() {
    const e = this.entry;
    if (
      e &&
      !e.view.processClosed &&
      !e.stopping &&
      (this.now() >= (e.view.deadline ?? Infinity) ||
        (['starting', 'connected'].includes(e.view.state) && this.now() - e.lastSeen >= 20_000))
    )
      await this.finish(e);
  }
  async dispose() {
    this.disposed = true;
    if (this.entry) {
      await this.finish(this.entry);
      if (!this.entry.view.processClosed) throw new PocError('CLEANUP_FAILED');
    }
  }
}
function safeCode(error: unknown) {
  return error instanceof PocError && /^[A-Z0-9_-]{1,64}$/.test(error.code)
    ? error.code
    : 'VOICE_PROBE_FAILED';
}
