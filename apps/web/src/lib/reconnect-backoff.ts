/**
 * The reconnect backoff shared by the browser's long-lived connections (the terminal socket,
 * `hooks/use-terminal-socket.ts`, and the node live updates stream,
 * `hooks/use-node-live-updates.ts`). Pure: the callers own the timers.
 *
 * The delay starts at {@link RECONNECT_BASE_MS} and doubles per failed attempt up to
 * {@link RECONNECT_MAX_MS}, plus up to {@link RECONNECT_JITTER_MS} of jitter so that tabs a
 * deploy dropped together do not come back together.
 *
 * Opening alone does not reset it: a server that accepts and then closes at once (a refused
 * admission, a close right after a reconnect burst) would otherwise be retried every half
 * second forever. Only a connection that stayed open for the caller's stable time resets it.
 */

export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 15_000;
export const RECONNECT_JITTER_MS = 250;

/** The delay before reconnect attempt `attempt` (0: the first after a drop). */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  return (
    Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt) +
    Math.floor(random() * RECONNECT_JITTER_MS)
  );
}

/** How many reconnects have failed in a row (since the last stable connection). */
export type ReconnectBackoff = { readonly attempt: number };

export const INITIAL_RECONNECT_BACKOFF: ReconnectBackoff = { attempt: 0 };

export type ReconnectPlan = {
  /** Wait this long before the next attempt. */
  delayMs: number;
  /** The backoff to keep for the attempt after that. */
  backoff: ReconnectBackoff;
};

/**
 * A connection ended: when to try again, and the backoff after that try.
 *
 * `openedForMs`: how long it was open, or null when it never opened (a refused or failed
 * attempt). At least `stableMs` resets the backoff first, so the next try is a fast one.
 */
export function planReconnect(
  backoff: ReconnectBackoff,
  openedForMs: number | null,
  stableMs: number,
  random: () => number = Math.random,
): ReconnectPlan {
  const attempt = openedForMs !== null && openedForMs >= stableMs ? 0 : backoff.attempt;
  return { delayMs: reconnectDelayMs(attempt, random), backoff: { attempt: attempt + 1 } };
}
