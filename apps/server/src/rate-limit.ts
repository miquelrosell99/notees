/**
 * In-memory fixed-window rate limiter (per WIRE.md §3 and v1
 * app/rate_limit.py). Single-process M1: counters live in process memory,
 * keyed by caller-supplied strings. Not persisted.
 */

interface Window {
  windowStartMs: number;
  count: number;
}

export class FixedWindowLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly windowMs: number = 60_000) {}

  /**
   * Try to charge ``weight`` against ``key``. Returns true when the charge
   * fits the limit, false when the window is exhausted.
   */
  tryAcquire(key: string, weight: number, limit: number): boolean {
    const now = Date.now();
    let entry = this.windows.get(key);
    if (entry === undefined || now - entry.windowStartMs >= this.windowMs) {
      entry = { windowStartMs: now, count: 0 };
      this.windows.set(key, entry);
    }
    if (entry.count + weight > limit) return false;
    entry.count += weight;
    return true;
  }

  /** Housekeeping for long-lived processes (tests call this explicitly). */
  prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.windows) {
      if (now - entry.windowStartMs >= this.windowMs) this.windows.delete(key);
    }
  }
}
