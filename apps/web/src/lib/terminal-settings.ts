import { z } from "zod";

/**
 * How a copy request from a program in the terminal (OSC 52) reaches the clipboard. An enum, not
 * a boolean, so later choices (for example per-node trust) need no stored-type change.
 */
export const TERMINAL_COPY_MODES = ["prompt", "auto", "off"] as const;
export type TerminalCopyMode = (typeof TERMINAL_COPY_MODES)[number];
export const DEFAULT_TERMINAL_COPY_MODE: TerminalCopyMode = "prompt";

/** What Shift+Enter (and Ctrl+Enter) send: LF, ESC CR, or the default CR. */
export const TERMINAL_SHIFT_ENTER_MODES = ["lf", "esc-cr", "off"] as const;
export type TerminalShiftEnterMode = (typeof TERMINAL_SHIFT_ENTER_MODES)[number];
export const DEFAULT_TERMINAL_SHIFT_ENTER_MODE: TerminalShiftEnterMode = "lf";

export type TerminalSettings = {
  terminalCopy: TerminalCopyMode;
  terminalShiftEnter: TerminalShiftEnterMode;
  terminalMaximized: boolean;
};

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  terminalCopy: DEFAULT_TERMINAL_COPY_MODE,
  terminalShiftEnter: DEFAULT_TERMINAL_SHIFT_ENTER_MODE,
  terminalMaximized: false,
};

const terminalSettingsSchema = z.object({
  terminalCopy: z.enum(TERMINAL_COPY_MODES).catch(DEFAULT_TERMINAL_COPY_MODE),
  terminalShiftEnter: z.enum(TERMINAL_SHIFT_ENTER_MODES).catch(DEFAULT_TERMINAL_SHIFT_ENTER_MODE),
  terminalMaximized: z.boolean().catch(false),
});

/** Stored settings from localStorage: each missing or unknown value falls back to its default. */
export function parseTerminalSettings(value: unknown): TerminalSettings {
  const record = typeof value === "object" && value !== null ? value : {};
  return terminalSettingsSchema.parse(record);
}

export function isTerminalCopyMode(value: unknown): value is TerminalCopyMode {
  return TERMINAL_COPY_MODES.some((mode) => mode === value);
}

export function isTerminalShiftEnterMode(value: unknown): value is TerminalShiftEnterMode {
  return TERMINAL_SHIFT_ENTER_MODES.some((mode) => mode === value);
}
