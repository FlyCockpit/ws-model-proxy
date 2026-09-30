import { z } from "zod";
import {
  auditRefusedFileInput,
  type FileOpFailure,
  type FileOpOutcome,
  type FileOpSuccess,
  runFileOp,
} from "../relay/cli-file-ops.js";
import { FILE_BODY_MAX_BYTES, type FileOp, fileToolArgShapes } from "../relay/file-protocol.js";
import { isWellFormedText } from "../relay/wire-text.js";
import { redactCredentialSubstrings } from "./cli-command-output.js";
import type { McpRequestCredential } from "./cli-tool-access.js";

/**
 * The nine node file tools (relay 2.8, #103): read, stat, list, search,
 * edit, write, rename, mkdir, delete. Each is an extracted core that runs
 * one file op on a CLI (`runFileOp`), a strict input schema built from the
 * relay arg shapes, and an output projector that passes ONLY documented
 * fields. File content is returned to the agent and never logged or stored
 * here.
 */

// ---------------------------------------------------------------------------
// Tools

export const FILE_TOOLS = [
  { name: "forwarder_cli_file_read", op: "read", target: "core:forwarderCliFileRead" },
  { name: "forwarder_cli_file_stat", op: "stat", target: "core:forwarderCliFileStat" },
  { name: "forwarder_cli_dir_list", op: "list", target: "core:forwarderCliFileList" },
  { name: "forwarder_cli_file_search", op: "search", target: "core:forwarderCliFileSearch" },
  { name: "forwarder_cli_file_edit", op: "edit", target: "core:forwarderCliFileEdit" },
  { name: "forwarder_cli_file_write", op: "write", target: "core:forwarderCliFileWrite" },
  { name: "forwarder_cli_file_rename", op: "rename", target: "core:forwarderCliFileRename" },
  { name: "forwarder_cli_dir_create", op: "mkdir", target: "core:forwarderCliFileMkdir" },
  { name: "forwarder_cli_file_delete", op: "delete", target: "core:forwarderCliFileDelete" },
] as const satisfies ReadonlyArray<{ name: string; op: FileOp; target: string }>;

export type FileToolName = (typeof FILE_TOOLS)[number]["name"];

/**
 * Largest read window the MCP layer asks for. The CLI's own cap is 128 KiB,
 * but the tool result is carried twice (text and structured content) inside
 * the 256 KiB output cap, so a window is held to 96 KiB here.
 */
export const MCP_FILE_READ_MAX_BYTES = 96 * 1024;

/** Byte cap on the JSON of one projected result: it is emitted twice under the 256 KiB cap. */
const FILE_RESULT_MAX_JSON_BYTES = 120 * 1024;

// ---------------------------------------------------------------------------
// Input schemas (advertised) and adapters

const cliDeviceIdSchema = z.string().min(1).max(128);

function fileToolEntry(name: FileToolName) {
  const entry = FILE_TOOLS.find((tool) => tool.name === name);
  if (!entry) throw new Error(`unknown file tool ${name}`);
  return entry;
}

/**
 * The MCP-owned argument shape of a tool (`cliDeviceId` plus the op's fields).
 * The manifest generator (input-schema.ts, #117) turns it into the advertised
 * JSON Schema and adds `confirm`; nothing here builds a schema by hand.
 */
export function fileToolCoreShape(name: FileToolName) {
  return { cliDeviceId: cliDeviceIdSchema, ...fileToolArgShapes[fileToolEntry(name).op] };
}

/** The strict input of one op, checked by the core (the SDK validator is the loose generated one). */
const strictInputByOp = new Map<FileOp, z.ZodType>();

function strictInput(op: FileOp): z.ZodType {
  let schema = strictInputByOp.get(op);
  if (schema === undefined) {
    schema = z.object({ cliDeviceId: cliDeviceIdSchema, ...fileToolArgShapes[op] }).strict();
    strictInputByOp.set(op, schema);
  }
  return schema;
}

export type AdaptedFileInput = {
  cliDeviceId: string;
  op: FileOp;
  args: Record<string, unknown>;
  body?: Uint8Array;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** Decode a strict base64 string; null when it is not canonical padded or unpadded base64. */
function decodeBase64(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1) return null;
  const bytes = Buffer.from(text, "base64");
  const canonical = bytes.toString("base64").replace(/=+$/, "");
  if (canonical !== text.replace(/=+$/, "")) return null;
  return new Uint8Array(bytes);
}

/**
 * MCP input to the relay op: only the documented fields of `op` pass, so an
 * unknown field never travels to the CLI. A write's `content` is decoded here
 * (`utf-8` or `base64`) and travels as the binary body, not in the args.
 * Returns null (invalid_input) for content the relay cannot carry.
 */
export function adaptFileToolInput(op: FileOp, input: unknown): AdaptedFileInput | null {
  const record = asRecord(input);
  const cliDeviceId = typeof record.cliDeviceId === "string" ? record.cliDeviceId : "";
  const shape: Record<string, unknown> = fileToolArgShapes[op];
  const args: Record<string, unknown> = {};
  for (const key of Object.keys(shape)) {
    if (op === "write" && (key === "content" || key === "encoding")) continue;
    if (record[key] !== undefined) args[key] = record[key];
  }
  if (op === "read" && typeof args.maxBytes === "number") {
    args.maxBytes = Math.min(args.maxBytes, MCP_FILE_READ_MAX_BYTES);
  }
  if (op !== "write") return { cliDeviceId, op, args };

  const content = record.content;
  if (typeof content !== "string") return null;
  const encoding = record.encoding === undefined ? "utf-8" : record.encoding;
  let body: Uint8Array | null;
  if (encoding === "utf-8") {
    body = isWellFormedText(content) ? new TextEncoder().encode(content) : null;
  } else if (encoding === "base64") {
    body = decodeBase64(content);
  } else {
    body = null;
  }
  if (body === null || body.byteLength > FILE_BODY_MAX_BYTES) return null;
  return { cliDeviceId, op, args, body };
}

// ---------------------------------------------------------------------------
// Errors

type ToolErrorCode = FileOpFailure["code"];

/** Short fixed messages. They never carry a path, file content, or CLI text. */
const FILE_ERROR_MESSAGES: Readonly<Record<ToolErrorCode, string>> = {
  not_found: "No such file or directory",
  grant_disabled: "File tools are disabled for this device (its MCP command mode is off)",
  offline: "The CLI is offline or does not support file tools",
  feature_disabled: "The CLI has MCP commands disabled in wsmp config",
  supervised_only:
    "File tools run headless only on an unsupervised node; this device requires a person to confirm each action",
  unsupported:
    "The CLI cannot run this file operation (it refuses file tools as root unless allowFileToolsAsRoot is set)",
  limit: "Too many file operations; retry after retryAfterMs",
  token_inactive:
    "This MCP token was revoked, has expired, or no longer allows CLI commands (mcp:write and CLI commands are required)",
  upgrade_required: "This CLI speaks an older relay protocol; upgrade wsmp",
  invalid_input: "Invalid input for this file operation",
  path_denied: "That path is not allowed",
  secret_file:
    "Secret files are read-only masked views: edit, write, rename, delete and mkdir are refused on them and on their directories",
  not_a_file: "The path is not a regular file",
  not_a_dir: "The path is not a directory",
  binary_file: "The file is not text",
  too_large: "The file or result is too large",
  conflict: "The file changed since it was read; re-read it and retry with the new etag",
  match_count: "The edit matched a different number of places than expected",
  no_match: "The edit text was not found",
  redacted_span: "The edit touches a masked (redacted) value",
  exists: "The path already exists",
  hard_linked: "Refused: the file has more than one hard link",
  owner_mismatch: "Refused: the file belongs to another user",
  setuid: "Refused: the file is setuid or setgid",
  special_file: "Refused: not a regular file or directory",
  io_error: "The file operation failed",
  timeout: "The file operation timed out",
  cancelled: "The file operation was cancelled",
};

/** A file tool failure: a stable `code`, a short message, and small structured facts. */
export class McpCliFileError extends Error {
  readonly code: ToolErrorCode;
  readonly extra: Record<string, unknown>;
  /** Raw zod issues of an `invalid_input` from the strict input check; sanitized by the wrapper. */
  readonly validation: { issues: unknown[] } | null;

  constructor(failure: FileOpFailure, validation: { issues: unknown[] } | null = null) {
    const device = failure.code === "not_found" && failure.scope === "device";
    super(
      failure.code === "upgrade_required" && failure.rejectedProtocolVersion
        ? `This CLI speaks relay ${failure.rejectedProtocolVersion}; upgrade wsmp`
        : device
          ? "CLI device not found"
          : FILE_ERROR_MESSAGES[failure.code],
    );
    this.name = "McpCliFileError";
    this.validation = validation;
    this.code = failure.code;
    // Everything the CLI sent (detail values) is untrusted text: the same
    // credential-substring removal as a result, and only small facts.
    const extra: Record<string, unknown> = scrub({ ...(failure.detail ?? {}) }) as Record<
      string,
      unknown
    >;
    if (failure.retryAfterMs !== undefined) extra.retryAfterMs = failure.retryAfterMs;
    if (failure.outcome !== undefined) extra.outcome = failure.outcome;
    if (failure.rejectedProtocolVersion !== undefined) {
      extra.relayProtocolVersion = scrub(failure.rejectedProtocolVersion);
    }
    this.extra = extra;
  }
}

// ---------------------------------------------------------------------------
// Cores

type FileToolDeps = {
  userId: string;
  signal?: AbortSignal;
  credential: McpRequestCredential;
};

function requireFilePat(credential: McpRequestCredential): {
  tokenId: string;
  expiresAt: Date | null;
} {
  if (credential.kind === "pat" && credential.allowCliCommands === true) {
    return { tokenId: credential.tokenId, expiresAt: credential.expiresAt };
  }
  // A credential that may not see the tool gets the same answer as an unknown one.
  throw new McpCliFileError({ ok: false, code: "not_found", scope: "device" });
}

function fail(outcome: FileOpOutcome): never {
  if (outcome.ok) throw new Error("fail() called with a success");
  throw new McpCliFileError(outcome);
}

/** The only request fields an audit row may see: never content, edits or patterns. */
function auditArgsOf(input: unknown): Record<string, unknown> {
  const record = asRecord(input);
  const out: Record<string, unknown> = {};
  for (const key of ["path", "root", "from", "paths", "expectedEtag"]) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  return out;
}

/** Run one tool's op and return the settled success (`{op, result}`), or throw `McpCliFileError`. */
export async function runForwarderCliFileTool(
  op: FileOp,
  input: unknown,
  deps: FileToolDeps,
): Promise<FileOpSuccess> {
  const pat = requireFilePat(deps.credential);
  // The SDK validator is the loose generated one (#117): the strict per-op
  // shape is enforced here, and its issues reach the agent as named fields.
  const checked = strictInput(op).safeParse(input);
  if (!checked.success) {
    auditRefusedFileInput({
      userId: deps.userId,
      tokenId: pat.tokenId,
      cliDeviceId: "",
      op,
      args: auditArgsOf(input),
    });
    throw new McpCliFileError(
      { ok: false, code: "invalid_input" },
      { issues: checked.error.issues },
    );
  }
  const adapted = adaptFileToolInput(op, checked.data);
  if (adapted === null) {
    auditRefusedFileInput({
      userId: deps.userId,
      tokenId: pat.tokenId,
      cliDeviceId: "",
      op,
      args: auditArgsOf(checked.data),
    });
    return fail({ ok: false, code: "invalid_input" });
  }
  const outcome = await runFileOp({
    userId: deps.userId,
    tokenId: pat.tokenId,
    expiresAt: pat.expiresAt,
    cliDeviceId: adapted.cliDeviceId,
    op: adapted.op,
    args: adapted.args,
    ...(adapted.body ? { body: adapted.body } : {}),
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  if (!outcome.ok) return fail(outcome);
  return outcome;
}

// ---------------------------------------------------------------------------
// Projectors: documented fields only, with the wsmp_ credential substrings
// removed from every string (the generic redactor only sees whole values).

function pick(source: Record<string, unknown>, keys: readonly string[]) {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

const READ_FIELDS = [
  "unchanged",
  "etag",
  "size",
  "mtime",
  "mode",
  "totalLines",
  "startLine",
  "endLine",
  "eol",
  "text",
  "redactions",
  "more",
  "secretFile",
  "resolvedPath",
] as const;
const STAT_ENTRY_FIELDS = [
  "path",
  "type",
  "size",
  "mtime",
  "mode",
  "owner",
  "etag",
  "target",
  "targetType",
  "resolvedPath",
  "error",
] as const;
const PROJECT_FIELDS: Readonly<Record<FileOp, readonly string[]>> = {
  read: READ_FIELDS,
  stat: ["entries"],
  list: ["entries", "count", "more", "resolvedPath"],
  search: ["matches", "files", "count", "scannedFiles", "more"],
  edit: ["etag", "previousEtag", "added", "removed", "applied", "diff", "hunks", "resolvedPath"],
  write: ["etag", "size", "created", "added", "removed", "diff", "resolvedPath"],
  rename: ["etag"],
  mkdir: ["created"],
  delete: ["deleted", "type"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scrub(value: unknown): unknown {
  if (typeof value === "string") return redactCredentialSubstrings(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = scrub(entry);
    return out;
  }
  return value;
}

/**
 * The output of one tool: `{op, result}` from the core, cut down to the
 * documented fields of that op. Anything else (an injected extra field, a
 * nested object outside the documented shape) is dropped. The projected JSON
 * must fit twice into the 256 KiB output cap; a result that does not is a
 * `too_large` refusal that tells the agent to narrow the request.
 */
export function projectFileToolOutput(output: unknown): unknown {
  const record = isRecord(output) ? output : {};
  const op = record.op;
  const result = isRecord(record.result) ? record.result : {};
  if (typeof op !== "string" || !Object.hasOwn(PROJECT_FIELDS, op)) return {};
  const fields = PROJECT_FIELDS[op as FileOp];
  let projected: Record<string, unknown> = pick(result, fields);
  if (op === "stat" && Array.isArray(result.entries)) {
    projected = {
      entries: result.entries.map((entry) =>
        isRecord(entry) ? pick(entry, STAT_ENTRY_FIELDS) : {},
      ),
    };
  }
  if (isRecord(projected.more)) {
    projected.more = pick(projected.more, ["startLine", "byteOffset", "cursor", "note"]);
  }
  const clean = scrub(projected);
  if (new TextEncoder().encode(JSON.stringify(clean)).byteLength > FILE_RESULT_MAX_JSON_BYTES) {
    throw new McpCliFileError({ ok: false, code: "too_large" });
  }
  return clean;
}

// ---------------------------------------------------------------------------
// Descriptions

export const FILE_MASKING_NOTICE =
  "Masking is bounded and shown in the text: dotenv values as KEY=⟦redacted:N⟧; in other files any line containing a secret-name word (…_TOKEN, …_KEY, …_SECRET, …_PASSWORD, apikey, api-key, hf-token, PASSWORD), the next non-blank line and every deeper-indented continuation as ⟦redacted line⟧; --api-key/--hf-token flag values; private-key blocks and SSH private key files; Hugging Face token files. There is no vendor-prefix scanner and a construct opened before the bounded lookback of a windowed read is a documented residual. On an unsupervised node masking is NOT a security boundary (an agent that can run commands can cat .env); it keeps those secrets out of transcripts on the normal path. Secret-class files are READ-ONLY masked views: every write, edit, rename, delete or mkdir that touches one (or its directory) is refused with error.code secret_file, on every operating system and whatever the letter case; change such a file with a command, not with these tools. Only the wsmp_ credential substrings are additionally removed by the server.";

export const FILE_ACCESS_NOTICE =
  "Runs headless only on a CLI whose MCP command mode is unsupervised (the lowest of the dashboard grant and the CLI config); a supervised or off node refuses. Paths are absolute or ~/…, at most 4096 bytes; the CLI refuses its own state and config files.";

export const FILE_ETAG_NOTICE =
  "Every result that touches a file carries etag. Pass it as expectedEtag to edit, write (ifExists replace), rename (overwrite) and delete; a stale etag returns error.code conflict with currentEtag. Line-range edits and replace require expectedEtag. Etags reset when the wsmp daemon restarts: after offline, re-read or file_stat before editing.";

export const FILE_UNKNOWN_OUTCOME_NOTICE =
  'If a write-class call fails with timeout, offline or io_error (error.outcome "unknown"), the change may or may not have been made: call forwarder_cli_file_stat with hash true and compare the etag before retrying. A retry that carries expectedEtag is safe (a stale etag returns conflict); an exact-match edit without expectedEtag is NOT idempotent, so check with file_stat first. The same applies to a write-class io_error or too_large (error.outcome "unknown").';

export const FILE_LIMITS_NOTICE =
  "Limits: 120 file operations per minute per user (30 changing ones), 4 at once per CLI and 16 per user; over the limit returns error.code limit with retryAfterMs. Operations are never queued and time out after 30 seconds.";

export const FILE_FRAME_NOTICE =
  "Every file tool request must fit one 64 KiB relay frame and the 1 MB /mcp request body cap, so a request with many long paths, a large search pattern or large edit text may have to be split or shortened.";

export const FILE_TOOL_NOTES: Readonly<Record<FileToolName, string>> = {
  forwarder_cli_file_read: `Reads a line-numbered window of a text file (default 400 lines or 32 KiB; maxBytes up to ${MCP_FILE_READ_MAX_BYTES}). A window of escape-dense text (quotes, backslashes or newlines) can exceed the result cap and return too_large, so use a smaller maxBytes for such files. A truncated result carries more with the arguments for the next call; ifNoneMatch with a previous etag returns {unchanged:true, etag}. ${FILE_ACCESS_NOTICE} ${FILE_MASKING_NOTICE} ${FILE_ETAG_NOTICE}`,
  forwarder_cli_file_stat: `Stats up to 50 paths (type, size, mtime, mode, owner; etag with hash true for files up to 64 MiB). ${FILE_FRAME_NOTICE} ${FILE_ACCESS_NOTICE} ${FILE_UNKNOWN_OUTCOME_NOTICE}`,
  forwarder_cli_dir_list: `Lists a directory as compact text, one entry per line (depth 1 to 4, glob, includeHidden, up to 2000 entries); more.cursor continues. Symlinked directories are not followed. ${FILE_FRAME_NOTICE} ${FILE_ACCESS_NOTICE}`,
  forwarder_cli_file_search: `Searches text files under a root (literal or regex, glob, up to 500 matches); binary, oversized and secret-class files are skipped and matches are masked. ${FILE_FRAME_NOTICE} ${FILE_ACCESS_NOTICE} ${FILE_MASKING_NOTICE}`,
  forwarder_cli_file_edit: `Exact-string and line-range edits (1 to 20, applied to the original content, all or nothing; line ranges require expectedEtag). ${FILE_FRAME_NOTICE} use file_write for large content. Optional reason (500 characters) goes to the CLI log. ${FILE_ACCESS_NOTICE} ${FILE_ETAG_NOTICE} ${FILE_UNKNOWN_OUTCOME_NOTICE} ${FILE_LIMITS_NOTICE} ${FILE_MASKING_NOTICE}`,
  forwarder_cli_file_write: `Creates a file, or replaces it with ifExists replace plus expectedEtag. content is utf-8 text or base64 (encoding), at most 1 MiB decoded; a base64 request encodes to more, and every /mcp request body is capped at 1 MB, so base64 content above roughly 768 KiB (786,432 bytes decoded) cannot be sent in one call. Content containing the mask token ⟦redacted is refused, and a secret-class path (dotenv or key file, or its directory) can never be created or replaced (secret_file). Optional reason (500 characters) goes to the CLI log. ${FILE_ACCESS_NOTICE} ${FILE_ETAG_NOTICE} ${FILE_UNKNOWN_OUTCOME_NOTICE} ${FILE_LIMITS_NOTICE}`,
  forwarder_cli_file_rename: `Renames within one filesystem; overwrite requires expectedEtag of the destination. Refused with secret_file on secret-class files and their directories (read-only masked views). Optional reason goes to the CLI log. ${FILE_ACCESS_NOTICE} ${FILE_ETAG_NOTICE} ${FILE_UNKNOWN_OUTCOME_NOTICE} ${FILE_LIMITS_NOTICE}`,
  forwarder_cli_dir_create: `Creates a directory (parents true creates missing parents). Refused with secret_file on secret-class files and their directories (read-only masked views). Optional reason goes to the CLI log. ${FILE_ACCESS_NOTICE} ${FILE_UNKNOWN_OUTCOME_NOTICE} ${FILE_LIMITS_NOTICE}`,
  forwarder_cli_file_delete: `Deletes a file, a symlink (never its target) or an empty directory; there is no recursive delete. Refused with secret_file on secret-class files and their directories (read-only masked views). Optional reason goes to the CLI log. ${FILE_ACCESS_NOTICE} ${FILE_ETAG_NOTICE} ${FILE_UNKNOWN_OUTCOME_NOTICE} ${FILE_LIMITS_NOTICE}`,
};
