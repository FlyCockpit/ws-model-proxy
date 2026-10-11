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
 * General rejection codes normalized for command audit metadata, matching
 * the `REASON_*` constants in apps/cli/src/sessions.rs (including
 * `invalid_input` and `bad_frame`). Supervised files also send file-policy
 * codes such as `path_denied`, `secret_file`, `too_large` and `redacted_span`;
 * the server validates and retains those separately as file error codes.
 * This normalizer maps values outside this list to
 * {@link CLI_AGENT_REJECTION_FALLBACK}, keeping command audit reasons stable
 * machine codes rather than CLI-supplied text.
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
  "trust_relay",
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
 * unparsable, or not in {@link CLI_AGENT_PROGRAM_ALLOWLIST}).
 */
export const CLI_AGENT_ACTION_UNKNOWN_PROGRAM = "?";

/**
 * The ONLY program names that can ever be stored for a command row (owner
 * decision 2026-09-29, #151). A fixed, code-reviewed list of common program
 * basenames, all lowercase and all matching `[a-z0-9-]`: extraction returns a
 * member of this set or `?`, never a substring of the command, so nothing
 * user-controlled reaches the row. Wrappers (`sudo`, `env`, `nohup`, `time`,
 * `exec`) are stored by their own name and never unwrapped. Add a name only
 * after review; keep it lowercase, without `/`, `.`, quotes or non-ASCII.
 */
export const CLI_AGENT_PROGRAM_ALLOWLIST: ReadonlySet<string> = new Set([
  // wrappers
  "sudo",
  "env",
  "nohup",
  "time",
  "exec",
  // shells
  "bash",
  "sh",
  "zsh",
  "fish",
  "dash",
  // vcs and network
  "git",
  "gh",
  "curl",
  "wget",
  "ssh",
  "scp",
  "rsync",
  // build and language toolchains
  "make",
  "cmake",
  "ninja",
  "cargo",
  "rustc",
  "rustup",
  "go",
  "gcc",
  "clang",
  "python",
  "python3",
  "pip",
  "pip3",
  "uv",
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "java",
  "mvn",
  "gradle",
  "dotnet",
  "ruby",
  "gem",
  "php",
  "composer",
  // containers and infrastructure
  "docker",
  "podman",
  "kubectl",
  "helm",
  "terraform",
  "systemctl",
  "journalctl",
  // archives
  "tar",
  "zip",
  "unzip",
  "gzip",
  "gunzip",
  // filesystem and text tools
  "ls",
  "cat",
  "cp",
  "mv",
  "rm",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "ln",
  "pwd",
  "cd",
  "echo",
  "printf",
  "head",
  "tail",
  "less",
  "wc",
  "sort",
  "uniq",
  "diff",
  "tee",
  "xargs",
  "grep",
  "rg",
  "find",
  "fd",
  "sed",
  "awk",
  "jq",
  "vim",
  "nano",
  // system
  "ps",
  "top",
  "kill",
  "df",
  "du",
  "sleep",
  "which",
  "test",
  // model serving and GPU
  "llama-server",
  "llama-cli",
  "ollama",
  "vllm",
  "nvidia-smi",
]);

/** A leading `NAME=value` the relay may skip: only a plain, expansion-free value (never stored). */
const PLAIN_ASSIGNMENT =
  /[A-Za-z_][A-Za-z0-9_]*=(?:[A-Za-z0-9_./:@,+%^~-]*|"[^"\\$`\r\n]*"|'[^'\\\r\n]*')(?=[ \t]|$)[ \t]*/y;

/** At most this many leading assignments are skipped; more is treated as unparsable. */
const MAX_LEADING_ASSIGNMENTS = 32;

/** A program word (after one quote layer): path characters only, no leading `-`. */
const PROGRAM_WORD = /^[A-Za-z0-9._+~/-]{1,4096}$/;

/**
 * The program of a command for the audit `path`. The grammar (design-program.md):
 *
 * 1. Skip leading spaces and tabs, then any number (at most
 *    {@link MAX_LEADING_ASSIGNMENTS}) of plain `NAME=value` assignments. A
 *    value holding an escape, expansion, substitution, extra quote or line
 *    break is not plain: the result is `?`. Skipped values are never stored.
 * 2. The candidate is the next word, up to the next space or tab. One layer of
 *    matching quotes around it is removed. What remains must be path
 *    characters only (no `-` first, no `=`, `$`, redirection or backslash);
 *    its basename (after the last `/`) is lowercased.
 * 3. The result is that basename only if it is in
 *    {@link CLI_AGENT_PROGRAM_ALLOWLIST}, else `?`.
 *
 * The result is therefore always an allowlist member or `?`: never argument
 * text, a secret, or any other part of the command.
 */
export function commandProgram(command: unknown): string {
  if (typeof command !== "string" || command.length === 0) {
    return CLI_AGENT_ACTION_UNKNOWN_PROGRAM;
  }
  let index = /^[ \t]*/.exec(command)?.[0].length ?? 0;
  for (let skipped = 0; ; skipped++) {
    PLAIN_ASSIGNMENT.lastIndex = index;
    const match = PLAIN_ASSIGNMENT.exec(command);
    if (match === null) break;
    if (skipped >= MAX_LEADING_ASSIGNMENTS) return CLI_AGENT_ACTION_UNKNOWN_PROGRAM;
    index += match[0].length;
  }
  let end = index;
  while (end < command.length && command[end] !== " " && command[end] !== "\t") end++;
  let word = command.slice(index, end);
  const quote = word[0];
  if ((quote === '"' || quote === "'") && word.length >= 2 && word.endsWith(quote)) {
    word = word.slice(1, -1);
  }
  if (!PROGRAM_WORD.test(word) || word.startsWith("-")) {
    return CLI_AGENT_ACTION_UNKNOWN_PROGRAM;
  }
  const base = (word.split("/").pop() ?? "").toLowerCase();
  return CLI_AGENT_PROGRAM_ALLOWLIST.has(base) ? base : CLI_AGENT_ACTION_UNKNOWN_PROGRAM;
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
 * it reveals nothing. The only other field is {@link commandProgram}, an
 * allowlisted program name (`?` when the caller had to truncate the command). `digest` is injected to
 * keep this module free of Node built-ins; it must return {@link CLI_AGENT_ACTION_AUDIT_HASH_UNAVAILABLE} when
 * it has no key, and its output is stored verbatim after the prefix.
 */
export function commandAuditPath(
  command: string,
  digest: (text: string) => string,
  { truncated = false }: { truncated?: boolean } = {},
): string {
  // A truncated command is not a complete shell word sequence: its cut can end
  // inside a directory component, so no program is derived from it.
  const program = truncated ? CLI_AGENT_ACTION_UNKNOWN_PROGRAM : commandProgram(command);
  return `${CLI_AGENT_ACTION_AUDIT_PATH_PREFIX}${digest(command.toWellFormed())} ${program}`;
}
