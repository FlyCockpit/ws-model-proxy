/**
 * Bytes for the on-screen keys (Utilities key row): what xterm.js itself sends for the same key
 * on a hardware keyboard, so a program cannot tell the two apart.
 */

export type TerminalKeyModifiers = { ctrl?: boolean; alt?: boolean; shift?: boolean };

/** Keys the key row sends by name (a single character is sent as that character). */
export type TerminalNamedKey =
  | "Esc"
  | "Tab"
  | "Enter"
  | "Space"
  | "Backspace"
  | "Up"
  | "Down"
  | "Left"
  | "Right"
  | "Home"
  | "End"
  | "Insert"
  | "Delete"
  | "PageUp"
  | "PageDown";

/** Cursor keys: `ESC [ x`, `ESC O x` in application cursor mode, `ESC [ 1 ; m x` modified. */
const CURSOR_KEYS: Partial<Record<TerminalNamedKey, string>> = {
  Up: "A",
  Down: "B",
  Right: "C",
  Left: "D",
  Home: "H",
  End: "F",
};
/** `ESC [ n ~`, or `ESC [ n ; m ~` modified. */
const TILDE_KEYS: Partial<Record<TerminalNamedKey, number>> = {
  Insert: 2,
  Delete: 3,
  PageUp: 5,
  PageDown: 6,
};
/** Ctrl with punctuation, as xterm.js maps it (Ctrl+[ is ESC, Ctrl+_ is 0x1f, …). */
const CTRL_PUNCTUATION: Record<string, number> = {
  "@": 0,
  " ": 0,
  "2": 0,
  "[": 27,
  "3": 27,
  "\\": 28,
  "4": 28,
  "]": 29,
  "5": 29,
  "^": 30,
  "6": 30,
  _: 31,
  "-": 31,
  "7": 31,
  "/": 31,
  "?": 127,
  "8": 127,
};

/** The xterm modifier parameter: 1 + Shift 1 + Alt 2 + Ctrl 4. */
function modifierParam(mods: TerminalKeyModifiers): number {
  return 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0);
}

/** The control character for Ctrl+`char`, or null when the character has none. */
export function ctrlCharacter(char: string): string | null {
  const lower = char.toLowerCase();
  if (lower.length === 1 && lower >= "a" && lower <= "z")
    return String.fromCharCode(lower.charCodeAt(0) - 96);
  const code = CTRL_PUNCTUATION[char];
  return code === undefined ? null : String.fromCharCode(code);
}

/**
 * The bytes for `key` (a named key or one character) with `mods`. Alt is an ESC prefix, as in
 * xterm.js; arrows follow application cursor mode (DECCKM) when unmodified.
 */
export type TerminalKeyOptions = {
  /** Arrows send `ESC O x` (DECCKM). */
  applicationCursor?: boolean;
  /**
   * What Ctrl+Enter or Shift+Enter send (the terminal's Shift+Enter setting, as a hardware key
   * does); LF when not given.
   */
  modifiedEnter?: string;
};

export function encodeTerminalKey(
  key: TerminalNamedKey | string,
  mods: TerminalKeyModifiers = {},
  options: TerminalKeyOptions = {},
): string {
  const param = modifierParam(mods);
  const cursor = CURSOR_KEYS[key as TerminalNamedKey];
  if (cursor) {
    if (param === 1) return (options.applicationCursor ? "\x1bO" : "\x1b[") + cursor;
    return `\x1b[1;${param}${cursor}`;
  }
  const tilde = TILDE_KEYS[key as TerminalNamedKey];
  if (tilde !== undefined) return `\x1b[${tilde}${param === 1 ? "" : `;${param}`}~`;
  const esc = mods.alt ? "\x1b" : "";
  switch (key) {
    case "Esc":
      return `${esc}\x1b`;
    case "Tab":
      // xterm.js gives Tab no Alt prefix: Alt+Tab is a plain Tab, Alt+Shift+Tab a back-tab.
      return mods.shift ? "\x1b[Z" : "\t";
    case "Enter":
      if (!mods.ctrl && !mods.shift) return `${esc}\r`;
      // Alt+Ctrl+Enter is ESC CR, as a hardware Alt+Enter (the setting leaves Alt alone).
      return mods.alt ? `${esc}\r` : (options.modifiedEnter ?? "\n");
    case "Backspace":
      return esc + (mods.ctrl ? "\b" : "\x7f");
    case "Space":
      return esc + (mods.ctrl ? "\x00" : " ");
  }
  let char = key;
  if (mods.shift && char.length === 1) char = char.toUpperCase();
  if (mods.ctrl) char = ctrlCharacter(char) ?? char;
  return esc + char;
}

const DATA_CURSOR: Record<string, TerminalNamedKey> = {
  A: "Up",
  B: "Down",
  C: "Right",
  D: "Left",
  H: "Home",
  F: "End",
};
const DATA_TILDE: Record<string, TerminalNamedKey> = {
  "2": "Insert",
  "3": "Delete",
  "5": "PageUp",
  "6": "PageDown",
};

/**
 * The key one chunk of keyboard data stands for, so a latched modifier can be applied to it
 * (phone keyboards often send no usable keydown, only the text). Null when the data is not one
 * key (a mouse report, a multi-character insert, an already modified sequence).
 */
export function terminalDataKey(data: string): TerminalNamedKey | string | null {
  switch (data) {
    case "\r":
      return "Enter";
    case "\x7f":
    case "\b":
      return "Backspace";
    case "\t":
      return "Tab";
    case "\x1b":
      return "Esc";
    case " ":
      return "Space";
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC starts the sequences matched.
  const cursor = /^\x1b[[O]([ABCDHF])$/.exec(data);
  if (cursor?.[1]) return DATA_CURSOR[cursor[1]] ?? null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC starts the sequences matched.
  const tilde = /^\x1b\[(\d)~$/.exec(data);
  if (tilde?.[1]) return DATA_TILDE[tilde[1]] ?? null;
  const chars = Array.from(data);
  if (chars.length === 1 && !data.startsWith("\x1b")) return data;
  return null;
}

/**
 * Keyboard data with latched modifiers applied, or null when they do not apply to it (the data
 * goes out unchanged and the modifiers stay latched). A keyboard that inserts a whole word at once
 * (autocomplete) gives the modifier to the first character.
 */
export function applyTerminalModifiers(
  data: string,
  mods: TerminalKeyModifiers,
  options: TerminalKeyOptions = {},
): string | null {
  if (!mods.ctrl && !mods.alt && !mods.shift) return null;
  const key = terminalDataKey(data);
  if (key !== null) return encodeTerminalKey(key, mods, options);
  if (data.startsWith("\x1b")) return null;
  const [first, ...rest] = Array.from(data);
  if (first === undefined) return null;
  return encodeTerminalKey(first, mods, options) + rest.join("");
}

/**
 * Text for a paste, without bracketed-paste markers: a pasted `ESC [ 201 ~` would end the
 * bracket early and run the rest as typed commands.
 */
export function stripPasteMarkers(text: string): string {
  // One pass, in linear time: a marker is dropped as soon as the kept text ends with one, so
  // taking out one marker can never join the text around it into another (`ESC [ 20` + marker
  // + `1 ~`), however deeply they nest.
  const kept: string[] = [];
  for (const char of text) {
    kept.push(char);
    if (char !== "~") continue;
    const end = kept.length;
    if (kept[end - 2] !== "0" && kept[end - 2] !== "1") continue;
    if (kept[end - 3] !== "0" || kept[end - 4] !== "2") continue;
    if (kept[end - 5] === "\x9b") kept.length = end - 5;
    else if (kept[end - 5] === "[" && kept[end - 6] === "\x1b") kept.length = end - 6;
  }
  return kept.join("");
}

/** The keys in the hold-Ctrl / hold-Alt grid, in order. */
export const TERMINAL_HOLD_GRID_KEYS = [
  ..."abcdefghijklmnopqrstuvwxyz",
  "[",
  "\\",
  "]",
  "_",
  "@",
  ".",
  "/",
] as const;

/** Short hints under grid keys (locale keys under `terminals:keys.hints`). */
export const TERMINAL_HOLD_GRID_HINTS: Record<"ctrl" | "alt", Record<string, string>> = {
  ctrl: {
    a: "home",
    c: "stop",
    d: "eof",
    e: "end",
    k: "kill",
    l: "clear",
    r: "search",
    u: "killLine",
    w: "word",
    z: "suspend",
  },
  alt: { b: "wordBack", f: "wordForward", d: "deleteWord", ".": "lastArg" },
};
