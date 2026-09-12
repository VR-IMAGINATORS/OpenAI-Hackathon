export class GameClock {
  private last: number;
  private running = false;
  private reasons = new Set<string>();
  remainingMs: number;
  waitingRemainingMs = 60_000;
  constructor(
    seconds: number,
    private now: () => number = () => performance.now(),
  ) {
    this.remainingMs = seconds * 1000;
    this.last = now();
  }
  tick() {
    const now = this.now();
    const elapsed = Math.max(0, now - this.last);
    this.last = now;
    if (this.running) {
      if (this.reasons.size)
        this.waitingRemainingMs = Math.max(0, this.waitingRemainingMs - elapsed);
      else this.remainingMs = Math.max(0, this.remainingMs - elapsed);
    }
  }
  start() {
    this.tick();
    this.running = true;
  }
  pause(reason: string) {
    this.tick();
    this.reasons.add(reason);
  }
  resume(reason: string) {
    this.tick();
    this.reasons.delete(reason);
  }
  stop() {
    this.tick();
    this.running = false;
  }
  get paused() {
    return this.reasons.size > 0;
  }
}
