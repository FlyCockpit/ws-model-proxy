/**
 * Node file tools (`nodes.files.read/write/edit`, MCP `node_file_read/_write/_edit`): agents
 * configure a node without SSH, over relay 3.0 `file.op`.
 *
 * Layers, each checked on its own:
 * - here: a FULL agent credential (people use a browser terminal), the caller's own node, and
 *   the node at Full control as stored (a pending lowering counts as Relay); the tool input is
 *   mapped to the relay args of one op;
 * - the server (`apps/server/src/relay/node-file-ops.ts`): the live credential and owner, the
 *   stored and live trust, the live session's owner, file roots, the per-user and per-node
 *   limits, the 1 MiB body and 64 KiB frame caps and every path under the node's roots; it
 *   writes the `NodeAuditEvent` row (path, size, outcome, credential; never content);
 * - the node (`apps/cli/src/file_ops`): its own trust and roots, its deny list (wsmp config,
 *   credentials, secrets, runtime stores, the whole state directory), symlink-safe resolution
 *   and its own size limits.
 *
 * File content is never logged, stored or put into an error message here.
 */
import { ORPCError } from "@orpc/server";
import prisma from "@ws-model-proxy/db";
import type { z } from "zod";
import type {
  Context,
  NodeFileCredential,
  NodeFileOp,
  NodeFileOutcome,
  NodeFileRunInput,
  NodeFileServices,
} from "../context";
import { contractProcedure, type SignedInContext } from "../contract-procedure";
import type { CallerAuth } from "../contracts/auth-context";
import {
  nodesContract as c,
  type nodeFileEditInputSchema,
  type nodeFileMutationOutputSchema,
  type nodeFileReadInputSchema,
  type nodeFileReadOutputSchema,
  type nodeFileWriteInputSchema,
} from "../contracts/nodes";
import { notFound, refuseAbout } from "../lib/refuse";

/** A write's content, decoded (the relay carries at most one 1 MiB `file.body`). */
const NODE_FILE_BODY_MAX_BYTES = 1024 * 1024;
/** `search` returns at most this many matches per call (the relay's `maxMatches`). */
const SEARCH_MAX_MATCHES = 500;
/** `list` depth (the relay's `depth`). */
const LIST_MAX_DEPTH = 4;

type ReadInput = z.infer<typeof nodeFileReadInputSchema>;
type WriteInput = z.infer<typeof nodeFileWriteInputSchema>;
type EditInput = z.infer<typeof nodeFileEditInputSchema>;
type ReadOutput = z.infer<typeof nodeFileReadOutputSchema>;
type MutationOutput = z.infer<typeof nodeFileMutationOutputSchema>;

function services(context: Context): NodeFileServices {
  const files = context.services?.nodeFiles;
  if (!files) {
    throw new ORPCError("SERVICE_UNAVAILABLE", {
      message: "Node file tools are not available on this server.",
    });
  }
  return files;
}

/**
 * The agent credential behind the call. File tools need a FULL agent token or OAuth grant: a
 * person (cookie session) uses a browser terminal instead, so no cookie ever reaches a node's
 * files through these procedures.
 */
function fileCredential(auth: CallerAuth | { kind: "anonymous" }): NodeFileCredential {
  if (auth.kind === "agent_token" || auth.kind === "oauth_access_token") {
    if (auth.level !== "FULL") {
      throw new ORPCError("FORBIDDEN", { message: "Node file tools need a Full agent token." });
    }
    return auth.kind === "agent_token"
      ? { kind: "agent_token", id: auth.agentTokenId }
      : { kind: "oauth_grant", id: auth.grantId };
  }
  throw new ORPCError("FORBIDDEN", {
    message: "Node file tools are for agents with a Full token; people use a browser terminal.",
  });
}

type OwnedNode = { id: string; slug: string; fullControl: boolean };

/**
 * The caller's node, looked up under the caller only, and whether it is at Full control as
 * stored (a pending lowering counts as Relay; the server checks the live session too).
 */
async function ownedNode(userId: string, nodeId: string): Promise<OwnedNode> {
  const node = await prisma.node.findFirst({
    where: { id: nodeId, userId },
    select: { id: true, slug: true, trust: true, trustLowerRequestedAt: true },
  });
  if (!node) throw notFound("That node does not exist.");
  return {
    id: node.id,
    slug: node.slug,
    fullControl: node.trust === "FULL" && node.trustLowerRequestedAt === null,
  };
}

// ── Input mapping (tool input -> relay args of one op) ──

type Mapped = { op: NodeFileOp; args: Record<string, unknown>; body?: Uint8Array };

class FileInputError extends Error {
  constructor(
    message: string,
    readonly op: NodeFileOp,
    readonly args: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FileInputError";
  }
}

/** Drops undefined values, so the relay's strict args see only what was given. */
function defined(source: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined));
}

function onlyFor(
  op: NodeFileOp,
  args: Record<string, unknown>,
  fields: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined && !allowed.includes(name)) {
      throw new FileInputError(`${name} does not apply to op ${op}.`, op, args);
    }
  }
}

function mapReadInput(input: ReadInput): Mapped {
  const fields = {
    offset: input.offset,
    limit: input.limit,
    pattern: input.pattern,
    ifNoneMatch: input.ifNoneMatch,
  };
  switch (input.op) {
    case "read": {
      const args = defined({
        path: input.path,
        startLine: input.offset,
        maxLines: input.limit,
        ifNoneMatch: input.ifNoneMatch,
      });
      onlyFor("read", args, fields, ["offset", "limit", "ifNoneMatch"]);
      return { op: "read", args };
    }
    case "stat": {
      // The hash makes the etag a later write or edit names (ifMatch).
      const args = { paths: [input.path], hash: true };
      onlyFor("stat", args, fields, []);
      return { op: "stat", args };
    }
    case "list": {
      const args = defined({
        path: input.path,
        depth: input.offset,
        glob: input.pattern,
        maxEntries: input.limit,
      });
      onlyFor("list", args, fields, ["offset", "limit", "pattern"]);
      if (input.offset !== undefined && (input.offset < 1 || input.offset > LIST_MAX_DEPTH)) {
        throw new FileInputError(`list depth (offset) is 1 to ${LIST_MAX_DEPTH}.`, "list", args);
      }
      return { op: "list", args };
    }
    case "search": {
      const args = defined({
        root: input.path,
        pattern: input.pattern,
        maxMatches:
          input.limit === undefined ? undefined : Math.min(input.limit, SEARCH_MAX_MATCHES),
      });
      onlyFor("search", args, fields, ["limit", "pattern"]);
      if (input.pattern === undefined) {
        throw new FileInputError("search needs a pattern.", "search", args);
      }
      return { op: "search", args };
    }
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Strict base64 (canonical padding), or null. */
function decodeBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0 || !BASE64.test(text)) return null;
  const bytes = Buffer.from(text, "base64");
  return bytes.toString("base64") === text ? new Uint8Array(bytes) : null;
}

function mapWriteInput(input: WriteInput): Mapped {
  const fields = { content: input.content, encoding: input.encoding, to: input.to };
  const reason = input.note;
  switch (input.op) {
    case "write": {
      // Without ifMatch a write only creates (an existing file is `exists`); with it, it
      // replaces exactly the version the agent read.
      const args = defined({
        path: input.path,
        ifExists: input.ifMatch === undefined ? "fail" : "replace",
        expectedEtag: input.ifMatch,
        returnDiff: input.ifMatch === undefined ? undefined : true,
        reason,
      });
      onlyFor("write", args, fields, ["content", "encoding"]);
      const content = input.content ?? "";
      let body: Uint8Array | null;
      if (input.encoding === "base64") {
        body = decodeBase64(content);
        if (body === null) throw new FileInputError("content is not valid base64.", "write", args);
      } else {
        if (LONE_SURROGATE.test(content)) {
          throw new FileInputError("content is not well-formed UTF-8 text.", "write", args);
        }
        body = new TextEncoder().encode(content);
      }
      if (body.byteLength > NODE_FILE_BODY_MAX_BYTES) {
        throw new FileInputError("content is larger than 1 MiB.", "write", args);
      }
      return { op: "write", args, body };
    }
    case "mkdir": {
      const args = defined({ path: input.path, parents: true, reason });
      onlyFor("mkdir", args, { ...fields, ifMatch: input.ifMatch }, []);
      return { op: "mkdir", args };
    }
    case "rename": {
      const args = defined({
        from: input.path,
        to: input.to,
        expectedEtag: input.ifMatch,
        reason,
      });
      onlyFor("rename", args, fields, ["to"]);
      return { op: "rename", args };
    }
    case "delete": {
      const args = defined({ path: input.path, expectedEtag: input.ifMatch, reason });
      onlyFor("delete", args, fields, []);
      return { op: "delete", args };
    }
  }
}

function mapEditInput(input: EditInput): Mapped {
  return {
    op: "edit",
    args: defined({
      path: input.path,
      expectedEtag: input.ifMatch,
      edits: input.edits.map((edit) =>
        defined({ oldText: edit.old, newText: edit.new, expectedMatches: edit.count }),
      ),
      returnDiff: true,
      reason: input.note,
    }),
  };
}

// ── Outcomes ──

type FileErrorStatus =
  | "BAD_REQUEST"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "TOO_MANY_REQUESTS"
  | "PRECONDITION_FAILED";

/** Fixed text per code: never file content, never caller input. */
const FILE_ERRORS: Readonly<Record<string, { status: FileErrorStatus; message: string }>> = {
  token_inactive: {
    status: "FORBIDDEN",
    message: "This credential was revoked or expired, or its account is blocked.",
  },
  trust_relay: {
    status: "FORBIDDEN",
    message: "The node is Relay only: files need Full control.",
  },
  node_offline: { status: "CONFLICT", message: "The node is offline." },
  upgrade_wsmp: {
    status: "CONFLICT",
    message: "The node runs an older wsmp: upgrade it to use file tools.",
  },
  no_roots: {
    status: "CONFLICT",
    message:
      "The node serves no file roots: run `wsmp config set-file-roots <dir>...` on it and restart wsmp.",
  },
  limit: { status: "TOO_MANY_REQUESTS", message: "Too many file operations right now." },
  invalid_input: { status: "BAD_REQUEST", message: "The node refused this file request." },
  path_denied: {
    status: "FORBIDDEN",
    message:
      "That path is outside the node's file roots or protected (wsmp's own config, credentials and state are off limits). Use an absolute path under a file root: `~` and relative paths are not expanded (node_get lists the roots under features.files.roots).",
  },
  secret_file: {
    status: "FORBIDDEN",
    message: "Secret files and their folders are read-only through the file tools.",
  },
  not_found: { status: "NOT_FOUND", message: "No such file or folder on the node." },
  not_a_file: { status: "BAD_REQUEST", message: "That path is not a regular file." },
  not_a_dir: { status: "BAD_REQUEST", message: "That path is not a folder." },
  binary_file: { status: "BAD_REQUEST", message: "That file is binary; read and edit text only." },
  too_large: { status: "BAD_REQUEST", message: "That file or result is too large." },
  conflict: {
    status: "CONFLICT",
    message: "The file changed since you read it: read it again and retry with the new etag.",
  },
  exists: {
    status: "CONFLICT",
    message: "That path exists: pass ifMatch with its etag to replace it.",
  },
  match_count: {
    status: "BAD_REQUEST",
    message: "An edit's text matched a different number of times than expected.",
  },
  no_match: { status: "BAD_REQUEST", message: "An edit's text was not found in the file." },
  redacted_span: {
    status: "BAD_REQUEST",
    message: "An edit touches text that was masked as a secret when read.",
  },
  hard_linked: { status: "FORBIDDEN", message: "The file has other hard links." },
  owner_mismatch: { status: "FORBIDDEN", message: "The file belongs to another user." },
  setuid: { status: "FORBIDDEN", message: "The file is setuid or setgid." },
  special_file: { status: "FORBIDDEN", message: "That path is not a regular file or folder." },
  unsupported: { status: "FORBIDDEN", message: "The node does not support this file request." },
  unsafe_filesystem: {
    status: "FORBIDDEN",
    message: "The node refused this path's filesystem as unsafe.",
  },
  timeout: { status: "CONFLICT", message: "The file operation timed out." },
  cancelled: { status: "CONFLICT", message: "The file operation was cancelled." },
  io_error: { status: "CONFLICT", message: "The node could not complete the file operation." },
  uncertain_outcome: {
    status: "CONFLICT",
    message: "The node could not tell whether the change was made.",
  },
};

const REPORTED_ETAG = /^[hw]:[A-Za-z0-9_-]{22}$/;
/**
 * A node path shown in a message: absolute, plain characters only (no spaces, no prose), so a
 * file name an agent chose earlier cannot carry instructions into another agent's error.
 */
const SAFE_PATH = /^\/[A-Za-z0-9._@%+=:,~/-]{0,1023}$/;

function failure(
  nodeId: string,
  outcome: Extract<NodeFileOutcome, { ok: false }>,
): ORPCError<FileErrorStatus, unknown> {
  const known = FILE_ERRORS[outcome.code];
  const code = known ? outcome.code : "io_error";
  const status = known?.status ?? "CONFLICT";
  const parts = [known?.message ?? "The node could not complete the file operation."];
  const detail = outcome.detail ?? {};
  const currentEtag = detail.currentEtag;
  if (code === "conflict" && typeof currentEtag === "string" && REPORTED_ETAG.test(currentEtag)) {
    parts.push(`Current etag: ${currentEtag}.`);
  }
  if (typeof outcome.retryAfterMs === "number") {
    parts.push(`Retry after ${Math.ceil(outcome.retryAfterMs / 1000)} s.`);
  }
  const recovery = detail.recovery;
  if (typeof recovery === "string" && SAFE_PATH.test(recovery)) {
    parts.push(`The previous content is kept at ${recovery}.`);
  }
  const roots = (outcome.roots ?? []).filter((root) => SAFE_PATH.test(root));
  if (code === "path_denied" && roots.length > 0) {
    parts.push(`File roots: ${roots.join(", ")}.`);
  }
  if (outcome.outcome === "unknown") {
    parts.push("The change may or may not have been made: stat the path before retrying.");
  }
  return new ORPCError(status, {
    message: parts.join(" "),
    data: {
      reason: code,
      subjectId: nodeId,
      ...(outcome.outcome === "unknown" ? { outcome: "unknown" } : {}),
      ...(typeof outcome.retryAfterMs === "number" ? { retryAfterMs: outcome.retryAfterMs } : {}),
    },
  });
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readOutput(op: ReadOutput["op"], result: Record<string, unknown>): ReadOutput {
  let etag = stringOrNull(result.etag);
  if (op === "stat" && Array.isArray(result.entries)) {
    const first: unknown = result.entries[0];
    etag =
      first !== null && typeof first === "object" ? stringOrNull(Reflect.get(first, "etag")) : null;
  }
  return { op, etag, result };
}

function mutationOutput(result: Record<string, unknown>): MutationOutput {
  return { etag: stringOrNull(result.etag), diff: stringOrNull(result.diff) };
}

/**
 * Owner, input and trust checks, then one op through the server. A refusal on the caller's
 * own node is audited like a refusal at the server; an unknown (or another owner's) node id
 * names no node of the caller, so nothing is recorded for it.
 */
async function runOne(
  context: SignedInContext,
  nodeId: string,
  map: () => Mapped,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const credential = fileCredential(context.auth);
  const userId = context.session.user.id;
  const node = await ownedNode(userId, nodeId);
  const files = services(context);
  let mapped: Mapped;
  try {
    mapped = map();
  } catch (error) {
    if (!(error instanceof FileInputError)) throw error;
    files.auditRefused({
      userId,
      credential,
      nodeId: node.id,
      op: error.op,
      args: error.args,
      reason: "invalid_input",
    });
    throw new ORPCError("BAD_REQUEST", {
      message: error.message,
      data: { reason: "invalid_input", subjectId: node.id },
    });
  }
  if (!node.fullControl) {
    files.auditRefused({
      userId,
      credential,
      nodeId: node.id,
      op: mapped.op,
      args: mapped.args,
      reason: "trust_relay",
    });
    throw refuseAbout(
      "trust_relay",
      node.id,
      `Node ${node.slug} is Relay only: commands, files and browser terminals need Full control.`,
      "FORBIDDEN",
    );
  }
  const run: NodeFileRunInput = {
    userId,
    credential,
    nodeId: node.id,
    op: mapped.op,
    args: mapped.args,
    ...(mapped.body ? { body: mapped.body } : {}),
    ...(signal ? { signal } : {}),
  };
  const outcome = await files.run(run);
  if (!outcome.ok) throw failure(node.id, outcome);
  return outcome.result;
}

function requestSignal(context: Context, signal: AbortSignal | undefined): AbortSignal | undefined {
  const signals = [signal, context.services?.signal].filter(
    (entry): entry is AbortSignal => entry !== undefined,
  );
  if (signals.length === 0) return undefined;
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

export const fileProcedures = {
  read: contractProcedure(c.files.read).handler(async ({ context, input, signal }) => {
    const result = await runOne(
      context,
      input.nodeId,
      () => mapReadInput(input),
      requestSignal(context, signal),
    );
    return readOutput(input.op, result);
  }),
  write: contractProcedure(c.files.write).handler(async ({ context, input, signal }) => {
    const result = await runOne(
      context,
      input.nodeId,
      () => mapWriteInput(input),
      requestSignal(context, signal),
    );
    return mutationOutput(result);
  }),
  edit: contractProcedure(c.files.edit).handler(async ({ context, input, signal }) => {
    const result = await runOne(
      context,
      input.nodeId,
      () => mapEditInput(input),
      requestSignal(context, signal),
    );
    return mutationOutput(result);
  }),
};
