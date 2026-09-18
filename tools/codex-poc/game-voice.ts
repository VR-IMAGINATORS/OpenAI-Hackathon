import { randomUUID } from 'node:crypto';
import { liveRequest } from '../../packages/server/openai.js';
import { PocError } from './rpc.js';
import type { CodexWorker } from './worker.js';
import { safeLimits } from './probe.js';
import { voiceDiagnostic, voiceStartupDetail } from './live-diagnostics.js';

export interface GameVoiceReport {
  status: 'connected' | 'closed' | 'failed' | 'stopping';
  code?: string;
  phase?: 'starting' | 'active';
  detail?: string;
}

/** One voice thread on the player's existing, isolated authenticated process. */
export class CodexGameVoice {
  readonly id = randomUUID();
  private threadId?: string;
  private requested = false;
  private started = false;
  private answer?: string;
  private failure?: PocError;
  private closed = false;
  private stopping = false;
  private active = false;
  private stopTask?: Promise<void>;
  private unlisten?: () => void;
  private wake = new Set<() => void>();
  constructor(
    private worker: CodexWorker,
    private model: string,
    private report: (entry: GameVoiceReport) => void = () => {},
  ) {}

  isClosed() {
    return this.closed;
  }

  async start(body: unknown) {
    const request = liveRequest.parse(body);
    if (this.requested || this.stopping) throw new PocError('VOICE_ALREADY_STARTED');
    this.requested = true;
    try {
      safeLimits(await this.worker.rpc.call('account/rateLimits/read', {}));
      const thread = await this.worker.rpc.call('thread/start', {
        model: this.model,
        modelProvider: 'openai',
        cwd: this.worker.work,
        ephemeral: true,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        baseInstructions:
          'You are the voice connection for a game. Game decisions are handled by the client. Never use tools or execute tasks.',
      });
      this.threadId = thread.thread.id;
      this.unlisten = this.worker.rpc.consumeNotifications((m) => {
        if (m.params?.threadId !== this.threadId) return false;
        if (m.method === 'thread/realtime/started') {
          if (m.params.version !== 'v3') this.failure = new PocError('VOICE_VERSION_MISMATCH');
          else this.started = true;
        }
        if (m.method === 'thread/realtime/sdp') {
          if (
            typeof m.params.sdp !== 'string' ||
            !m.params.sdp.startsWith('v=0') ||
            m.params.sdp.length > 200000
          )
            this.failure = new PocError('INVALID_VOICE_SDP');
          else this.answer = m.params.sdp;
        }
        if (m.method === 'thread/realtime/error') {
          this.failure = new PocError('VOICE_UPSTREAM_ERROR');
          this.report({
            status: 'failed',
            code: voiceDiagnostic(m.params.message),
            phase: this.active ? 'active' : 'starting',
            // Only the error's message, never the notification or session payload.
            detail: voiceStartupDetail(m.params.message),
          });
          if (this.active) void this.stop().catch(() => {});
        }
        if (m.method === 'thread/realtime/closed' && !this.closed) {
          this.closed = true;
          this.report({
            status: 'closed',
            code: this.stopping ? 'AFTER_STOP_REQUEST' : 'WITHOUT_SERVER_STOP',
            phase: this.active ? 'active' : 'starting',
            detail:
              typeof m.params.reason === 'string' && m.params.reason.trim()
                ? voiceStartupDetail(m.params.reason)
                : 'No close reason supplied',
          });
        }
        for (const listener of this.wake) listener();
        // Never let continuous audio/transcripts consume the game judgment journal.
        return true;
      });
      if (this.stopping) throw new PocError('CANCELLED');
      await this.worker.rpc.call(
        'thread/realtime/start',
        {
          threadId: this.threadId,
          version: 'v3',
          outputModality: 'audio',
          prompt: request.session.instructions,
          // This authenticated route accepts the juniper/maple/... voice set.
          // listVoices.defaultV2 does not identify the voice set of a v3 session.
          voice: 'juniper',
          transport: request.transport,
          clientManagedHandoffs: true,
          includeStartupContext: false,
          flushTranscriptTailOnSessionEnd: false,
          // session.model is forbidden on the authenticated Codex route.
          // Instructions are immutable after initialization; provide them at startup.
        },
        20000,
      );
      await this.wait(
        () => (this.started && !!this.answer) || !!this.failure || this.closed,
        20000,
      );
      if (this.failure) throw this.failure;
      if (this.closed || this.stopping || !this.worker.isUsable())
        throw new PocError('VOICE_CLOSED');
      this.active = true;
      this.report({ status: 'connected' });
      return {
        session: { id: this.id },
        transport: { type: 'webrtc' as const, sdp: this.answer! },
      };
    } catch (error) {
      // A failed/uncertain creation must not leave a subscription call alive.
      await this.worker.invalidate();
      this.unlisten?.();
      throw error;
    }
  }

  private wait(ready: () => boolean, timeout: number) {
    if (ready()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const check = () => {
        if (ready()) {
          cleanup();
          resolve();
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new PocError('VOICE_TIMEOUT'));
      }, timeout);
      const cleanup = () => {
        clearTimeout(timer);
        this.wake.delete(check);
      };
      this.wake.add(check);
      check();
    });
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopping = true;
    this.report({
      status: 'stopping',
      code: this.failure ? 'UPSTREAM_ERROR' : 'SERVER_STOP_REQUEST',
    });
    this.stopTask = (async () => {
      try {
        if (!this.closed && this.threadId) {
          await this.worker.rpc.call('thread/realtime/stop', { threadId: this.threadId }, 2000);
          await this.wait(() => this.closed, 3000);
        }
        if (!this.closed) throw new PocError('VOICE_STOP_UNCONFIRMED');
        if (this.threadId && this.worker.isUsable())
          await this.worker.rpc.call('thread/unsubscribe', { threadId: this.threadId }, 2000);
      } catch (error) {
        await this.worker.invalidate();
        throw error;
      } finally {
        this.unlisten?.();
      }
    })();
    return this.stopTask;
  }
}
