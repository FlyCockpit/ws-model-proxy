import type { ITheme } from "@xterm/xterm";
import type { CSSProperties } from "react";

/** The terminal is dark in both site themes. */
export const TERMINAL_THEME: ITheme = {
  background: "#0e1116",
  foreground: "#d6dae0",
  cursor: "#e6e9ee",
  cursorAccent: "#0e1116",
  selectionBackground: "#3a4a6399",
  black: "#1b1f26",
  red: "#f07178",
  green: "#a6d189",
  yellow: "#e5c07b",
  blue: "#6cb6ff",
  magenta: "#d2a8ff",
  cyan: "#56d4dd",
  white: "#c9d1d9",
  brightBlack: "#6e7681",
  brightRed: "#ff8b92",
  brightGreen: "#b9e3a0",
  brightYellow: "#f2d492",
  brightBlue: "#8fcaff",
  brightMagenta: "#e2c2ff",
  brightCyan: "#7ee6ee",
  brightWhite: "#f0f3f6",
};

export const TERMINAL_FONT_FAMILY =
  '"JetBrains Mono", "Cascadia Code", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/**
 * Colors for the chrome around the terminal (tabs, notices, status bar), as
 * CSS variables for Tailwind arbitrary values like `bg-(--term-chrome)`.
 */
export const TERMINAL_CHROME_VARS = {
  "--term-bg": "#0e1116",
  "--term-chrome": "#161a20",
  "--term-shade": "#080a0d",
  "--term-border": "#262b33",
  "--term-fg": "#d6dae0",
  "--term-muted": "#8b949e",
  "--term-hover": "#1f242c",
} as CSSProperties;
