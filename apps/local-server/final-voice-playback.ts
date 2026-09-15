import type { VoiceActivity } from '../../packages/shared/harness.js';

/** Playback telemetry controls Live cleanup only; the game has already ended. */
export class FinalVoicePlayback {
  private generation = 0;
  private startedAt: number | null = null;
  private lastProgressAt = 0;
  private lastTranscriptAt = -Infinity;
  private activity?: { value: VoiceActivity; at: number };
  private quietSince: number | null = null;
  private pendingCommand = 0;
  private acknowledged = 0;
  private awaitingSpeech = false;

  constructor(private now: () => number) {}

  start(generation: number, pendingCommand: number, awaitingSpeech = false) {
    this.generation = generation;
    this.startedAt = this.lastProgressAt = this.now();
    this.pendingCommand = pendingCommand;
    this.acknowledged = 0;
    this.awaitingSpeech = awaitingSpeech;
  }

  expectSpeech(sequence: number) {
    if (this.startedAt === null) return;
    this.pendingCommand = sequence;
    this.awaitingSpeech = true;
    this.quietSince = null;
    this.lastProgressAt = this.now();
  }

  acknowledge(sequence: number) {
    this.acknowledged = Math.max(this.acknowledged, sequence);
  }

  transcript() {
    if (this.startedAt === null) return;
    this.lastTranscriptAt = this.lastProgressAt = this.now();
    this.quietSince = null;
  }

  report(value: VoiceActivity) {
    if (
      this.startedAt === null ||
      value.generation !== this.generation ||
      (this.activity && value.sequence <= this.activity.value.sequence)
    )
      return;
    const at = this.now();
    if (!this.activity || at - this.activity.at >= 2000) this.quietSince = null;
    this.activity = { value: { ...value }, at };
    if (value.playbackReady && value.output === 'active') {
      this.lastProgressAt = at;
      if (this.acknowledged >= this.pendingCommand) this.awaitingSpeech = false;
    }
    if (value.inputStopped && value.playbackReady && value.output === 'quiet')
      this.quietSince ??= at;
    else this.quietSince = null;
  }

  get closingAt() {
    if (this.startedAt === null) return Infinity;
    const now = this.now();
    // A quiet report already represents 800ms of sampled silence. Require an
    // additional continuous gap and no new text, never a single quiet sample.
    if (
      !this.awaitingSpeech &&
      this.acknowledged >= this.pendingCommand &&
      this.quietSince !== null &&
      now - this.quietSince >= 2000 &&
      now - this.lastTranscriptAt >= 2000 &&
      this.activity &&
      now - this.activity.at < 2000
    )
      // The watchdog reads its clock before this getter. Returning a new `now`
      // would keep moving the deadline just beyond that comparison forever.
      return Math.max(this.quietSince + 2000, this.lastTranscriptAt + 2000);
    // Missing/suspended playback cannot prove completion. Release abandoned
    // calls after 60s without output progress; active speech renews this wait.
    return this.lastProgressAt + 60_000;
  }
}
