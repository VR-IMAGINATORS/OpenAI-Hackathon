export type Activity = 'active' | 'quiet' | 'unknown';
export interface VoiceActivitySnapshot {
  generation: number;
  sequence: number;
  input: Activity;
  output: Activity;
  playbackReady: boolean;
}

/** Silence requires continuous samples; a suspended/background gap cannot prove silence. */
export class ActivityDetector {
  private state: Activity = 'unknown';
  private quietSince: number | null = null;
  private previousAt: number | null = null;
  sample(rms: number | null, now: number): Activity {
    if (this.previousAt !== null && (now - this.previousAt > 200 || now < this.previousAt)) {
      this.state = 'unknown';
      this.quietSince = null;
    }
    this.previousAt = now;
    if (rms === null || !Number.isFinite(rms)) {
      this.state = 'unknown';
      this.quietSince = null;
    } else if (rms >= 0.02 || (this.state === 'active' && rms >= 0.01)) {
      this.state = 'active';
      this.quietSince = null;
    } else if (rms < 0.01) {
      this.quietSince ??= now;
      if (now - this.quietSince >= 800) this.state = 'quiet';
    } else {
      this.quietSince = null;
    }
    return this.state;
  }
}

interface AnalysisBranch {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
  detector: ActivityDetector;
}

/** Analysis-only branches. Never connect these nodes to context.destination. */
export class VoiceActivityMonitor {
  private context: AudioContext | null = null;
  private input: AnalysisBranch | null = null;
  private output: AnalysisBranch | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private sequence = 0;
  private closed = false;
  private playbackReady = false;
  private lastAt = -Infinity;
  private lastKey = '';

  constructor(private onActivity: (snapshot: VoiceActivitySnapshot) => void) {
    try {
      this.context = new AudioContext();
    } catch {
      // Unsupported or denied analysis must not break the existing audio path.
    }
    this.timer = setInterval(() => this.tick(), 50);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  setGeneration(generation: number) {
    this.generation = generation;
    this.sequence = 0;
    this.lastAt = -Infinity;
    this.lastKey = '';
    this.resetDetectors();
  }
  setInput(stream: MediaStream) {
    this.disconnect(this.input);
    this.input = this.branch(stream);
  }
  setOutput(stream: MediaStream) {
    this.disconnect(this.output);
    this.output = this.branch(stream);
    this.playbackReady = false;
  }
  setPlaybackReady(ready: boolean) {
    this.playbackReady = ready;
    if (!ready) this.output?.detector.sample(null, performance.now());
  }
  async resume() {
    if (!this.closed && this.context?.state === 'suspended') {
      try {
        await this.context.resume();
      } catch {
        // Keep unknown; audio playback can still work without analysis.
      }
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.disconnect(this.input);
    this.disconnect(this.output);
    this.input = this.output = null;
    void this.context?.close().catch(() => {});
    this.context = null;
  }
  private onVisibility = () => {
    this.resetDetectors();
    this.tick();
  };
  private resetDetectors() {
    if (this.input) this.input.detector = new ActivityDetector();
    if (this.output) this.output.detector = new ActivityDetector();
  }
  private branch(stream: MediaStream): AnalysisBranch | null {
    if (!this.context || this.closed) return null;
    let source: MediaStreamAudioSourceNode | null = null;
    let analyser: AnalyserNode | null = null;
    try {
      source = this.context.createMediaStreamSource(stream);
      analyser = this.context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      return {
        stream,
        source,
        analyser,
        samples: new Float32Array(analyser.fftSize),
        detector: new ActivityDetector(),
      };
    } catch {
      source?.disconnect();
      analyser?.disconnect();
      return null;
    }
  }
  private disconnect(branch: AnalysisBranch | null) {
    branch?.source.disconnect();
    branch?.analyser.disconnect();
    // Tracks belong to LiveConnection; analysis never stops them.
  }
  private activity(branch: AnalysisBranch | null, valid: boolean, now: number): Activity {
    if (!branch) return 'unknown';
    const tracks = branch.stream.getAudioTracks();
    if (
      !valid ||
      tracks.length === 0 ||
      tracks.some((track) => !track.enabled || track.muted || track.readyState !== 'live')
    ) {
      return branch.detector.sample(null, now);
    }
    try {
      branch.analyser.getFloatTimeDomainData(branch.samples);
      let sum = 0;
      for (const sample of branch.samples) sum += sample * sample;
      return branch.detector.sample(Math.sqrt(sum / branch.samples.length), now);
    } catch {
      return branch.detector.sample(null, now);
    }
  }
  private tick() {
    if (this.closed) return;
    const now = performance.now();
    const visible = document.visibilityState === 'visible';
    const valid = visible && this.context?.state === 'running';
    const playbackReady = visible && this.playbackReady;
    const input = this.activity(this.input, valid, now);
    const output = this.activity(this.output, valid && playbackReady, now);
    const key = `${input}/${output}/${playbackReady}`;
    if (
      this.generation <= 0 ||
      now - this.lastAt < 250 ||
      (key === this.lastKey && now - this.lastAt < 1000)
    )
      return;
    this.lastAt = now;
    this.lastKey = key;
    this.onActivity({
      generation: this.generation,
      sequence: ++this.sequence,
      input,
      output,
      playbackReady,
    });
  }
}
