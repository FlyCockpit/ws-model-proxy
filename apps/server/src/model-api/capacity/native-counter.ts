import type { ContextCount, ContextCounter } from "./context.js";

export type NativeCountRequest = (input: unknown, signal: AbortSignal) => Promise<number | null>;

/**
 * Counter adapter for a target's native count endpoint. The supplied request
 * function is intentionally below routing/admission: callers must relay the
 * count operation directly to the already-selected target, preventing
 * recursion and ensuring no capacity lease is acquired for counting itself.
 */
export class NativeContextCounter implements ContextCounter {
  constructor(
    private readonly supported: boolean,
    private readonly requestCount: NativeCountRequest,
    private readonly timeoutMs = 5_000,
  ) {}

  async count(input: unknown, signal?: AbortSignal): Promise<ContextCount | null> {
    if (!this.supported || signal?.aborted) {
      if (signal?.aborted) throw signal.reason;
      return null;
    }
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const tokens = await this.requestCount(input, combined);
      if (tokens === null) return null;
      if (!Number.isSafeInteger(tokens) || tokens < 0) return null;
      return { tokens, method: "NATIVE", exact: true };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      // Unsupported/malformed/upstream count failures safely fall through to
      // template/token estimates; no inference request has been dispatched.
      return null;
    }
  }
}
