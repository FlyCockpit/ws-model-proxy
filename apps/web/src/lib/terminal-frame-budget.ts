import {
  TERMINAL_BROWSER_BINARY_BUDGET,
  TERMINAL_BROWSER_BINARY_WINDOW_MS,
} from "@ws-model-proxy/config/terminal-socket-policy";

/**
 * One tab's sealed frames, paced to the relay's per-terminal limit: at most
 * `TERMINAL_BROWSER_BINARY_BUDGET` per window, counting every frame that reached the socket. It
 * outlives an attach, since a reattach on the same socket shares the relay's count. The window
 * runs on the monotonic clock, so a wall-clock step cannot stall it.
 */
export class TerminalFrameBudget {
  /** `performance.now()` of each frame sent in the current window, oldest first. */
  private readonly sentAt: number[] = [];

  constructor(
    private readonly budget = TERMINAL_BROWSER_BINARY_BUDGET,
    private readonly windowMs = TERMINAL_BROWSER_BINARY_WINDOW_MS,
  ) {}

  /** Milliseconds until `count` more frames fit in the window; 0 when they fit now. */
  waitFor(count: number, now: number): number {
    // At most `budget` stamps are kept, so this is a bounded scan.
    while (this.sentAt.length > 0 && now - (this.sentAt[0] ?? now) >= this.windowMs) {
      this.sentAt.shift();
    }
    const over = this.sentAt.length + Math.min(count, this.budget) - this.budget;
    if (over <= 0) return 0;
    return Math.max(1, (this.sentAt[over - 1] ?? now) + this.windowMs - now);
  }

  /** A frame reached the socket. */
  record(now: number): void {
    this.sentAt.push(now);
  }
}
