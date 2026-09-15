import type { PlayControl } from '../../../packages/shared/api.js';
import { playRequest, retryUncertain, PlayApiError } from './play-api.js';
import { VoiceActivityMonitor, type VoiceActivitySnapshot } from './voice-activity.js';
export type VoiceState = 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';
import type { LiveCommand } from '../../../packages/shared/game.js';
interface LiveOptions {
  onState: (state: VoiceState) => void;
  onEvent: (event: Record<string, unknown>, generation: number) => void;
  onPlaybackBlocked: () => void;
  onVoiceActivity?: (snapshot: VoiceActivitySnapshot) => void;
}
export class LiveConnection {
  generation = 0;
  opening: LiveCommand | null = null;
  state: VoiceState = 'closed';
  private peer: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private channel: RTCDataChannel | null = null;
  private audio = new Audio();
  private cancelled = false;
  private inputStopped = false;
  private activity: VoiceActivityMonitor | null = null;
  constructor(private options: LiveOptions) {
    this.audio.autoplay = true;
    this.audio.setAttribute('playsinline', '');
    this.audio.addEventListener('playing', () => this.activity?.setPlaybackReady(true));
    for (const event of ['pause', 'waiting', 'stalled', 'ended', 'error']) {
      this.audio.addEventListener(event, () => this.activity?.setPlaybackReady(false));
    }
  }
  private update(state: VoiceState) {
    this.state = state;
    this.options.onState(state);
  }
  private started = false;
  pendingRequest: { requestId: string; sdp: string } | null = null;
  setOptions(options: LiveOptions) {
    this.options = options;
  }
  async prepare(): Promise<void> {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        'カメラとマイクにはHTTPSが必要です。PCに表示された最新のQRコードから開いてください。',
      );
    }
    this.cancelled = false;
    this.inputStopped = false;
    this.update('connecting');
    this.activity?.close();
    const activity = (this.activity = new VoiceActivityMonitor((snapshot) =>
      this.options.onVoiceActivity?.({ ...snapshot, inputStopped: this.inputStopped }),
    ));
    void activity.resume();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (this.cancelled || this.inputStopped) {
        this.stream.getTracks().forEach((track) => track.stop());
        return;
      }
      activity.setInput(this.stream);
      const peer = (this.peer = new RTCPeerConnection());
      this.stream.getTracks().forEach((track) => peer.addTrack(track, this.stream!));
      peer.ontrack = (event) => {
        if (this.cancelled || this.peer !== peer) return;
        const remote = event.streams[0] ?? new MediaStream([event.track]);
        this.audio.srcObject = remote;
        activity.setOutput(remote);
        void this.audio.play().catch(() => {
          activity.setPlaybackReady(false);
          this.options.onPlaybackBlocked();
        });
      };
      peer.onconnectionstatechange = () => {
        if (this.cancelled) return;
        if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected')
          this.update(peer.connectionState);
        else if (peer.connectionState === 'closed') this.update('closed');
      };
      const channel = (this.channel = peer.createDataChannel('oai-events'));
      this.started = false;
      channel.onmessage = (event) => {
        if (this.cancelled || typeof event.data !== 'string' || event.data.length > 32_768) return;
        let value: Record<string, unknown>;
        try {
          value = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!value || typeof value !== 'object') return;
        if (
          this.inputStopped &&
          ['session.input_transcript.delta', 'session.delegation.created'].includes(
            String(value.type),
          )
        )
          return;
        if (value.type === 'session.started') {
          this.started = true;
          this.update('connected');
        }
        if (value.type === 'session.closed') this.update('disconnected');
        if (
          [
            'session.input_transcript.delta',
            'session.output_transcript.delta',
            'session.delegation.created',
          ].includes(String(value.type))
        ) {
          this.options.onEvent(value, this.generation);
        }
      };
      channel.onclose = () => {
        if (!this.cancelled) this.update('disconnected');
      };
      await peer.setLocalDescription(await peer.createOffer());
      await new Promise<void>((resolve, reject) => {
        if (peer.iceGatheringState === 'complete') return resolve();
        const timer = window.setTimeout(() => {
          peer.removeEventListener('icegatheringstatechange', check);
          reject(new Error('音声接続の準備がタイムアウトしました。別の回線で再試行してください。'));
        }, 10_000);
        const check = () => {
          if (peer.iceGatheringState === 'complete') {
            window.clearTimeout(timer);
            peer.removeEventListener('icegatheringstatechange', check);
            resolve();
          }
        };
        peer.addEventListener('icegatheringstatechange', check);
      });
      if (this.cancelled) return;
    } catch (error) {
      this.close();
      if (error instanceof DOMException && error.name === 'NotAllowedError')
        throw new Error('マイクを許可してください。ブラウザのサイト設定から変更できます。');
      throw error;
    }
  }
  async connect(control: PlayControl): Promise<void> {
    try {
      if (!this.peer) await this.prepare();
      const peer = this.peer!;
      const body = this.pendingRequest ?? {
        requestId: crypto.randomUUID(),
        sdp: peer.localDescription!.sdp,
      };
      this.pendingRequest = body;
      const answer = await retryUncertain(() =>
        playRequest<{ sdp: string; generation: number; opening?: LiveCommand | null }>(
          '/api/play/live',
          body,
          'POST',
          control,
        ),
      );
      if (this.cancelled) return;
      this.pendingRequest = null;
      this.generation = answer.generation;
      this.activity?.setGeneration(answer.generation);
      this.opening = answer.opening ?? null;
      await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      await new Promise<void>((resolve, reject) => {
        const until = Date.now() + 15_000;
        const timer = window.setInterval(() => {
          if (this.started) {
            window.clearInterval(timer);
            resolve();
          } else if (this.cancelled || Date.now() > until) {
            window.clearInterval(timer);
            reject(new Error('音声の応答を確認できません。接続を再開してください。'));
          }
        }, 100);
      });
    } catch (error) {
      if (error instanceof PlayApiError && error.status === 0) {
        this.update('failed');
        throw error;
      }
      this.pendingRequest = null;
      this.cancelled = true;
      this.release();
      this.update('failed');
      if (error instanceof DOMException && error.name === 'NotAllowedError')
        throw new Error(
          'マイクを許可してください。ブラウザのサイト設定で許可した後、接続を再開できます。',
        );
      throw error;
    }
  }
  send(commands: LiveCommand[]) {
    if (this.channel?.readyState !== 'open') return false;
    for (const command of commands) this.channel.send(JSON.stringify(command));
    return true;
  }
  async resumeAudio() {
    const resume = this.activity?.resume();
    try {
      await this.audio.play();
      this.activity?.setPlaybackReady(true);
    } catch (error) {
      this.activity?.setPlaybackReady(false);
      this.options.onPlaybackBlocked();
      throw error;
    }
    await resume;
  }
  stopInput() {
    if (this.inputStopped) return;
    this.inputStopped = true;
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = false;
      track.stop();
    });
  }
  close() {
    if (this.channel?.readyState === 'open')
      this.channel.send(JSON.stringify({ type: 'session.close', event_id: crypto.randomUUID() }));
    this.cancelled = true;
    this.release();
    this.update('closed');
  }
  private release() {
    this.activity?.close();
    this.activity = null;
    this.channel?.close();
    this.peer?.close();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.audio.pause();
    this.audio.srcObject = null;
    this.channel = null;
    this.peer = null;
    this.stream = null;
  }
}
