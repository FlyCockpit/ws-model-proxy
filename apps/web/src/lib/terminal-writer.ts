import type { TerminalWriterLabel } from "@/lib/terminal-protocol";

/**
 * Writer and size decisions for multi-viewer terminals. The CLI decides who
 * the writer is; the browser only mirrors it and follows the PTY size while
 * someone else is typing.
 */

export type TerminalSize = { cols: number; rows: number };

export type TerminalWriterState = {
  /** Protocol 2.5 terminal (v2 crypto). A 2.4 terminal has one viewer, always the writer. */
  multiViewer: boolean;
  writer: TerminalWriterLabel;
};

/** Debounce for the writer's own resizes. */
export const TERMINAL_RESIZE_DEBOUNCE_MS = 100;
/** How long a real keydown, paste, composition or click lets terminal data through. */
export const TERMINAL_USER_INPUT_WINDOW_MS = 500;
/** Broadcast frames held for an epoch whose key has not arrived yet. */
export const TERMINAL_FUTURE_EPOCH_QUEUE = 64;
const REATTACH_BASE_MS = 500;
const REATTACH_MAX_MS = 15_000;
/** A slow detach this long after the previous one starts the backoff over. */
export const TERMINAL_REATTACH_RESET_MS = 60_000;

/** A non-writer renders at the PTY size and sends no resizes. */
export function isFollowing(state: TerminalWriterState): boolean {
  return state.multiViewer && state.writer !== "you";
}

/** Only the writer (or a 2.4 viewer) reports its size to the CLI. */
export function canSendResize(state: TerminalWriterState): boolean {
  return !isFollowing(state);
}

/** A follower's first real input claims the writer: resize first, then data. */
export function needsTakeover(state: TerminalWriterState): boolean {
  return isFollowing(state);
}

/** The size a follower's xterm should show, or null to fit its own box. */
export function followSize(
  state: TerminalWriterState & { ptyCols: number | null; ptyRows: number | null },
): TerminalSize | null {
  if (!isFollowing(state) || state.ptyCols === null || state.ptyRows === null) return null;
  return { cols: state.ptyCols, rows: state.ptyRows };
}

export function sameSize(a: TerminalSize | null | undefined, b: TerminalSize | null | undefined) {
  return !!a && !!b && a.cols === b.cols && a.rows === b.rows;
}

const FOCUS_REPORTS = new Set(["\x1b[I", "\x1b[O"]);

/** Focus in/out reports (`ESC[I` / `ESC[O`) are never user input. */
export function isFocusReport(data: string): boolean {
  return FOCUS_REPORTS.has(data);
}

/**
 * xterm answers some output on its own (DSR/CPR, DA, focus reports). A follower
 * forwards data only right after real user input, so those replies cannot
 * steal the writer.
 */
export function shouldForwardTerminalData(input: {
  following: boolean;
  userInput: boolean;
  data: string;
}): boolean {
  if (!input.following) return true;
  if (isFocusReport(input.data)) return false;
  return input.userInput;
}

/** Records real user input (keydown, paste, composition, a click in mouse mode). */
export class TerminalUserInputGate {
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly windowMs = TERMINAL_USER_INPUT_WINDOW_MS) {}

  arm(nowMs: number): void {
    this.lastAt = nowMs;
  }

  armed(nowMs: number): boolean {
    const elapsed = nowMs - this.lastAt;
    return elapsed >= 0 && elapsed <= this.windowMs;
  }
}

/** Backoff before re-attaching after `detached {reason: "slow"}`. */
export function reattachDelayMs(attempt: number): number {
  return Math.min(REATTACH_MAX_MS, REATTACH_BASE_MS * 2 ** Math.max(0, attempt));
}

export type ReattachState = { attempt: number; lastAt: number };

/** Next backoff step. A detach long after the last one starts over. */
export function nextReattach(
  previous: ReattachState | undefined,
  nowMs: number,
): { delayMs: number; state: ReattachState } {
  const attempt =
    previous && nowMs - previous.lastAt < TERMINAL_REATTACH_RESET_MS ? previous.attempt + 1 : 0;
  return { delayMs: reattachDelayMs(attempt), state: { attempt, lastAt: nowMs } };
}

/**
 * Broadcast frame routing for the shared output key. `current` is the epoch
 * this viewer holds, or null before the first key.
 */
export function classifyBroadcastEpoch(
  current: number | null,
  epoch: number,
): "open" | "queue" | "drop" {
  if (current === null || epoch > current) return "queue";
  return epoch === current ? "open" : "drop";
}

/** Status line key for the writer label. */
export function writerStatusKey(writer: TerminalWriterLabel): string | null {
  if (writer === "you") return "dashboard:terminals.status.youTyping";
  if (writer === "other") return "dashboard:terminals.status.otherTyping";
  return null;
}
