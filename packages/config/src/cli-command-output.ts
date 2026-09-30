/**
 * The command-output text an MCP agent sees, shared by the server (headless
 * exec and shared supervised output) and the browser (the supervised-command
 * output review dialog shows exactly this text before anything is sent).
 *
 * Pure and dependency-free so both the Node server and the browser bundle use
 * the same bytes-to-text rules.
 */

/**
 * Per-stream view the model sees. `totalBytes` counts CLI-masked bytes before
 * head/tail retention (not the original command's raw byte count).
 * `text` is lossy UTF-8 of the retained head and tail, with credential
 * substrings removed. The CLI masks private-key blocks, secret-name token lines
 * and their continuation, secret flag values and HF token file output first.
 * Other secrets are not masked; the terminal viewer still sees raw output.
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

/** Shared command-tool notice; CLI masking is accidental-disclosure protection. */
export const CLI_COMMAND_OUTPUT_NOTICE =
  "Before command output leaves the node, the CLI scans the terminal-cleaned view and masks private key blocks (through the matching END label), whole lines containing secret-name tokens and the following non-blank line plus indentation/quote/backslash continuation, secret flag value tails (--api-key/--hf-token-style flags), and output from commands naming .cache/huggingface/token or .huggingface/token. Token lines use ⟦redacted line⟧; KEY=⟦redacted:N⟧ is only the file tools' dotenv view. A line over 64 KiB is masked whole and scanned in bounded pieces that retain private-key labels across piece boundaries; when it sits inside a live multi-line secret run (an open private-key block, quote or indentation continuation) that run's remaining output fails closed through EOF like the 1 MiB case. Otherwise, at its terminating LF recovery unconditionally masks non-blank output until the next blank line. Private key blocks still close at their matching END label; the next non-blank line and subsequent lines indented deeper than column 0 are also protected, and blank lines do not consume the next-line protection. Normal scanning resumes after the blank unless these protections extend masking. Opaque fallbacks stay closed through EOF: more than 1 MiB of live masking-state input, an over-long line inside such a run, a PEM marker exceeding the 1 KiB recovery overlap on an overlong line, or a cleaned LF inside an overlong terminal group (including LF executed inside unfinished CSI). Masked lines emit masked cleaned text with CR/LF terminators preserved; unmasked lines keep their raw bytes. Terminal parser state carries across lines; control strings hiding LF are held through a terminal ground-state LF, and masked groups spanning hidden LFs use opaque physical-line markers with CR/LF preserved. The server cleanText still runs afterwards. The person's terminal viewer is unchanged; shared/review output and byte totals are masked. Other secrets (vendor tokens such as ghp_ or sk-, JWTs, cloud credentials) are NOT masked. The server also removes substrings matching wsmp_model_, wsmp_cli_, wsmp_device_, or wsmp_mcp_ followed by credential characters. On an unsupervised node masking is not a security boundary: a command can print a secret in an unrecognized form.";

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

/**
 * The parser state after one code point (or UTF-16 code unit of one).
 * Exported for the byte-table equivalence test only.
 */
export function nextState(state: number, code: number): number {
  const anywhere = anywhereTransition(code);
  if (anywhere !== null) return anywhere;
  if (isExecutable(code)) return state === OSC_STRING && code === 0x07 ? GROUND : state;
  // DEL is ignored in every state.
  if (code === 0x7f) return state;
  if (state === GROUND) return GROUND;
  return code >= 0xa0 ? nonAsciiTransition(state) : printableTransition(state, code);
}

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
 * UTF-8 decoder substates (WHATWG, as TextDecoder decodes): what the next
 * byte must be. `DEC_C2` is after a `C2` lead, whose continuation 80..9F
 * makes a C1 control (U+0080..U+009F).
 */
const DEC_NONE = 0;
const DEC_C2 = 1;
/** One more continuation byte (80..BF) completes a non-C1 character. */
const DEC_NEED1 = 2;
const DEC_NEED2 = 3;
const DEC_NEED3 = 4;
/** After E0 (next A0..BF), ED (80..9F), F0 (90..BF), F4 (80..8F). */
const DEC_E0 = 5;
const DEC_ED = 6;
const DEC_F0 = 7;
const DEC_F4 = 8;
const DECODER_STATES = 9;
/** Any complete non-ASCII, non-C1 character, including U+FFFD for invalid input. */
const NON_ASCII = 0xfffd;

/** The decoder substate after a lead byte, or null when the byte is a whole character. */
function decoderAfterLead(byte: number): number | null {
  if (byte === 0xc2) return DEC_C2;
  if (byte >= 0xc3 && byte <= 0xdf) return DEC_NEED1;
  if (byte === 0xe0) return DEC_E0;
  if (byte === 0xed) return DEC_ED;
  if (byte >= 0xe1 && byte <= 0xef) return DEC_NEED2;
  if (byte === 0xf0) return DEC_F0;
  if (byte === 0xf4) return DEC_F4;
  if (byte >= 0xf1 && byte <= 0xf3) return DEC_NEED3;
  return null;
}

/** One byte from a combined (parser, decoder) state: the reference the table is built from. */
function stepByte(parser: number, decoder: number, byte: number): [number, number] {
  if (decoder === DEC_NONE) {
    if (byte < 0x80) return [nextState(parser, byte), DEC_NONE];
    const lead = decoderAfterLead(byte);
    // A stray continuation or a byte no character starts with is U+FFFD.
    return lead === null ? [nextState(parser, NON_ASCII), DEC_NONE] : [parser, lead];
  }
  const [low, high, after] =
    decoder === DEC_C2 || decoder === DEC_NEED1
      ? [0x80, 0xbf, DEC_NONE]
      : decoder === DEC_NEED2
        ? [0x80, 0xbf, DEC_NEED1]
        : decoder === DEC_NEED3
          ? [0x80, 0xbf, DEC_NEED2]
          : decoder === DEC_E0
            ? [0xa0, 0xbf, DEC_NEED1]
            : decoder === DEC_ED
              ? [0x80, 0x9f, DEC_NEED1]
              : decoder === DEC_F0
                ? [0x90, 0xbf, DEC_NEED2]
                : [0x80, 0x8f, DEC_NEED2];
  if (byte < low || byte > high) {
    // The partial character is invalid: U+FFFD, then this byte starts over.
    return stepByte(nextState(parser, NON_ASCII), DEC_NONE, byte);
  }
  if (after !== DEC_NONE) return [parser, after];
  // A complete character: C2 80..9F is a C1 control, anything else non-ASCII.
  const code = decoder === DEC_C2 && byte <= 0x9f ? byte : NON_ASCII;
  return [nextState(parser, code), DEC_NONE];
}

/**
 * Every (parser, decoder) state and byte, at `(state << 8) | byte`, where
 * `state = parser * DECODER_STATES + decoder` (126 states). Built once from
 * {@link stepByte}, so each byte costs one table load whatever the output.
 * Built on first use ({@link byteTransitions}), not at import: the build costs
 * about 25 ms, and this module is also imported by web code that never feeds
 * a byte.
 */
function buildByteTransitions(): Uint8Array {
  const states = (DCS_PASSTHROUGH + 1) * DECODER_STATES;
  const table = new Uint8Array(states << 8);
  for (let parser = 0; parser <= DCS_PASSTHROUGH; parser += 1) {
    for (let decoder = 0; decoder < DECODER_STATES; decoder += 1) {
      for (let byte = 0; byte < 0x100; byte += 1) {
        const [nextParser, nextDecoder] = stepByte(parser, decoder, byte);
        table[((parser * DECODER_STATES + decoder) << 8) | byte] =
          nextParser * DECODER_STATES + nextDecoder;
      }
    }
  }
  return table;
}

let byteTransitionTable: Uint8Array | null = null;
let byteTransitionTableBuilds = 0;

/** The transition table, built by the first byte fed to a {@link TerminalByteState}. */
function byteTransitions(): Uint8Array {
  if (byteTransitionTable === null) {
    byteTransitionTable = buildByteTransitions();
    byteTransitionTableBuilds += 1;
  }
  return byteTransitionTable;
}

/** How many times the transition table was built (exactly once after first use). Test seam. */
export function byteTransitionTableBuildCount(): number {
  return byteTransitionTableBuilds;
}

/** GROUND with no partial character: the only state a tail may start in. */
const BOUNDARY = GROUND * DECODER_STATES + DEC_NONE;

/**
 * Follows the terminal parser (and a UTF-8 decoder, as TextDecoder decodes)
 * across the bytes a bounded capture drops from the front of its rolling
 * tail. A capture drops bytes until {@link atBoundary}, so its tail always
 * starts where the terminal is in its ground state on a whole character:
 * parsing the tail on its own then keeps exactly what parsing the whole
 * stream keeps from that point. Without it, a tail that starts inside a DCS,
 * APC, PM or OSC body would show that hidden body as text.
 *
 * One table load per byte ({@link byteTransitions}): this runs on the
 * server's event loop for every byte of headless exec output, so its cost
 * must not depend on what the output looks like.
 *
 * The Rust CLI's capture (`apps/cli/src/terminal_parse.rs`) implements the
 * same rules for supervised output.
 */
export class TerminalByteState {
  private state = BOUNDARY;

  /** True in the ground state with no partial character pending. */
  get atBoundary(): boolean {
    return this.state === BOUNDARY;
  }

  /** Feeds one byte. */
  feed(byte: number): void {
    this.state = byteTransitions()[(this.state << 8) | (byte & 0xff)] as number;
  }

  /**
   * Feeds `bytes[from…]` while the index is below `dropUntil` or the parser
   * is not at a boundary; returns the first index not fed. One table load
   * per byte.
   */
  consume(bytes: Uint8Array, from: number, dropUntil: number): number {
    const length = bytes.length;
    let state = this.state;
    let index = from;
    const table = byteTransitions();
    while (index < length && (index < dropUntil || state !== BOUNDARY)) {
      state = table[(state << 8) | (bytes[index] as number)] as number;
      index += 1;
    }
    this.state = state;
    return index;
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
