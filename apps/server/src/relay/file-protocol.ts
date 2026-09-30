import { z } from "zod";

/**
 * Relay 2.8 node file tools (#103): the strict per-op argument and result
 * schemas, shared by the relay (frames), the MCP tool inputs (which add
 * `cliDeviceId`/`confirm`) and the cross-language fixtures under
 * `apps/cli/tests/fixtures/relay-2.8/file-*.json`. The Rust mirror is
 * `apps/cli/src/file_ops` (`FileOps::execute`) and `apps/cli/src/file_relay.rs`.
 *
 * Wire shape recap (control frames stay <= 64 KiB):
 * - S->C `file.op {opId, op, args, bodyBytes?, mode, readGrant}`: `mode` and
 *   `readGrant` are the admission verdict the CLI re-checks locally; write
 *   content is NOT in `args`, it follows as one binary `file.body {opId}` frame
 *   (<= 1 MiB).
 * - S->C `file.cancel {opId}`.
 * - C->S `file.result {opId, op, result, dataField?, bodyBytes?}`: when the
 *   large text field of the result is over 48 KiB the CLI sends it as a binary
 *   `file.data {opId}` frame and leaves that field empty in `result`;
 *   `dataField` names it (`text` | `matches` | `entries` | `diff`).
 * - C->S `file.rejected {opId, reason, detail?}`: `reason` is a file error
 *   code or one of {@link FILE_WIRE_REASONS} (`bad_frame`, `supervised_only`,
 *   `grant_disabled`, `feature_disabled`) that the CLI's own admission emits.
 */

export const FILE_INLINE_TEXT_MAX_BYTES = 48 * 1024;
export const FILE_BODY_MAX_BYTES = 1024 * 1024;
export const FILE_OP_DEADLINE_MS = 30_000;

export const FILE_OPS = [
  "read",
  "stat",
  "list",
  "search",
  "edit",
  "write",
  "rename",
  "mkdir",
  "delete",
] as const;
export type FileOp = (typeof FILE_OPS)[number];
export const fileOpSchema = z.enum(FILE_OPS);

/** Ops that change the filesystem (rate-limited separately, never retried). */
export const MUTATING_FILE_OPS: ReadonlySet<FileOp> = new Set([
  "edit",
  "write",
  "rename",
  "mkdir",
  "delete",
]);

export function isMutatingFileOp(op: FileOp): op is FileSpawnSpec["op"] {
  return MUTATING_FILE_OPS.has(op);
}

/** File error codes of `apps/cli/src/file_ops/error.rs`, plus wire-level refusals. */
export const FILE_ERROR_CODES = [
  "path_denied",
  "secret_file",
  "not_found",
  "not_a_file",
  "not_a_dir",
  "binary_file",
  "too_large",
  "conflict",
  "match_count",
  "no_match",
  "redacted_span",
  "exists",
  "hard_linked",
  "owner_mismatch",
  "setuid",
  "special_file",
  "io_error",
  "timeout",
  "invalid_input",
  "unsupported",
  "cancelled",
  "limit",
] as const;
export type FileErrorCode = (typeof FILE_ERROR_CODES)[number];

/**
 * Reasons only the CLI dispatcher produces (frame and mode re-checks). `admit`
 * in `apps/cli/src/file_relay.rs` chooses between `supervised_only`,
 * `grant_disabled` (the server's grant is off) and `feature_disabled` (the
 * CLI's own mode is off), so all three travel on the wire.
 */
export const FILE_WIRE_REASONS = [
  "bad_frame",
  "supervised_only",
  "grant_disabled",
  "feature_disabled",
] as const;

export const fileRejectReasonSchema = z.enum([...FILE_ERROR_CODES, ...FILE_WIRE_REASONS]);
export type FileRejectReason = z.infer<typeof fileRejectReasonSchema>;

const PATH_MAX_BYTES = 4096;

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** A path as the CLI accepts it: absolute or `~/…`, no NUL, at most 4096 bytes. */
export const filePathSchema = z
  .string()
  .min(1)
  .refine((value) => utf8Bytes(value) <= PATH_MAX_BYTES, "Path is longer than 4096 bytes.")
  .refine((value) => !value.includes("\0"), "Path must not contain NUL.");

/** An etag an agent passes back (`expectedEtag`, `ifNoneMatch`): any short token. */
const etagSchema = z.string().min(1).max(64);
/**
 * An etag the CLI reports: exactly the shape the library produces (`h:` strong
 * or `w:` weak plus 22 base64url characters). Anything else is refused, so a
 * hostile CLI cannot ride text into a result or a rejection detail.
 */
const reportedEtagSchema = z.string().regex(/^[hw]:[A-Za-z0-9_-]{22}$/);
const reasonSchema = z.string().max(500);
const modeStringSchema = z.string().regex(/^[0-7]{3,4}$/);
const uintSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const readArgsShape = {
  path: filePathSchema,
  startLine: z.number().int().min(-1_000_000).max(Number.MAX_SAFE_INTEGER).optional(),
  maxLines: z.number().int().min(1).max(2000).optional(),
  maxBytes: z.number().int().min(1).max(131072).optional(),
  byteOffset: uintSchema.optional(),
  lineNumbers: z.boolean().optional(),
  ifNoneMatch: etagSchema.optional(),
};
const statArgsShape = {
  paths: z.array(filePathSchema).min(1).max(50),
  hash: z.boolean().optional(),
};
const listArgsShape = {
  path: filePathSchema,
  depth: z.number().int().min(1).max(4).optional(),
  glob: z.string().min(1).max(512).optional(),
  includeHidden: z.boolean().optional(),
  maxEntries: z.number().int().min(1).max(2000).optional(),
  cursor: z.string().min(1).max(4096).optional(),
};
const searchArgsShape = {
  root: filePathSchema,
  pattern: z.string().min(1).max(1024),
  mode: z.enum(["literal", "regex"]).optional(),
  glob: z.string().min(1).max(512).optional(),
  caseInsensitive: z.boolean().optional(),
  contextLines: z.number().int().min(0).max(3).optional(),
  maxMatches: z.number().int().min(1).max(500).optional(),
  maxFiles: z.number().int().min(1).max(20_000).optional(),
};
export const fileEditItemSchema = z
  .object({
    oldText: z.string().min(1).optional(),
    newText: z.string(),
    expectedMatches: z.union([z.number().int().min(1).max(10_000), z.literal("all")]).optional(),
    startLine: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    endLine: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();
const editArgsShape = {
  path: filePathSchema,
  expectedEtag: etagSchema.optional(),
  edits: z.array(fileEditItemSchema).min(1).max(20),
  dryRun: z.boolean().optional(),
  returnDiff: z.boolean().optional(),
  reason: reasonSchema.optional(),
};
/** `content` and `encoding` are not in the relay args: the bytes ride in `file.body`. */
const writeRelayArgsShape = {
  path: filePathSchema,
  ifExists: z.enum(["fail", "replace"]).optional(),
  expectedEtag: etagSchema.optional(),
  mode: modeStringSchema.optional(),
  makeParents: z.boolean().optional(),
  returnDiff: z.boolean().optional(),
  reason: reasonSchema.optional(),
};
const renameArgsShape = {
  from: filePathSchema,
  to: filePathSchema,
  overwrite: z.boolean().optional(),
  expectedEtag: etagSchema.optional(),
  reason: reasonSchema.optional(),
};
const mkdirArgsShape = {
  path: filePathSchema,
  parents: z.boolean().optional(),
  mode: modeStringSchema.optional(),
  reason: reasonSchema.optional(),
};
const deleteArgsShape = {
  path: filePathSchema,
  expectedEtag: etagSchema.optional(),
  reason: reasonSchema.optional(),
};

/** MCP-tool input shapes (per op, without `cliDeviceId`/`confirm`), for reuse by the tool schemas. */
export const fileToolArgShapes = {
  read: readArgsShape,
  stat: statArgsShape,
  list: listArgsShape,
  search: searchArgsShape,
  edit: editArgsShape,
  write: {
    ...writeRelayArgsShape,
    content: z.string(),
    encoding: z.enum(["utf-8", "base64"]).optional(),
  },
  rename: renameArgsShape,
  mkdir: mkdirArgsShape,
  delete: deleteArgsShape,
} as const;

export const readArgsSchema = z.object(readArgsShape).strict();
export const statArgsSchema = z.object(statArgsShape).strict();
export const listArgsSchema = z.object(listArgsShape).strict();
export const searchArgsSchema = z.object(searchArgsShape).strict();
export const editArgsSchema = z.object(editArgsShape).strict();
export const writeRelayArgsSchema = z.object(writeRelayArgsShape).strict();
export const renameArgsSchema = z.object(renameArgsShape).strict();
export const mkdirArgsSchema = z.object(mkdirArgsShape).strict();
export const deleteArgsSchema = z.object(deleteArgsShape).strict();

const opId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{22}$/)
  .refine((value) => Buffer.from(value, "base64url").length === 16, {
    message: "Expected 16 bytes of base64url.",
  });

/** The `file.op` frame body, strict per op. `bodyBytes` is present exactly for `write`. */
const fileOpEnvelope = {
  type: z.literal("file.op"),
  opId,
  mode: z.enum(["off", "supervised", "unsupervised"]),
  readGrant: z.boolean(),
} as const;
export const fileOpFrameSchema = z.discriminatedUnion("op", [
  z.object({ ...fileOpEnvelope, op: z.literal("read"), args: readArgsSchema }).strict(),
  z.object({ ...fileOpEnvelope, op: z.literal("stat"), args: statArgsSchema }).strict(),
  z.object({ ...fileOpEnvelope, op: z.literal("list"), args: listArgsSchema }).strict(),
  z.object({ ...fileOpEnvelope, op: z.literal("search"), args: searchArgsSchema }).strict(),
  z.object({ ...fileOpEnvelope, op: z.literal("edit"), args: editArgsSchema }).strict(),
  z
    .object({
      ...fileOpEnvelope,
      op: z.literal("write"),
      args: writeRelayArgsSchema,
      bodyBytes: z.number().int().min(0).max(FILE_BODY_MAX_BYTES),
    })
    .strict(),
  z.object({ ...fileOpEnvelope, op: z.literal("rename"), args: renameArgsSchema }).strict(),
  z.object({ ...fileOpEnvelope, op: z.literal("mkdir"), args: mkdirArgsSchema }).strict(),
  z.object({ ...fileOpEnvelope, op: z.literal("delete"), args: deleteArgsSchema }).strict(),
]);
export type FileOpFrame = z.infer<typeof fileOpFrameSchema>;

export const fileCancelFrameSchema = z.object({ type: z.literal("file.cancel"), opId }).strict();

// ---------------------------------------------------------------------------
// Results (CLI -> server), strict per op.

function boundedText(max = FILE_INLINE_TEXT_MAX_BYTES) {
  return z.string().refine((value) => utf8Bytes(value) <= max, {
    message: "Inline text is longer than 48 KiB; it must travel as file.data.",
  });
}

const shortText = z.string().max(4096);
const mtimeSchema = z.string().max(64);

const readMoreSchema = z
  .object({ startLine: uintSchema, byteOffset: uintSchema.optional() })
  .strict();

export const readContentResultSchema = z
  .object({
    etag: reportedEtagSchema,
    size: uintSchema,
    mtime: mtimeSchema,
    mode: z.string().max(8),
    totalLines: uintSchema.nullable(),
    startLine: uintSchema.nullable(),
    endLine: uintSchema.nullable(),
    eol: z.enum(["lf", "crlf", "mixed", "none"]),
    text: boundedText(),
    redactions: uintSchema,
    more: readMoreSchema.nullable(),
    secretFile: z.boolean(),
    resolvedPath: shortText.optional(),
  })
  .strict();
export const readUnchangedResultSchema = z
  .object({ unchanged: z.literal(true), etag: reportedEtagSchema })
  .strict();
export const readResultSchema = z.union([readContentResultSchema, readUnchangedResultSchema]);

export const statEntrySchema = z
  .object({
    path: shortText,
    type: z.enum(["file", "dir", "symlink", "other"]).optional(),
    size: uintSchema.optional(),
    mtime: mtimeSchema.optional(),
    mode: z.string().max(8).optional(),
    owner: z.string().max(256).optional(),
    etag: reportedEtagSchema.optional(),
    target: shortText.optional(),
    targetType: z.enum(["file", "dir", "symlink", "other"]).optional(),
    resolvedPath: shortText.optional(),
    error: z.string().max(64).optional(),
  })
  .strict();
export const statResultSchema = z.object({ entries: z.array(statEntrySchema).max(50) }).strict();

export const listResultSchema = z
  .object({
    entries: boundedText(),
    count: uintSchema,
    more: z
      .object({ cursor: z.string().max(4096) })
      .strict()
      .nullable(),
    resolvedPath: shortText.optional(),
  })
  .strict();

export const searchResultSchema = z
  .object({
    matches: boundedText(),
    files: uintSchema,
    count: uintSchema,
    scannedFiles: uintSchema,
    more: z
      .object({ note: z.string().max(512) })
      .strict()
      .nullable(),
  })
  .strict();

export const editResultSchema = z
  .object({
    etag: reportedEtagSchema,
    previousEtag: reportedEtagSchema,
    added: uintSchema,
    removed: uintSchema,
    applied: z.boolean(),
    diff: boundedText().optional(),
    hunks: z
      .array(z.tuple([uintSchema, uintSchema]))
      .max(10_000)
      .optional(),
    resolvedPath: shortText.optional(),
  })
  .strict();

export const writeResultSchema = z
  .object({
    etag: reportedEtagSchema,
    size: uintSchema,
    created: z.boolean(),
    added: uintSchema.optional(),
    removed: uintSchema.optional(),
    diff: boundedText().optional(),
    resolvedPath: shortText.optional(),
  })
  .strict();

export const renameResultSchema = z.object({ etag: reportedEtagSchema.nullable() }).strict();
export const mkdirResultSchema = z.object({ created: z.boolean() }).strict();
export const deleteResultSchema = z
  .object({ deleted: z.boolean(), type: z.enum(["file", "dir", "symlink", "other"]) })
  .strict();

/** The text field of each op's result that may travel as `file.data`. */
export const FILE_DATA_FIELDS = {
  read: "text",
  list: "entries",
  search: "matches",
  edit: "diff",
  write: "diff",
} as const;
export type FileDataOp = keyof typeof FILE_DATA_FIELDS;
export const fileDataFieldSchema = z.enum(["text", "entries", "matches", "diff"]);

/** Headless `op` + `result`; supervised results use the metadata-only schema below. */
export const fileOpResultSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("read"), result: readResultSchema }).strict(),
  z.object({ op: z.literal("stat"), result: statResultSchema }).strict(),
  z.object({ op: z.literal("list"), result: listResultSchema }).strict(),
  z.object({ op: z.literal("search"), result: searchResultSchema }).strict(),
  z.object({ op: z.literal("edit"), result: editResultSchema }).strict(),
  z.object({ op: z.literal("write"), result: writeResultSchema }).strict(),
  z.object({ op: z.literal("rename"), result: renameResultSchema }).strict(),
  z.object({ op: z.literal("mkdir"), result: mkdirResultSchema }).strict(),
  z.object({ op: z.literal("delete"), result: deleteResultSchema }).strict(),
]);
export type FileOpResult = z.infer<typeof fileOpResultSchema>;

/**
 * The `file.result` frame. With `bodyBytes`, `dataField` names the (empty)
 * result field whose text follows as `file.data`.
 */
export const fileResultFrameSchema = z
  .object({
    type: z.literal("file.result"),
    opId,
    op: fileOpSchema,
    result: z.record(z.string(), z.unknown()),
    dataField: fileDataFieldSchema.optional(),
    bodyBytes: z.number().int().min(1).max(FILE_BODY_MAX_BYTES).optional(),
  })
  .strict()
  .superRefine((frame, ctx) => {
    const parsed = fileOpResultSchema.safeParse({ op: frame.op, result: frame.result });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({
          code: "custom",
          message: issue.message,
          path: ["result", ...issue.path.slice(1)],
        });
      }
    }
    if ((frame.bodyBytes === undefined) !== (frame.dataField === undefined)) {
      ctx.addIssue({ code: "custom", message: "bodyBytes and dataField go together." });
    }
    if (frame.dataField !== undefined) {
      const expected =
        frame.op in FILE_DATA_FIELDS ? FILE_DATA_FIELDS[frame.op as FileDataOp] : null;
      if (expected !== frame.dataField) {
        ctx.addIssue({ code: "custom", message: "dataField does not belong to this op." });
      }
    }
  });
export type FileResultFrame = z.infer<typeof fileResultFrameSchema>;

/** Small strict detail object of a rejection (the union of the P1 error details). */
export const fileRejectDetailSchema = z
  .object({
    // The library reports the words `replaced` / `gone` when the file was swapped or removed mid-edit.
    currentEtag: z.union([reportedEtagSchema, z.enum(["replaced", "gone"])]).optional(),
    etag: reportedEtagSchema.optional(),
    size: uintSchema.optional(),
    sniff: z.string().max(32).optional(),
    edit: uintSchema.optional(),
    nearestLine: uintSchema.optional(),
    line: uintSchema.optional(),
    expected: z.union([uintSchema, z.string().max(16)]).optional(),
    found: uintSchema.optional(),
    lines: z.array(uintSchema).max(5).optional(),
    retryAfterMs: uintSchema.optional(),
  })
  .strict();
export type FileRejectDetail = z.infer<typeof fileRejectDetailSchema>;

export const fileRejectedFrameSchema = z
  .object({
    type: z.literal("file.rejected"),
    opId,
    reason: fileRejectReasonSchema,
    detail: fileRejectDetailSchema.optional(),
  })
  .strict();

// Binary frame metadata.
export const fileBodyMetadataSchema = z.object({ type: z.literal("file.body"), opId }).strict();
export const fileDataMetadataSchema = z.object({ type: z.literal("file.data"), opId }).strict();

/** The strict supervised-file payload: only filesystem mutations. */
export const fileSpawnSpecSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("edit"), args: editArgsSchema }).strict(),
  z.object({ op: z.literal("write"), args: writeRelayArgsSchema }).strict(),
  z.object({ op: z.literal("rename"), args: renameArgsSchema }).strict(),
  z.object({ op: z.literal("mkdir"), args: mkdirArgsSchema }).strict(),
  z.object({ op: z.literal("delete"), args: deleteArgsSchema }).strict(),
]);

export type FileSpawnSpec = z.infer<typeof fileSpawnSpecSchema>;

/** No read grant is implied by approval: file content stays on the CLI screen. */
export const supervisedFileResultSchema = z.discriminatedUnion("op", [
  z
    .object({ op: z.literal("edit"), result: editResultSchema.omit({ diff: true, hunks: true }) })
    .strict(),
  z.object({ op: z.literal("write"), result: writeResultSchema.omit({ diff: true }) }).strict(),
  z.object({ op: z.literal("rename"), result: renameResultSchema }).strict(),
  z.object({ op: z.literal("mkdir"), result: mkdirResultSchema }).strict(),
  z.object({ op: z.literal("delete"), result: deleteResultSchema }).strict(),
]);
export type SupervisedFileResult = z.infer<typeof supervisedFileResultSchema>;
export const supervisedFileErrorSchema = z.object({ code: z.enum(FILE_ERROR_CODES) }).strict();

/** Only frame/path-string refusals are allowed before the person's keypress. */
export const supervisedFileRejectReasonSchema = z.enum([
  "disabled",
  "unsupported",
  "limit",
  "already_open",
  "spawn_failed",
  "bad_command",
  "bad_frame",
  "invalid_input",
  "path_denied",
  "secret_file",
  "too_large",
  "redacted_span",
  "special_file",
]);
