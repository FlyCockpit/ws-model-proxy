/**
 * Text (JSON) frames the relay accepts from one browser terminal socket per
 * sliding window. A frame past the limit is refused with `rate_limited`.
 */
export const TERMINAL_BROWSER_JSON_LIMIT = 20;
export const TERMINAL_BROWSER_JSON_WINDOW_MS = 10_000;

/**
 * What the browser sends per window (by its own clock). Lower than the
 * relay's limit so frames the network delivers closer together than they
 * were sent (a stall, then a burst) still fit. A reconnect sends a list plus
 * an attach and an auth per tab, and each tab's pending Decline again, which
 * can exceed this; the rest wait their turn instead of being refused. User
 * intents (close, decline, detach) leave before waiting lists, opens,
 * attaches and auths. A waiting frame is dropped if its socket closes, so the
 * browser keeps each End session and Decline itself until the relay answers
 * it, and sends it again on the next socket.
 */
export const TERMINAL_BROWSER_JSON_BUDGET = 16;
