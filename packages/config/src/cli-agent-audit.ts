/**
 * Shared vocabulary of the agent audit log (`CliAgentActionEvent`): what an
 * agent did on a CLI device through MCP, as metadata only (never file
 * content, diffs, command output or command text).
 */

/** Rows older than this are deleted by the hourly retention sweep. */
export const CLI_AGENT_ACTION_RETENTION_DAYS = 90;

/**
 * What the agent did. Mirrors the Prisma enum `CliAgentActionKind`. The nine
 * `file_*` kinds are one per file tool; `supervised_file_write` is a write a
 * person confirmed on the CLI.
 */
export const CLI_AGENT_ACTION_KINDS = [
  "command",
  "supervised_command",
  "file_read",
  "file_stat",
  "file_list",
  "file_search",
  "file_edit",
  "file_write",
  "file_rename",
  "file_mkdir",
  "file_delete",
  "supervised_file_write",
] as const;
export type CliAgentActionKind = (typeof CLI_AGENT_ACTION_KINDS)[number];

/**
 * How it ended. Mirrors the Prisma enum `CliAgentActionOutcome`; the specific
 * code (refusal code, exit status, file error code) goes in `reason`.
 * - completed: the operation ran to its end (a command may still have exited non-zero);
 * - refused: admission or validation said no, nothing ran;
 * - failed: it started and did not complete (file error);
 * - cancelled: stopped by revoke, timeout, disconnect or the agent;
 * - declined / expired: a supervised request the person declined or left unanswered;
 * - unknown: a mutation whose result could not be determined (timeout, lost session).
 */
export const CLI_AGENT_ACTION_OUTCOMES = [
  "completed",
  "refused",
  "failed",
  "cancelled",
  "declined",
  "expired",
  "unknown",
] as const;
export type CliAgentActionOutcome = (typeof CLI_AGENT_ACTION_OUTCOMES)[number];

/**
 * The reason codes a conforming CLI may send in an `exec.rejected` or
 * `supervised.rejected` frame (the `REASON_*` constants in
 * apps/cli/src/sessions.rs). The wire schema accepts any 1..64-character
 * string, so the relay maps every other value to
 * {@link CLI_AGENT_REJECTION_FALLBACK}: `reason` is a stable machine code,
 * never free text, and CLI-supplied text must not reach the audit column.
 */
export const CLI_AGENT_WIRE_REASONS = [
  "disabled",
  "unsupported",
  "limit",
  "viewer_limit",
  "approval_required",
  "bad_signature",
  "bad_command",
  "bad_cwd",
  "not_found",
  "already_open",
  "spawn_failed",
  "bad_handshake",
  "bad_frame",
  "expired",
  "supervised_only",
  "cwd_not_utf8",
] as const;

/** Stored for a rejection reason outside {@link CLI_AGENT_WIRE_REASONS}. */
export const CLI_AGENT_REJECTION_FALLBACK = "rejected";

const WIRE_REASONS: ReadonlySet<string> = new Set(CLI_AGENT_WIRE_REASONS);

/** A CLI wire reason if it is a known code, {@link CLI_AGENT_REJECTION_FALLBACK} otherwise. */
export function cliAgentWireReason(reason: string): string {
  return WIRE_REASONS.has(reason) ? reason : CLI_AGENT_REJECTION_FALLBACK;
}

/** Metadata of one action. Deliberately has no field that could hold content. */
export type CliAgentActionEventInput = {
  userId: string;
  cliDeviceId: string;
  mcpTokenId: string | null;
  kind: CliAgentActionKind;
  /** Requested path (files) or {@link commandAuditPath} (commands). */
  path: string;
  etagBefore?: string | null;
  etagAfter?: string | null;
  bytes?: number | null;
  outcome: CliAgentActionOutcome;
  /** Stable machine code (`[a-z0-9_:.-]`), never free text. */
  reason?: string | null;
  startedAt: Date;
  finishedAt?: Date | null;
};

/**
 * Signal names a stored `signal:<name>` reason may carry (POSIX and common
 * Linux/macOS names, with or without the `SIG` prefix), and numeric signals
 * 1-64. The wire accepts any 1-32 character token from the CLI; only this
 * finite vocabulary is stored, so a misbehaving CLI cannot put text in a row.
 */
const SIGNAL_NAMES = new Set([
  "HUP",
  "INT",
  "QUIT",
  "ILL",
  "TRAP",
  "ABRT",
  "IOT",
  "BUS",
  "FPE",
  "KILL",
  "USR1",
  "SEGV",
  "USR2",
  "PIPE",
  "ALRM",
  "TERM",
  "STKFLT",
  "CHLD",
  "CONT",
  "STOP",
  "TSTP",
  "TTIN",
  "TTOU",
  "URG",
  "XCPU",
  "XFSZ",
  "VTALRM",
  "PROF",
  "WINCH",
  "IO",
  "POLL",
  "PWR",
  "SYS",
  "EMT",
  "INFO",
]);

/** `signal:<name|number>` as sent for a known signal, else `signal:unknown`. */
export function cliAgentSignalReason(signal: string): string {
  const upper = signal.toUpperCase();
  const name = upper.startsWith("SIG") ? upper.slice(3) : upper;
  if (SIGNAL_NAMES.has(name)) return `signal:${signal}`;
  if (/^[1-9][0-9]?$/.test(signal) && Number(signal) <= 64) return `signal:${signal}`;
  return "signal:unknown";
}

/**
 * Stored as the device of a refusal row when the request's device id was not
 * verified as one of the caller's own (an unknown or foreign id, or a refusal
 * before the check): request text is never stored as an identifier.
 */
export const CLI_AGENT_ACTION_UNKNOWN_DEVICE = "unknown";

/**
 * Stored as the program of a command event when it cannot be extracted (empty,
 * unparsable, or a name outside the allowed charset/length).
 */
export const CLI_AGENT_ACTION_UNKNOWN_PROGRAM = "?";

/** The only names a stored program may have: no spaces, quotes, NUL or non-ASCII. */
const PROGRAM_PATTERN = /^[A-Za-z0-9._+-]{1,64}$/;

/** The whole program word: a plain path (program charset plus `/`). */
const PROGRAM_WORD_PATTERN = /^[A-Za-z0-9._+/-]+$/;

/**
 * A leading `NAME=value` assignment that is safe to skip: a valid shell env
 * NAME and a value made only of plain characters. Anything else in the value
 * (quotes, backslash, `$`, backtick, parentheses, braces, redirection, glob
 * or history characters, whitespace other than space and tab) can keep a
 * space inside ONE shell word, so the next space-separated piece would be a
 * fragment of the value, not a program. Such a command fails closed.
 */
const SAFE_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_./:@%+,=-]*$/;

/** A word that starts like an assignment (valid NAME then `=`), safe or not. */
const ASSIGNMENT_START_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Splits a command into tokens at spaces and tabs ONLY. There is no quote or
 * escape handling on purpose: a word is never re-assembled, so no piece of an
 * argument or assignment value can be mistaken for the program. Any other
 * whitespace (LF, CR, VT, FF, Unicode spaces) stays inside its token, which
 * then fails the program charset. Leading whitespace of any kind is trimmed
 * first.
 */
function tokenizeCommand(command: string): string[] {
  return command
    .replace(/^\s+/u, "")
    .split(/[ \t]+/)
    .filter((token) => token.length > 0);
}

/** The basename of a word: `"/usr/bin/git"` -> `git`; empty for a trailing slash. */
function basename(word: string): string {
  if (word.endsWith("/")) return "";
  const index = word.lastIndexOf("/");
  return index === -1 ? word : word.slice(index + 1);
}

/** `word` with surrounding matching quotes removed (one layer). */
function unquote(word: string): string {
  if (word.length >= 2) {
    const first = word[0];
    if ((first === '"' || first === "'") && word.endsWith(first)) return word.slice(1, -1);
  }
  return word;
}

/**
 * The program of a command for the audit `path`: the basename of the first
 * word that is not a leading plain `NAME=value` assignment (an assignment with
 * a quote, escape, expansion or other non-plain value fails closed) (`env`, `sudo` and the
 * other wrappers are stored by their own name, never unwrapped). Returns
 * {@link CLI_AGENT_ACTION_UNKNOWN_PROGRAM} for anything outside the accepted
 * shape: a word that starts with `-` is a flag, not a program, so it fails
 * closed too. Never returns any argument text.
 */
export function commandProgram(command: unknown): string {
  if (typeof command !== "string" || command.length === 0) {
    return CLI_AGENT_ACTION_UNKNOWN_PROGRAM;
  }
  for (const token of tokenizeCommand(command)) {
    if (ASSIGNMENT_START_PATTERN.test(token)) {
      // Skip only a plain assignment; any other shape may hide a value that
      // spans several tokens, so the program cannot be told and fails closed.
      if (SAFE_ASSIGNMENT_PATTERN.test(token)) continue;
      return CLI_AGENT_ACTION_UNKNOWN_PROGRAM;
    }
    // The WHOLE word is checked before its basename is taken: a leading
    // redirection (`2>/x/y`), a slash-bearing flag (`--opt=/x/y`, `-p/x/y`) or
    // any word with a character outside the path charset would otherwise leak
    // its last path segment as the "program".
    const word = unquote(token);
    if (!PROGRAM_WORD_PATTERN.test(word) || word.startsWith("-")) {
      return CLI_AGENT_ACTION_UNKNOWN_PROGRAM;
    }
    const base = basename(word);
    return PROGRAM_PATTERN.test(base) ? base : CLI_AGENT_ACTION_UNKNOWN_PROGRAM;
  }
  return CLI_AGENT_ACTION_UNKNOWN_PROGRAM;
}

/**
 * `path` prefix of a command event: `<prefix><hash> <program>`. A keyed
 * HMAC-SHA256, so DB access alone cannot confirm a guessed command (e.g. a
 * short password on the command line).
 */
export const CLI_AGENT_ACTION_AUDIT_PATH_PREFIX = "hmac-sha256:";

/**
 * Stored in place of the hash when the server cannot derive the audit key
 * (the auth secret is missing or derivation failed). It leaks nothing and
 * cannot be checked against guesses.
 */
export const CLI_AGENT_ACTION_AUDIT_HASH_UNAVAILABLE = "unavailable";

/** Hex length of the stored HMAC-SHA256 digest. */
export const CLI_AGENT_ACTION_AUDIT_HASH_HEX_LENGTH = 64;

/**
 * Fixed HKDF info label for the audit key. It must never change for a given
 * deployment: it separates this key from every other use of the auth secret,
 * so a key derived for another purpose cannot reproduce these digests.
 */
export const CLI_AGENT_ACTION_AUDIT_HKDF_INFO = "wsmp-cli-agent-audit-v1";

/**
 * `path` of a command event: `hmac-sha256:<hex of the command text> <program>`.
 * The digest is over the well-formed command text itself (no mask), so with the
 * server-held key it can verify a guess but never reveals text; without the key
 * it reveals nothing. The only other field is {@link commandProgram}, a
 * validated program name. `digest` is injected to keep this module free of Node
 * built-ins; it must return {@link CLI_AGENT_ACTION_AUDIT_HASH_UNAVAILABLE} when
 * it has no key, and its output is stored verbatim after the prefix.
 */
export function commandAuditPath(command: string, digest: (text: string) => string): string {
  return `${CLI_AGENT_ACTION_AUDIT_PATH_PREFIX}${digest(command.toWellFormed())} ${commandProgram(command)}`;
}
