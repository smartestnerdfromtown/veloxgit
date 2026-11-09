/**
 * Exponential-backoff timer for pushes that failed while offline. The
 * callback decides whether a retry is still needed; `schedule()` never
 * stacks more than one pending timer.
 */
export class PushRetryTimer {
  private timer: number | null = null;
  private delay: number;

  constructor(
    private readonly retry: () => void,
    private readonly baseMs = 5_000,
    private readonly maxMs = 60_000,
  ) {
    this.delay = baseMs;
  }

  get isScheduled(): boolean {
    return this.timer !== null;
  }

  schedule(): void {
    if (this.timer !== null) return;

    const delay = this.delay;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.retry();
    }, delay);

    this.delay = Math.min(delay * 2, this.maxMs);
  }

  cancel(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.delay = this.baseMs;
  }
}
