import type { TranscriptFragment } from '../../packages/shared/conversation.js';
import type { VoiceActivity } from '../../packages/shared/harness.js';

/** UI delivery only: neither transcript grouping nor silence authorizes game actions. */
export class OpeningBriefingDelivery {
  private generation = 0;
  private delivered = false;
  private recovering = false;
  private replied = false;
  private userEndMs = -1;
  private assistantText = '';
  private handoffEndMs: number | null = null;
  private lastTranscriptSequence = -1;
  private heardOutput = false;
  private activity?: { value: VoiceActivity; at: number };

  constructor(
    private locale: 'ja' | 'en',
    private now: () => number,
  ) {}

  connect(generation: number) {
    this.recovering = this.generation > 0;
    this.generation = generation;
    this.suspend();
    this.replied = false;
    this.userEndMs = -1;
  }

  suspend() {
    this.assistantText = '';
    this.handoffEndMs = null;
    this.activity = undefined;
    this.heardOutput = false;
    this.lastTranscriptSequence = -1;
  }

  transcript(fragment: TranscriptFragment) {
    if (this.delivered || fragment.generation !== this.generation || !fragment.delta.trim()) return;
    if (fragment.speaker === 'user') {
      this.replied = true;
      this.userEndMs = Math.max(this.userEndMs, fragment.endMs);
      // A response after the sign-off doesn't undo the already spoken introduction.
      if (this.handoffEndMs !== null && fragment.startMs >= this.handoffEndMs) return;
      this.assistantText = '';
      this.handoffEndMs = null;
      this.heardOutput = false;
      return;
    }
    if (!this.replied || fragment.endMs <= this.userEndMs) return;
    this.assistantText = (this.assistantText + fragment.delta).slice(-1600);
    this.lastTranscriptSequence = this.activity?.value.sequence ?? -1;
    const text = this.assistantText
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\p{P}\s]/gu, '');
    const handoff =
      this.locale === 'ja'
        ? /(?:詳しく|詳細)(?:は|を)?(?:メッセージ|チャット)で送(?:る|ります|ってお)/u.test(text)
        : /(?:ill|iwill)(?:send|text)(?:you)?(?:the)?details(?:in|ina|via|asa)(?:message|chat|text)/u.test(
            text,
          );
    if (handoff) this.handoffEndMs = fragment.endMs;
  }

  report(value: VoiceActivity) {
    if (
      value.generation !== this.generation ||
      (this.activity && value.sequence <= this.activity.value.sequence)
    )
      return;
    this.activity = { value: { ...value }, at: this.now() };
    if (this.replied && value.playbackReady && value.output === 'active') this.heardOutput = true;
  }

  takeReady() {
    if (this.delivered) return false;
    const activity = this.activity;
    // On reconnect Live resumes the game without repeating the opening. Recover
    // missing information as text; do not claim the interrupted speech completed.
    const ready =
      this.recovering ||
      (this.handoffEndMs !== null &&
        this.heardOutput &&
        activity &&
        activity.value.sequence > this.lastTranscriptSequence &&
        this.now() - activity.at < 2000 &&
        activity.value.playbackReady &&
        activity.value.input === 'quiet' &&
        activity.value.output === 'quiet');
    if (!ready) return false;
    this.delivered = true;
    return true;
  }
}
