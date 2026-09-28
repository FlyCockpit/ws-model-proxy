/**
 * The command-output text an MCP agent sees, shared by the server (headless
 * exec and shared supervised output) and the browser (the supervised-command
 * output review dialog shows exactly this text before anything is sent).
 *
 * Pure and dependency-free so both the Node server and the browser bundle use
 * the same bytes-to-text rules.
 */

/**
 * Per-stream view the model sees. `totalBytes` is the full stream count.
 * `text` is lossy UTF-8 of the retained head and tail, with credential
 * substrings removed. Other secrets are not redacted.
 */
export type CliStreamText = {
  text: string;
  truncated: boolean;
  totalBytes: number;
};

/** Retained bytes of one output stream: the first bytes and the last bytes. */
export type BoundedByteView = {
  head: Uint8Array;
  tail: Uint8Array;
  totalBytes: number;
};

/** First bytes retained per stream (the runtime cap). */
export const CLI_STREAM_HEAD_MAX_BYTES = 8192;
/** Last bytes retained per stream once the stream is truncated (the runtime cap). */
export const CLI_STREAM_TAIL_MAX_BYTES = 40960;

/**
 * Marker between the retained head and tail when bytes in the middle were
 * dropped. Kept short so the wrapped tool result stays inside the MCP cap.
 */
export const CLI_OUTPUT_ELLIPSIS = "\n…\n";

/**
 * Product credential prefixes removed from command output. Must equal the
 * values of `PRODUCT_CREDENTIAL_PREFIXES` in `@ws-model-proxy/db/forwarder-security`
 * (a server test pins that); duplicated here because that module is Node-only.
 */
export const CLI_OUTPUT_CREDENTIAL_PREFIXES: readonly string[] = [
  "wsmp_model_",
  "wsmp_cli_",
  "wsmp_device_",
  "wsmp_mcp_",
];

/** Same marker the key/prefix redactor uses, so the two layers read alike. */
const REDACTED = "[redacted]";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CREDENTIAL_SUBSTRING = new RegExp(
  `(?:${CLI_OUTPUT_CREDENTIAL_PREFIXES.map(escapeRegex).join("|")})[A-Za-z0-9_-]+`,
  "g",
);

/** Replace credential substrings anywhere in the text, not only whole values. */
export function redactCredentialSubstrings(text: string): string {
  const replaced = text.replace(CREDENTIAL_SUBSTRING, REDACTED);
  return neutralizeLeadingPrefixes(replaced);
}

/**
 * A leftover prefix with no credential body does not match the substring
 * regex, but the downstream whole-value redactor would blank the entire
 * field if the text still starts with one. Peel those leading prefixes so
 * the rest of the output survives.
 */
function neutralizeLeadingPrefixes(text: string): string {
  let next = text;
  for (let guard = 0; guard < CLI_OUTPUT_CREDENTIAL_PREFIXES.length; guard += 1) {
    const prefix = CLI_OUTPUT_CREDENTIAL_PREFIXES.find((candidate) => next.startsWith(candidate));
    if (prefix === undefined) return next;
    next = `${REDACTED}${next.slice(prefix.length)}`;
  }
  return next;
}

function decodeLossy(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/** Drop C0/C1 controls except tab, LF, and CR. */
function stripDisallowedControls(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out += text[index] ?? "";
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    out += text[index] ?? "";
  }
  return out;
}

/**
 * Parser states of the VT500 escape-sequence parser (vt100.net
 * dec_ansi_parser), the model xterm.js — the web terminal — implements in
 * `EscapeSequenceParser`. Stripping follows the same transitions so the text
 * kept is the text the terminal prints: a sequence the terminal hides is never
 * shown to the model, and an ESC, CAN/SUB, or C1 introducer that cancels a
 * sequence midway starts the next one exactly where the terminal starts it.
 */
const GROUND = 0;
const ESCAPE = 1;
const ESCAPE_INTERMEDIATE = 2;
const CSI_ENTRY = 3;
const CSI_PARAM = 4;
const CSI_INTERMEDIATE = 5;
const CSI_IGNORE = 6;
const OSC_STRING = 7;
/** SOS, PM and APC bodies. */
const IGNORED_STRING = 8;
const DCS_ENTRY = 9;
const DCS_PARAM = 10;
const DCS_INTERMEDIATE = 11;
const DCS_IGNORE = 12;
const DCS_PASSTHROUGH = 13;

/** States in which the terminal executes a C0 control such as LF, CR or tab. */
function executesC0(state: number): boolean {
  return state <= CSI_IGNORE;
}

/** C0 controls the parser executes (or, inside strings, ignores) in place. */
function isExecutable(code: number): boolean {
  return code <= 0x17 || code === 0x19 || (code >= 0x1c && code <= 0x1f);
}

/**
 * The state after an ESC, CAN, SUB or C1 control, which act the same in every
 * state ("anywhere" transitions); null for any other code.
 */
function anywhereTransition(code: number): number | null {
  if (code === 0x1b) return ESCAPE;
  if (code === 0x18 || code === 0x1a) return GROUND;
  if (code < 0x80 || code > 0x9f) return null;
  if (code === 0x90) return DCS_ENTRY;
  if (code === 0x9b) return CSI_ENTRY;
  if (code === 0x9d) return OSC_STRING;
  if (code === 0x98 || code === 0x9e || code === 0x9f) return IGNORED_STRING;
  // ST and every other C1 control end any sequence.
  return GROUND;
}

/** The state after a printable byte (0x20-0x7e) outside GROUND. */
function printableTransition(state: number, code: number): number {
  switch (state) {
    case ESCAPE:
      if (code <= 0x2f) return ESCAPE_INTERMEDIATE;
      if (code === 0x5b) return CSI_ENTRY;
      if (code === 0x5d) return OSC_STRING;
      if (code === 0x50) return DCS_ENTRY;
      if (code === 0x58 || code === 0x5e || code === 0x5f) return IGNORED_STRING;
      return GROUND;
    case ESCAPE_INTERMEDIATE:
      return code <= 0x2f ? ESCAPE_INTERMEDIATE : GROUND;
    case CSI_ENTRY:
    case CSI_PARAM:
      if (code >= 0x40) return GROUND;
      if (code <= 0x2f) return CSI_INTERMEDIATE;
      if (code >= 0x3c) return state === CSI_ENTRY ? CSI_PARAM : CSI_IGNORE;
      return CSI_PARAM;
    case CSI_INTERMEDIATE:
      if (code >= 0x40) return GROUND;
      return code <= 0x2f ? CSI_INTERMEDIATE : CSI_IGNORE;
    case CSI_IGNORE:
      return code >= 0x40 ? GROUND : CSI_IGNORE;
    case DCS_ENTRY:
    case DCS_PARAM:
      if (code >= 0x40) return DCS_PASSTHROUGH;
      if (code <= 0x2f) return DCS_INTERMEDIATE;
      if (code >= 0x3c) return state === DCS_ENTRY ? DCS_PARAM : DCS_IGNORE;
      return DCS_PARAM;
    case DCS_INTERMEDIATE:
      if (code >= 0x40) return DCS_PASSTHROUGH;
      return code <= 0x2f ? DCS_INTERMEDIATE : DCS_IGNORE;
    default:
      // OSC, SOS/PM/APC, DCS ignore and passthrough bodies run to their end.
      return state;
  }
}

/**
 * The state after a non-ASCII printable (U+00A0 and above) outside GROUND.
 * Inside an escape or CSI the terminal abandons the sequence and drops the
 * character. Inside a DCS header or an SOS/PM/APC body xterm.js does the same,
 * but other terminals keep consuming to the terminator; this keeps consuming,
 * so text a terminal might hide is never kept.
 */
function nonAsciiTransition(state: number): number {
  if (state === CSI_IGNORE || state >= OSC_STRING) {
    return state === DCS_ENTRY || state === DCS_PARAM || state === DCS_INTERMEDIATE
      ? DCS_IGNORE
      : state;
  }
  return GROUND;
}

/** The parser state after one code point (or UTF-16 code unit of one). */
function nextState(state: number, code: number): number {
  const anywhere = anywhereTransition(code);
  if (anywhere !== null) return anywhere;
  if (isExecutable(code)) return state === OSC_STRING && code === 0x07 ? GROUND : state;
  // DEL is ignored in every state.
  if (code === 0x7f) return state;
  if (state === GROUND) return GROUND;
  return code >= 0xa0 ? nonAsciiTransition(state) : printableTransition(state, code);
}

/** `nextState` for every state and ASCII byte, at `(state << 7) | byte`. */
const ASCII_TRANSITIONS = (() => {
  const table = new Uint8Array((DCS_PASSTHROUGH + 1) * 0x80);
  for (let state = 0; state <= DCS_PASSTHROUGH; state += 1) {
    for (let byte = 0; byte < 0x80; byte += 1) table[(state << 7) | byte] = nextState(state, byte);
  }
  return table;
})();

/**
 * Removes terminal escape sequences, 7-bit and 8-bit (C1) forms — CSI, OSC,
 * the control strings DCS, SOS, PM and APC, and other escapes — including a
 * sequence cut off at the end of the text, which is dropped whole. The text
 * kept is what the terminal would print, plus the C0 controls it executes
 * (tab, LF and CR survive the later control filter).
 */
function stripTerminalSequences(text: string): string {
  let out = "";
  let state = GROUND;
  let runStart = -1;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const printable = (code >= 0x20 && code <= 0x7e) || code >= 0xa0;
    if (state === GROUND && printable) {
      if (runStart < 0) runStart = index;
      continue;
    }
    if (runStart >= 0) {
      out += text.slice(runStart, index);
      runStart = -1;
    }
    if (isExecutable(code) && executesC0(state)) out += text[index] ?? "";
    state = nextState(state, code);
    // The terminal reads code points: an astral character is one input, so
    // its low surrogate goes with the high one instead of printing alone.
    const next = text.charCodeAt(index + 1);
    if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) index += 1;
  }
  if (runStart >= 0) out += text.slice(runStart);
  return out;
}

/**
 * Follows the terminal parser (and a UTF-8 decoder, as TextDecoder decodes)
 * across the bytes a bounded capture drops from the front of its rolling
 * tail. A capture drops bytes until {@link atBoundary}, so its tail always
 * starts where the terminal is in its ground state on a whole character:
 * parsing the tail on its own then keeps exactly what parsing the whole
 * stream keeps from that point. Without it, a tail that starts inside a DCS,
 * APC, PM or OSC body would show that hidden body as text.
 *
 * The Rust CLI's capture (`apps/cli/src/terminal_parse.rs`) implements the
 * same rules for supervised output.
 */
export class TerminalByteState {
  private state = GROUND;
  private needed = 0;
  private seen = 0;
  private codePoint = 0;
  private lower = 0x80;
  private upper = 0xbf;

  /** True in the ground state with no partial character pending. */
  get atBoundary(): boolean {
    return this.state === GROUND && this.needed === 0;
  }

  /** Feeds one byte (WHATWG UTF-8 decoding, U+FFFD for invalid input). */
  feed(byte: number): void {
    if (this.needed === 0) {
      if (byte <= 0x7f) this.state = nextState(this.state, byte);
      else if (byte >= 0xc2 && byte <= 0xdf) this.start(1, byte & 0x1f);
      else if (byte >= 0xe0 && byte <= 0xef) {
        if (byte === 0xe0) this.lower = 0xa0;
        if (byte === 0xed) this.upper = 0x9f;
        this.start(2, byte & 0x0f);
      } else if (byte >= 0xf0 && byte <= 0xf4) {
        if (byte === 0xf0) this.lower = 0x90;
        if (byte === 0xf4) this.upper = 0x8f;
        this.start(3, byte & 0x07);
      } else this.state = nextState(this.state, 0xfffd);
      return;
    }
    if (byte < this.lower || byte > this.upper) {
      // The partial character is invalid: it decodes to U+FFFD, and this
      // byte starts over.
      this.reset();
      this.state = nextState(this.state, 0xfffd);
      this.feed(byte);
      return;
    }
    this.lower = 0x80;
    this.upper = 0xbf;
    this.codePoint = (this.codePoint << 6) | (byte & 0x3f);
    this.seen += 1;
    if (this.seen === this.needed) {
      const codePoint = this.codePoint;
      this.reset();
      this.state = nextState(this.state, codePoint);
    }
  }

  /**
   * Feeds `bytes[from…]` while the index is below `dropUntil` or the parser is
   * not at a boundary; returns the first index not fed. Same result as
   * {@link feed} per byte, but it runs on the server's event loop for every
   * byte of headless output, so it jumps over runs that cannot change the
   * state with native `indexOf`: in the ground state only ESC or a C1 control
   * (`C2 80..9F`) leaves it; inside an OSC, SOS/PM/APC or DCS body only ESC,
   * CAN, SUB, a C1 control or (OSC) BEL ends it. Both ESC and `C2` always
   * start a new character, so the UTF-8 decoder has nothing pending there.
   * Escape and CSI headers are short and go through a lookup table.
   */
  consume(bytes: Uint8Array, from: number, dropUntil: number): number {
    const length = bytes.length;
    const next = new NextByte(bytes);
    let index = from;
    let state = this.state;
    while (index < length) {
      if (this.needed === 0) {
        if (state === GROUND) {
          if (index >= dropUntil) break;
          // A short run is cheaper to scan here than through `indexOf`.
          let stop = index;
          const near = Math.min(length, index + 32);
          while (stop < near && bytes[stop] !== 0x1b && bytes[stop] !== 0xc2) stop += 1;
          if (stop === near && near < length) {
            stop = Math.min(next.after(0x1b, near), next.after(0xc2, near));
          }
          stop = charStop(bytes, stop);
          if (stop > index) {
            if (stop < dropUntil) {
              index = stop;
              continue;
            }
            // Nothing leaves the ground state before the cut: jump to the
            // start of the character that holds the cut (at most 3 bytes
            // back; a continuation byte never starts one) and feed from there.
            index = Math.max(index, characterStart(bytes, dropUntil));
            if (index >= dropUntil) break;
          }
        } else if (state >= OSC_STRING && state !== DCS_ENTRY && state !== DCS_PARAM) {
          if (state !== DCS_INTERMEDIATE) {
            let stop = Math.min(
              next.after(0x1b, index),
              next.after(0xc2, index),
              next.after(0x18, index),
              next.after(0x1a, index),
            );
            if (state === OSC_STRING) stop = Math.min(stop, next.after(0x07, index));
            stop = charStop(bytes, stop);
            if (stop > index) {
              index = stop;
              continue;
            }
          }
        }
        let byte = bytes[index] as number;
        if (byte < 0x80) {
          state = ASCII_TRANSITIONS[(state << 7) | byte] as number;
          index += 1;
          // An escape or CSI header: step through its ASCII in one tight loop.
          while (index < length && state !== GROUND && state < OSC_STRING) {
            byte = bytes[index] as number;
            if (byte >= 0x80) break;
            state = ASCII_TRANSITIONS[(state << 7) | byte] as number;
            index += 1;
          }
          continue;
        }
        if (byte === 0xc2) {
          const second = bytes[index + 1];
          if (second !== undefined && second >= 0x80 && second <= 0x9f) {
            // A C1 control (U+0080..U+009F), which acts the same in every state.
            state = anywhereTransition(second) ?? GROUND;
            index += 2;
            continue;
          }
        }
        const size = nonC1CharacterLength(bytes, index);
        if (size > 0) {
          if (state !== GROUND) state = nonAsciiTransition(state);
          index += size;
          continue;
        }
      }
      this.state = state;
      this.feed(bytes[index] as number);
      state = this.state;
      index += 1;
    }
    this.state = state;
    return index;
  }

  private start(needed: number, bits: number): void {
    this.needed = needed;
    this.codePoint = bits;
  }

  private reset(): void {
    this.needed = 0;
    this.seen = 0;
    this.codePoint = 0;
    this.lower = 0x80;
    this.upper = 0xbf;
  }
}

/**
 * A capture's rolling tail after appending `chunk`: at most `max` bytes, then
 * advanced further while `state` is not at a boundary, so it starts where the
 * terminal parser is in its ground state (see {@link TerminalByteState}).
 * Every byte dropped from the front goes through `state`, in stream order.
 */
export function appendRollingTail(
  tail: Uint8Array,
  chunk: Uint8Array,
  max: number,
  state: TerminalByteState,
): Uint8Array {
  const mustDrop = Math.max(0, tail.length + chunk.length - max);
  // The dropped prefix is fed in stream order: the old tail, then the chunk.
  const fromTail = state.consume(tail, 0, mustDrop);
  if (fromTail < tail.length) {
    const out = new Uint8Array(tail.length - fromTail + chunk.length);
    out.set(tail.subarray(fromTail), 0);
    out.set(chunk, tail.length - fromTail);
    return out;
  }
  return chunk.slice(state.consume(chunk, 0, mustDrop - tail.length));
}

/** Where the next occurrence of each byte value is, found once per value and position. */
class NextByte {
  private readonly found = new Int32Array(0x100).fill(-1);

  constructor(private readonly bytes: Uint8Array) {}

  /** The first index at or after `from` holding `value`, or the length. */
  after(value: number, from: number): number {
    const cached = this.found[value] as number;
    if (cached >= from) return cached;
    const at = this.bytes.indexOf(value, from);
    const position = at < 0 ? this.bytes.length : at;
    this.found[value] = position;
    return position;
  }
}

/**
 * A jump target: an ESC or `C2` found by `indexOf` always starts a character,
 * but the end of the bytes may fall inside one, whose bytes must then go
 * through the decoder.
 */
function charStop(bytes: Uint8Array, stop: number): number {
  return stop === bytes.length ? characterStart(bytes, stop) : stop;
}

/**
 * The start of the character that holds `index`: the last byte in the three
 * before it that is not a continuation byte, when the character it starts
 * could reach `index`; otherwise `index` itself.
 */
function characterStart(bytes: Uint8Array, index: number): number {
  for (let at = index - 1; at >= Math.max(0, index - 3); at -= 1) {
    const byte = bytes[at] as number;
    if (byte < 0x80 || byte > 0xbf) return byte >= 0xc2 ? at : index;
  }
  return index;
}

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x80 && byte <= 0xbf;
}

/** Byte length of a valid UTF-8 character at `index` that is not a C1 control, else 0. */
function nonC1CharacterLength(bytes: Uint8Array, index: number): number {
  const lead = bytes[index] ?? 0;
  const next = bytes[index + 1] ?? 0;
  if (lead >= 0xc2 && lead <= 0xdf) {
    // C2 80..9F encodes U+0080..U+009F, the C1 controls.
    if (lead === 0xc2 && next < 0xa0) return 0;
    return isContinuation(next) ? 2 : 0;
  }
  if (lead >= 0xe0 && lead <= 0xef) {
    const low = lead === 0xe0 ? 0xa0 : 0x80;
    const high = lead === 0xed ? 0x9f : 0xbf;
    return next >= low && next <= high && isContinuation(bytes[index + 2]) ? 3 : 0;
  }
  if (lead >= 0xf0 && lead <= 0xf4) {
    const low = lead === 0xf0 ? 0x90 : 0x80;
    const high = lead === 0xf4 ? 0x8f : 0xbf;
    return next >= low &&
      next <= high &&
      isContinuation(bytes[index + 2]) &&
      isContinuation(bytes[index + 3])
      ? 4
      : 0;
  }
  return 0;
}

function dropLeadingTokenRun(text: string): string {
  return text.replace(/^[A-Za-z0-9_-]+/, "");
}

function cleanDecoded(bytes: Uint8Array, options?: { dropLeadingToken?: boolean }): string {
  return cleanText(decodeLossy(bytes), options);
}

/**
 * The text rules applied to decoded output: terminal sequences and control
 * characters removed, then credential substrings redacted. Also applied to
 * reviewed text a person submits, so it gets the same treatment.
 */
export function cleanText(text: string, options?: { dropLeadingToken?: boolean }): string {
  let cleaned = stripDisallowedControls(stripTerminalSequences(text));
  if (options?.dropLeadingToken) cleaned = dropLeadingTokenRun(cleaned);
  return redactCredentialSubstrings(cleaned);
}

function concatBytes(head: Uint8Array, tail: Uint8Array): Uint8Array {
  if (tail.length === 0) return head;
  if (head.length === 0) return tail;
  const out = new Uint8Array(head.length + tail.length);
  out.set(head, 0);
  out.set(tail, head.length);
  return out;
}

/**
 * Head is the first retained bytes and tail the last. The runtime keeps a
 * tail that still overlaps the head until the stream is longer than both
 * caps, so a covered stream (`totalBytes <= head + tail`) is head plus the
 * non-overlapping suffix of tail — not a blind concatenation. A longer
 * stream has a gap: lossy-utf8(head) + ellipsis + lossy-utf8(tail). The
 * capture starts its tail at a terminal-parser boundary (see
 * {@link TerminalByteState}), so the tail is parsed from the ground state.
 */
export function formatBoundedStream(stream: BoundedByteView): CliStreamText {
  const truncated = stream.totalBytes > stream.head.length + stream.tail.length;
  if (truncated) {
    return {
      text: `${cleanDecoded(stream.head)}${CLI_OUTPUT_ELLIPSIS}${cleanDecoded(stream.tail, { dropLeadingToken: true })}`,
      truncated: true,
      totalBytes: stream.totalBytes,
    };
  }
  const overlap = Math.max(0, stream.head.length + stream.tail.length - stream.totalBytes);
  const tailSuffix =
    overlap >= stream.tail.length ? new Uint8Array() : stream.tail.subarray(overlap);
  return {
    text: cleanDecoded(concatBytes(stream.head, tailSuffix)),
    truncated: false,
    totalBytes: stream.totalBytes,
  };
}
