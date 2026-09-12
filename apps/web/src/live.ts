import { playRequest } from './play-api.js';
export type VoiceState = 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';
import type { LiveCommand } from '../../../packages/shared/game.js';
interface LiveOptions {
  onState: (state: VoiceState) => void;
  onEvent: (event: Record<string, unknown>, generation: number) => void;
  onPlaybackBlocked: () => void;
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
  constructor(private options: LiveOptions) {
    this.audio.autoplay = true;
    this.audio.setAttribute('playsinline', '');
  }
  private update(state: VoiceState) { this.state = state; this.options.onState(state); }
  async connect(passphrase: string): Promise<void> {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('カメラとマイクにはHTTPSが必要です。PCに表示された最新のQRコードから開いてください。');
    }
    this.cancelled = false;
    this.update('connecting');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (this.cancelled) { this.stream.getTracks().forEach(track => track.stop()); return; }
      const peer = this.peer = new RTCPeerConnection();
      this.stream.getTracks().forEach(track => peer.addTrack(track, this.stream!));
      peer.ontrack = event => {
        this.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void this.audio.play().catch(() => this.options.onPlaybackBlocked());
      };
      peer.onconnectionstatechange = () => {
        if (this.cancelled) return;
        if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') this.update(peer.connectionState);
        else if (peer.connectionState === 'closed') this.update('closed');
      };
      const channel = this.channel = peer.createDataChannel('oai-events');
      let started = false;
      channel.onmessage = event => {
        if (this.cancelled || typeof event.data !== 'string' || event.data.length > 32_768) return;
        let value: Record<string, unknown>;
        try { value = JSON.parse(event.data); } catch { return; }
        if (!value || typeof value !== 'object') return;
        if (value.type === 'session.started') { started = true; this.update('connected'); }
        if (value.type === 'session.closed') this.update('disconnected');
        if (['session.input_transcript.delta', 'session.output_transcript.delta', 'session.delegation.created'].includes(String(value.type))) {
          this.options.onEvent(value, this.generation);
        }
      };
      channel.onclose = () => { if (!this.cancelled) this.update('disconnected'); };
      await peer.setLocalDescription(await peer.createOffer());
      await new Promise<void>((resolve, reject) => {
        if (peer.iceGatheringState === 'complete') return resolve();
        const timer = window.setTimeout(() => { peer.removeEventListener('icegatheringstatechange', check); reject(new Error('音声接続の準備がタイムアウトしました。別の回線で再試行してください。')); }, 10_000);
        const check = () => { if (peer.iceGatheringState === 'complete') { window.clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', check); resolve(); } };
        peer.addEventListener('icegatheringstatechange', check);
      });
      if (this.cancelled) return;
      const answer = await playRequest<{ sdp: string; generation: number; opening?: LiveCommand | null }>('/api/play/live', { sdp: peer.localDescription!.sdp, ...(passphrase ? { passphrase } : {}) });
      if (this.cancelled) return;
      this.generation = answer.generation;
      this.opening = answer.opening ?? null;
      await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      await new Promise<void>((resolve, reject) => {
        const until = Date.now() + 15_000;
        const timer = window.setInterval(() => {
          if (started) { window.clearInterval(timer); resolve(); }
          else if (this.cancelled || Date.now() > until) { window.clearInterval(timer); reject(new Error('音声の応答を確認できません。接続を再開してください。')); }
        }, 100);
      });
    } catch (error) {
      this.cancelled = true;
      this.release();
      this.update('failed');
      if (error instanceof DOMException && error.name === 'NotAllowedError') throw new Error('マイクを許可してください。ブラウザのサイト設定で許可した後、接続を再開できます。');
      throw error;
    }
  }
  send(commands: LiveCommand[]) {
    if (this.channel?.readyState !== 'open') return false;
    for (const command of commands) this.channel.send(JSON.stringify(command));
    return true;
  }
  async resumeAudio() { await this.audio.play(); }
  close() {
    if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify({ type: 'session.close', event_id: crypto.randomUUID() }));
    this.cancelled = true;
    this.release();
    this.update('closed');
  }
  private release() {
    this.channel?.close(); this.peer?.close();
    this.stream?.getTracks().forEach(track => track.stop());
    this.audio.pause(); this.audio.srcObject = null;
    this.channel = null; this.peer = null; this.stream = null;
  }
}