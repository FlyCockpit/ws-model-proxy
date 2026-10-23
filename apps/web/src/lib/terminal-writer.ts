import type { TerminalWriterLabel } from "@/lib/terminal-protocol";

/**
 * Writer and size decisions for terminals with several viewers. The CLI decides who
 * the writer is; the browser only mirrors it and follows the PTY size while
 * someone else is typing.
 */

export type TerminalSize = { cols: number; rows: number };

export type TerminalWriterState = {
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
  return state.writer !== "you";
}

/** Only the writer reports its size to the CLI. */
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

/**
 * The smallest size a pane fits to. The writer's size is the PTY size for every viewer, so a
 * squeezed box (a phone with the keyboard open) must not shrink the shell below this.
 */
export const TERMINAL_MIN_COLS = 20;
export const TERMINAL_MIN_ROWS = 5;

export function floorTerminalSize(size: TerminalSize): TerminalSize {
  return {
    cols: Math.max(TERMINAL_MIN_COLS, size.cols),
    rows: Math.max(TERMINAL_MIN_ROWS, size.rows),
  };
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
 * Where a piece of input came from. The session hook's gateway decides at send time, not when
 * the input was made, whether it may go out: `user` input (keys, pastes, mouse) and a ticket's
 * `typed` command wait while Select text is on and take over the writer when needed; a `reply`
 * (xterm's automatic answer to output) only ever goes out from the writer.
 */
export type TerminalInputOrigin = "user" | "typed" | "reply";

/**
 * The replies xterm writes on its own when output asks (one reply per onData call): cursor and
 * status reports (CPR, DSR), device attributes (DA1/DA2), mode reports (DECRPM), window reports
 * (XTWINOPS), DCS answers (DECRQSS, XTVERSION) and OSC answers (color queries). Keys and mouse
 * reports never take these forms, with one exception: a modified F3 is `ESC [ 1 ; m R`, the same
 * bytes as a cursor report. Only its key event tells them apart (`modifiedF3`).
 */
const AUTOMATIC_REPLY =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC and BEL sequences are exactly what this matches.
  /^(?:\x1b\[[?>]?[\d;]*[Rnc]|\x1b\[\??[\d;]*\$y|\x1b\[[\d;]*t|\x1bP[\s\S]*\x1b\\|\x1b\][\s\S]*(?:\x07|\x1b\\))$/;

const MODIFIED_F3 =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the sequence's first byte.
  /^\x1b\[1;\d+R$/;

/** Data xterm generated itself in answer to output, never typed or clicked. */
export function isAutomaticReply(data: string): boolean {
  return isFocusReport(data) || AUTOMATIC_REPLY.test(data);
}

/**
 * The origin of data xterm emits. `modifiedF3`: a modified F3 keydown is being handled right
 * now, so the cursor-report shape it shares is that key, not a reply.
 */
export function terminalDataOrigin(
  data: string,
  modifiedF3 = false,
): Exclude<TerminalInputOrigin, "typed"> {
  if (modifiedF3 && MODIFIED_F3.test(data)) return "user";
  return isAutomaticReply(data) ? "reply" : "user";
}

/**
 * xterm answers some output on its own (focus reports and the replies above). A follower forwards
 * only real input: data that is not a reply, right after a real keydown, paste, composition or
 * click. Timing alone cannot tell a reply that arrives just after a keypress from the key itself,
 * so a reply is never input, whenever it arrives. The writer forwards everything: the program
 * that asked needs its answer.
 */
export function shouldForwardTerminalData(input: {
  following: boolean;
  userInput: boolean;
  data: string;
  modifiedF3?: boolean;
}): boolean {
  if (!input.following) return true;
  if (terminalDataOrigin(input.data, input.modifiedF3) === "reply") return false;
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

  /** Forget earlier input: a new xterm, a new attach, or a hidden pane starts unarmed. */
  disarm(): void {
    this.lastAt = Number.NEGATIVE_INFINITY;
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
