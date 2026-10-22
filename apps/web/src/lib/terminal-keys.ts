import type { TerminalShiftEnterMode } from "@/lib/terminal-settings";

export type TerminalKeyEvent = {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
};

const NEWLINE_SEQUENCES: Record<Exclude<TerminalShiftEnterMode, "off">, string> = {
  lf: "\n",
  "esc-cr": "\u001b\r",
};

/**
 * The bytes Shift+Enter or Ctrl+Enter send instead of xterm's plain CR, or null to leave the key
 * to xterm. xterm.js has no kitty or modifyOtherKeys support, so both keys otherwise send `\r`
 * like Enter. Alt+Enter (already ESC CR) and Meta/Cmd+Enter (browser and OS) are not touched.
 */
export function newlineSequence(
  mode: TerminalShiftEnterMode,
  event: TerminalKeyEvent,
): string | null {
  if (mode === "off" || event.key !== "Enter" || event.isComposing) return null;
  if (event.altKey || event.metaKey || event.shiftKey === event.ctrlKey) return null;
  return NEWLINE_SEQUENCES[mode];
}
