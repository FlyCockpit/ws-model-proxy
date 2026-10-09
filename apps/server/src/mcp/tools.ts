/**
 * The 0.4.0 MCP tools: exactly the 28 tools of `MCP_TOOLS`
 * (packages/api/src/contracts/mcp-tools.ts), registered on every per-request server.
 *
 * Exports for the server wiring:
 * - `registerMcpTools(server, ctx)`: the transport factory's `registerTools` seam
 *   (mcp/handler.ts). It lists the tools the request's level may call: READ tokens the 7
 *   read tools, FULL tokens all 28.
 * - `cancelMcpToolCallsForToken(credentialId)`: aborts the in-flight tool calls of one
 *   agent token or OAuth grant (call it when the token is revoked).
 * - `cancelMcpWriteToolCallsForGrant(grantId)`: aborts the in-flight write tool calls of an
 *   OAuth grant lowered from Full to Read-only.
 * - `runMcpTool(contract, state)`: one call through the wrapper chain (tests drive it).
 *
 * The wrapper chain of one call:
 *   1. dispatch: the verified request's oRPC context (mcp/tool-dispatch.ts); none → fail closed;
 *   2. level: a FULL tool on a READ credential answers like an unknown tool;
 *   3. rate limit (`contract.rateLimit`, per credential and key);
 *   4. input: the tool's contract schema; errors name the field path, never the value;
 *   5. route: the procedures in `contract.procedures` (see `routeToolCall`), each called
 *      through the bound oRPC router with the agent `CallerAuth`, inside the DB abort fence
 *      and raced against the request's signal;
 *   6. output: redact → JSON-safe → size cap; errors: refusals keep their fixed message and
 *      reason, validation failures list `{path, message}` issues, other 4xx codes keep the
 *      procedure's (developer-written) message; a sensitive tool gets static text only.
 *
 * Secrets: a tool with `sensitiveInput` (node_secret_set) and the procedures in
 * `SENSITIVE_INPUT_PROCEDURES` never have their input logged, audited or echoed. No tool's
 * arguments are ever logged; validation errors carry paths and messages (sensitive tools: paths
 * and codes only).
 *
 * tools/list advertises the name, the contract description and the compact input schema
 * (`advertisedInputSchema`), nothing else (no titles, annotations or output schemas): the
 * token budget is pinned by mcp/tools-budget.test.ts.
 */

import type {
  CallToolResult,
  McpRequestContext,
  McpServer,
  StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { call, getRouter, isProcedure, ORPCError } from "@orpc/server";
import {
  advertisedInputSchema,
  MCP_READ_TOOLS,
  MCP_TOOLS,
  type McpToolContract,
  SENSITIVE_INPUT_PROCEDURES,
} from "@ws-model-proxy/api/contracts";
import { appRouter } from "@ws-model-proxy/api/routers/index";
import { runWithDbAbortFence } from "@ws-model-proxy/db/shutdown-fence";
import { RateLimiterMemory, RateLimiterRes } from "rate-limiter-flexible";
import { z } from "zod";
import type { McpContext, McpRequestCredential } from "./context";
import { mcpSanitizedLog } from "./errors";
import { redactSecrets } from "./redaction";
import { toJsonSafe } from "./serialization";
import { type McpToolDispatch, resolveMcpToolDispatch } from "./tool-dispatch";

type ToolResult = CallToolResult;

/** Hard cap on one tool's serialized output. */
export const MCP_TOOL_OUTPUT_MAX_BYTES = 256 * 1024;
/** Headroom for the fields the SDK adds after the check (resultType, `_meta`). */
export const MCP_TOOL_OUTPUT_SDK_HEADROOM_BYTES = 1024;
const OUTPUT_BUDGET_BYTES = MCP_TOOL_OUTPUT_MAX_BYTES - MCP_TOOL_OUTPUT_SDK_HEADROOM_BYTES;

const READ_TOOL_NAMES: ReadonlySet<string> = new Set(MCP_READ_TOOLS);

// ── tools/list ──

/**
 * A standard schema that advertises the compact JSON Schema and accepts any arguments: the
 * wrapper validates with the contract schema itself, so the SDK never echoes a validation
 * message (which could carry an argument).
 */
function advertisedSchema(contract: McpToolContract): StandardSchemaWithJSON {
  // The contract input as JSON Schema, compact fields replaced (the procedure validates them).
  const json = advertisedInputSchema(contract);
  return {
    "~standard": {
      version: 1,
      vendor: "ws-model-proxy",
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: () => json, output: () => json },
    },
  };
}

/** Whether a credential of this level may see and call the tool. */
export function mcpToolAllowed(name: string, level: "READ" | "FULL"): boolean {
  return level === "FULL" || READ_TOOL_NAMES.has(name);
}

/**
 * Registers the tools this request's credential may call. Without a verified dispatch only
 * the read tools are listed, and every call fails closed.
 */
export function registerMcpTools(server: McpServer, ctx?: McpRequestContext): void {
  const dispatch = resolveMcpToolDispatch(ctx?.authInfo);
  const level = dispatch?.credential.level ?? "READ";
  for (const contract of MCP_TOOLS) {
    if (!mcpToolAllowed(contract.name, level)) continue;
    server.registerTool<StandardSchemaWithJSON, StandardSchemaWithJSON>(
      contract.name,
      { description: contract.description, inputSchema: advertisedSchema(contract) },
      async (args: unknown): Promise<ToolResult> => runMcpTool(contract, { dispatch, args }),
    );
  }
}

// ── in-flight calls per credential (revocation) ──

/** One in-flight call; `write`: a FULL-only tool (lowering a grant ends these). */
type InFlightCall = { controller: AbortController; write: boolean };
const inFlight = new Map<string, Set<InFlightCall>>();

function credentialId(credential: McpRequestCredential): string {
  return credential.kind === "agent_token" ? credential.tokenId : credential.grantId;
}

/**
 * Credentials revoked recently: a call that passed its credential check before the revocation
 * committed but registers after it (the rate-limit read sits in between) is aborted at once.
 * Revocation is permanent, so a few minutes covers every request already past its check.
 * Per process, like `inFlight` (one server instance per deployment).
 */
const REVOKED_REMEMBER_MS = 5 * 60_000;
const recentlyRevoked = new Map<string, number>();

/** Insertion order is expiry order (one window for all): stop at the first live entry. */
function pruneRevoked(now: number) {
  for (const [key, until] of recentlyRevoked) {
    if (until > now) return;
    recentlyRevoked.delete(key);
  }
}

function revokedRecently(id: string, now = Date.now()): boolean {
  pruneRevoked(now);
  return (recentlyRevoked.get(id) ?? 0) > now;
}

/** Aborts every in-flight tool call of one agent token id or OAuth grant id. */
export function cancelMcpToolCallsForToken(id: string): number {
  const now = Date.now();
  pruneRevoked(now);
  // Re-inserted at the end so the map stays in expiry order.
  recentlyRevoked.delete(id);
  recentlyRevoked.set(id, now + REVOKED_REMEMBER_MS);
  const calls = inFlight.get(id);
  if (!calls) return 0;
  for (const call of calls) call.controller.abort();
  inFlight.delete(id);
  return calls.size;
}

/**
 * OAuth grants lowered from Full to Read-only recently: grant id → `performance.now()` taken
 * after the lowering committed. A write call whose request read the grant's level BEFORE that
 * (`levelReadAt`, taken before the read) still carries the stale FULL; it is aborted when it
 * registers. Requests that read the level later see READ and never reach a write tool. A few
 * minutes covers every request between its level read and its call registration.
 */
const LOWERED_REMEMBER_MS = 5 * 60_000;
const recentlyLowered = new Map<string, number>();

/** Insertion order is lowering order (one window for all): stop at the first live entry. */
function pruneLowered(now: number) {
  for (const [key, at] of recentlyLowered) {
    if (at + LOWERED_REMEMBER_MS > now) return;
    recentlyLowered.delete(key);
  }
}

function loweredSinceLevelRead(credential: McpRequestCredential): boolean {
  if (credential.kind !== "oauth") return false;
  pruneLowered(performance.now());
  const at = recentlyLowered.get(credential.grantId);
  return at !== undefined && at >= credential.levelReadAt;
}

/**
 * An OAuth grant was lowered from Full to Read-only (committed): aborts its in-flight write
 * (FULL-only) tool calls and any write call still registering with the stale level. Read calls
 * go on; a later raise is honored from the next request (its level read is newer).
 */
export function cancelMcpWriteToolCallsForGrant(grantId: string): number {
  const now = performance.now();
  pruneLowered(now);
  // Re-inserted at the end so the map stays in lowering order.
  recentlyLowered.delete(grantId);
  recentlyLowered.set(grantId, now);
  const calls = inFlight.get(grantId);
  if (!calls) return 0;
  let aborted = 0;
  for (const call of calls) {
    if (!call.write) continue;
    call.controller.abort();
    aborted += 1;
  }
  return aborted;
}

function trackCall(
  credential: McpRequestCredential,
  parent: AbortSignal | undefined,
  write: boolean,
) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (
    parent?.aborted ||
    revokedRecently(credentialId(credential)) ||
    (write && loweredSinceLevelRead(credential))
  )
    controller.abort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  const id = credentialId(credential);
  const set = inFlight.get(id) ?? new Set<InFlightCall>();
  const call: InFlightCall = { controller, write };
  set.add(call);
  inFlight.set(id, set);
  return {
    signal: controller.signal,
    done: () => {
      parent?.removeEventListener("abort", onAbort);
      set.delete(call);
      if (set.size === 0 && inFlight.get(id) === set) inFlight.delete(id);
    },
  };
}

// ── rate limits ──

const limiters = new Map<string, RateLimiterMemory>();

function limiterFor(key: string, perMinute: number): RateLimiterMemory {
  const name = `${key}:${perMinute}`;
  let limiter = limiters.get(name);
  if (!limiter) {
    limiter = new RateLimiterMemory({ points: perMinute, duration: 60 });
    limiters.set(name, limiter);
  }
  return limiter;
}

/** Test-only: forget every rate-limit counter. */
export function resetMcpToolRateLimitsForTests(): void {
  limiters.clear();
}

async function consumeRateLimit(
  contract: McpToolContract,
  credential: McpRequestCredential,
  args: Record<string, unknown>,
): Promise<number | null> {
  const limit = contract.rateLimit;
  if (!limit) return null;
  if (limit.onlyWhen !== undefined && !args[limit.onlyWhen]) return null;
  try {
    await limiterFor(limit.key, limit.perMinute).consume(credentialId(credential));
    return null;
  } catch (rejection) {
    if (rejection instanceof RateLimiterRes) return Math.ceil(rejection.msBeforeNext / 1000);
    throw rejection;
  }
}

// ── routing to procedures ──

/** One procedure call a tool makes. */
export type ProcedureCall = { path: string; input: Record<string, unknown> };

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

function omit(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source))
    if (!keys.includes(key) && value !== undefined) out[key] = value;
  return out;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The procedure calls of one validated tool input, in order. A single-procedure tool passes
 * its input as is (`confirm` included: the procedures check it too); the others pick by input:
 * - *_get tools: an id → `get` (with `versions` / `history` → the list beside it), else `list`;
 * - runtime_create: `forkFrom` → runtimes.fork, else runtimes.create (kind defaults from
 *   nodeId: always-on with a node, else startable);
 * - runtime_update: runtimes.update, then runtimes.models.setCapabilities per entry;
 * - pool_update: `contribute` → addContributed / removeContributed per id, any other change
 *   → pools.update first;
 * - runtime_stop: `markStopped` → runtimes.instances.markStopped, else runtimes.stop;
 * - node_secret_set: value null → nodes.secrets.delete, else nodes.secrets.set.
 */
export function routeToolCall(name: string, args: Record<string, unknown>): ProcedureCall[] {
  switch (name) {
    case "nodes_get":
      return args.nodeId === undefined
        ? [{ path: "nodes.list", input: {} }]
        : [{ path: "nodes.get", input: pick(args, ["nodeId"]) }];
    case "runtimes_get": {
      if (args.presets) return [{ path: "runtimes.presets.list", input: {} }];
      if (args.shared) return [{ path: "runtimes.shares.list", input: pick(args, ["runtimeId"]) }];
      if (args.versionId !== undefined)
        return [{ path: "runtimes.versions.get", input: pick(args, ["versionId"]) }];
      if (args.runtimeId === undefined) return [{ path: "runtimes.list", input: {} }];
      const get: ProcedureCall = { path: "runtimes.get", input: pick(args, ["runtimeId"]) };
      return args.versions
        ? [get, { path: "runtimes.versions.list", input: pick(args, ["runtimeId"]) }]
        : [get];
    }
    case "pools_get": {
      if (args.aliases) return [{ path: "pools.aliases.list", input: {} }];
      if (args.poolId === undefined) return [{ path: "pools.list", input: {} }];
      const get: ProcedureCall = { path: "pools.get", input: pick(args, ["poolId"]) };
      return args.history
        ? [get, { path: "pools.history.list", input: pick(args, ["poolId"]) }]
        : [get];
    }
    case "profiles_get":
      return args.profileId === undefined
        ? [{ path: "profiles.list", input: {} }]
        : [{ path: "profiles.get", input: pick(args, ["profileId"]) }];
    case "providers_get":
      return [
        { path: "providers.accounts.list", input: {} },
        { path: "providers.models.list", input: {} },
      ];
    case "runtime_create": {
      const fork = record(args.forkFrom);
      if (args.forkFrom !== undefined)
        return [
          {
            path: "runtimes.fork",
            input: {
              ...pick(fork, ["runtimeId", "versionId"]),
              ...pick(args, ["slug", "name", "nodeId", "limits", "advanced", "compat", "note"]),
            },
          },
        ];
      return [
        {
          path: "runtimes.create",
          input: {
            kind: args.nodeId === undefined ? "STARTABLE" : "ALWAYS_ON",
            ...omit(args, ["forkFrom"]),
          },
        },
      ];
    }
    case "runtime_update": {
      const calls: ProcedureCall[] = [
        { path: "runtimes.update", input: omit(args, ["modelCapabilities"]) },
      ];
      const note = args.note;
      for (const entry of Array.isArray(args.modelCapabilities) ? args.modelCapabilities : [])
        calls.push({
          path: "runtimes.models.setCapabilities",
          input: { ...record(entry), ...(note === undefined ? {} : { note }) },
        });
      return calls;
    }
    case "pool_update": {
      const calls: ProcedureCall[] = [];
      const update = omit(args, ["contribute", "aliases"]);
      if (Object.keys(omit(update, ["poolId", "note"])).length > 0)
        calls.push({ path: "pools.update", input: update });
      const contribute = record(args.contribute);
      const note = args.note === undefined ? {} : { note: args.note };
      for (const runtimeModelId of Array.isArray(contribute.add) ? contribute.add : [])
        calls.push({
          path: "pools.members.addContributed",
          input: { poolId: args.poolId, runtimeModelId, ...note },
        });
      for (const memberId of Array.isArray(contribute.withdraw) ? contribute.withdraw : [])
        calls.push({ path: "pools.members.removeContributed", input: { memberId, ...note } });
      const aliases = record(args.aliases);
      for (const entry of Array.isArray(aliases.set) ? aliases.set : [])
        calls.push({
          path: "pools.aliases.set",
          input: { ...record(entry), poolId: args.poolId, ...note },
        });
      for (const aliasId of Array.isArray(aliases.remove) ? aliases.remove : [])
        calls.push({ path: "pools.aliases.delete", input: { aliasId, ...note } });
      return calls;
    }
    case "runtime_stop":
      if (args.markStopped === true)
        return [
          {
            path: "runtimes.instances.markStopped",
            input: pick(args, ["instanceId", "nodeNumber", "confirm", "note"]),
          },
        ];
      return [
        {
          path: "runtimes.stop",
          input:
            args.instanceId === undefined
              ? pick(args, ["runtimeId", "nodeId"])
              : pick(args, ["instanceId"]),
        },
      ];
    case "node_secret_set":
      return args.value === null
        ? [{ path: "nodes.secrets.delete", input: pick(args, ["nodeId", "name", "note"]) }]
        : [{ path: "nodes.secrets.set", input: pick(args, ["nodeId", "name", "value", "note"]) }];
    default:
      return [];
  }
}

/** A value without null fields and empty lists, at any depth (compact list rows). */
function withoutEmpty(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutEmpty);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null || (Array.isArray(entry) && entry.length === 0)) continue;
    out[key] = withoutEmpty(entry);
  }
  return out;
}

/** A pool whose members' live load leaves out what is unknown (null waiting, p95, share or slots). */
function withCompactMemberLive(pool: unknown): unknown {
  const members = record(pool).members;
  if (!Array.isArray(members)) return pool;
  return {
    ...record(pool),
    members: members.map((member) => ({
      ...record(member),
      live: withoutEmpty(record(member).live),
    })),
  };
}

/** Combines the outputs of a tool's procedure calls into its result. */
function combineOutputs(name: string, calls: ProcedureCall[], outputs: unknown[]): unknown {
  switch (name) {
    case "nodes_get":
      // The list is read for every node at once: rows leave out nulls and empty lists.
      return calls[0]?.path === "nodes.list" ? withoutEmpty(outputs[0]) : outputs[0];
    case "runtimes_get": {
      // Instance rows and list rows leave out nulls and empty lists (a held STOPPED instance
      // stays listed; a runtime on no node has no `nodes`).
      const runtime =
        calls[0]?.path === "runtimes.get"
          ? { ...record(outputs[0]), instanceList: withoutEmpty(record(outputs[0]).instanceList) }
          : calls[0]?.path === "runtimes.list"
            ? withoutEmpty(outputs[0])
            : outputs[0];
      return outputs.length === 2 ? { ...record(runtime), versions: outputs[1] } : runtime;
    }
    case "pools_get": {
      // Member live load leaves out what is unknown (null waiting, p95, share or slots).
      const list = record(outputs[0]).pools;
      const first =
        calls[0]?.path === "pools.get"
          ? withCompactMemberLive(outputs[0])
          : calls[0]?.path === "pools.list" && Array.isArray(list)
            ? { ...record(outputs[0]), pools: list.map(withCompactMemberLive) }
            : outputs[0];
      return outputs.length === 2 ? { ...record(first), history: outputs[1] } : first;
    }
    case "providers_get":
      return { accounts: record(outputs[0]).accounts, models: record(outputs[1]).models };
    case "runtime_update":
      return outputs.length > 1 ? { ...record(outputs[0]), models: outputs.slice(1) } : outputs[0];
    case "pool_update":
      return {
        ...(calls[0]?.path === "pools.update" ? { pool: outputs[0] } : {}),
        contributed: outputs.filter((_, index) => calls[index]?.path.endsWith("addContributed")),
        withdrawn: calls
          .filter((entry) => entry.path.endsWith("removeContributed"))
          .map((entry) => entry.input.memberId),
        ...(calls.some((entry) => entry.path.startsWith("pools.aliases."))
          ? {
              aliases: outputs.filter((_, index) => calls[index]?.path === "pools.aliases.set"),
              aliasesRemoved: calls
                .filter((entry) => entry.path === "pools.aliases.delete")
                .map((entry) => entry.input.aliasId),
            }
          : {}),
      };
    case "node_secret_set":
      return { name: calls[0]?.input.name, deleted: calls[0]?.path === "nodes.secrets.delete" };
    default:
      return outputs[0];
  }
}

/** Calls one procedure of the bound router as the request's agent caller. */
export type ProcedureInvoker = (
  path: string,
  input: Record<string, unknown>,
  context: McpContext,
  signal: AbortSignal,
) => Promise<unknown>;

export const invokeBoundProcedure: ProcedureInvoker = async (path, input, context, signal) => {
  const procedure = getRouter(appRouter, path.split("."));
  if (!isProcedure(procedure)) throw new McpUnknownProcedureError(path);
  return call(procedure, input, { context, signal });
};

class McpUnknownProcedureError extends Error {
  constructor(path: string) {
    super(`MCP tool names an unknown procedure (${path.length} chars)`);
    this.name = "McpUnknownProcedureError";
  }
}

// ── results and errors ──

class McpToolAbortedError extends Error {
  constructor() {
    super("MCP tool call aborted");
    this.name = "McpToolAbortedError";
  }
}

function toolError(message: string, structured: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: structured,
    isError: true,
  };
}

/** The SDK's own text for an unregistered tool: a hidden tool looks the same. */
function unknownToolError(name: string): ToolResult {
  return toolError(`Tool ${name} not found`, { error: { code: "NOT_FOUND" } });
}

const STATIC_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  BAD_REQUEST: "Invalid input",
  UNAUTHORIZED: "Unauthorized",
  FORBIDDEN: "Forbidden",
  NOT_FOUND: "Not found",
  CONFLICT: "Conflict",
  PRECONDITION_FAILED: "Precondition failed",
  TOO_MANY_REQUESTS: "Too many requests",
});

const REFUSAL_REASON_SHAPE = /^[a-z][a-z0-9_]{1,63}$/;
const SUBJECT_ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

/** One line, bounded: refusal messages are fixed server text, never caller input. */
function sanitizeMessage(message: string): string {
  let out = "";
  for (const char of message.slice(0, 500)) {
    const code = char.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : char;
  }
  return out;
}

/** `{path, message}`; a sensitive tool gets `{path, code}` (a message could echo a value). */
type ValidationIssue = { path: string; message: string } | { path: string; code: string };

const MAX_ISSUES = 20;

function issueOf(path: string, code: string, message: unknown, sensitive: boolean) {
  const at = path || "(root)";
  if (sensitive || typeof message !== "string" || message === "") return { path: at, code };
  return { path: at, message: sanitizeMessage(message).slice(0, 200) };
}

function validationIssues(error: z.ZodError, sensitive: boolean): ValidationIssue[] {
  return error.issues
    .slice(0, MAX_ISSUES)
    .map((issue) =>
      issueOf(issue.path.map(String).join("."), issue.code, issue.message, sensitive),
    );
}

function validationError(issues: ValidationIssue[]): ToolResult {
  const fields = issues.map((issue) => issue.path).join(", ");
  return toolError(`Invalid input: ${fields}.`, { error: { code: "invalid_input", issues } });
}

/** Issues from an oRPC input validation failure (its cause carries the schema issues). */
function orpcValidationIssues(
  error: ORPCError<string, unknown>,
  sensitive: boolean,
): ValidationIssue[] | null {
  const cause: unknown = error.cause;
  if (cause === null || typeof cause !== "object" || !("issues" in cause)) return null;
  const issues: unknown = cause.issues;
  if (!Array.isArray(issues)) return null;
  return issues.slice(0, MAX_ISSUES).map((issue: unknown) => {
    const entry = record(issue);
    const path = Array.isArray(entry.path)
      ? entry.path.map((segment) => String(record(segment).key ?? segment)).join(".")
      : "";
    const code = typeof entry.code === "string" ? entry.code : "invalid";
    return issueOf(path, code, entry.message, sensitive);
  });
}

/**
 * An error as a tool result. A refusal keeps its fixed message and reason; for a sensitive
 * tool even that message is replaced by the reason (a procedure message must never be able
 * to carry a secret back). Everything else gets a static message.
 */
function mapError(
  error: unknown,
  requestId: string,
  toolName: string,
  sensitive: boolean,
): ToolResult {
  if (error instanceof McpToolAbortedError) {
    return toolError("Request cancelled.", { error: { code: "REQUEST_ABORTED" } });
  }
  if (error instanceof ORPCError) {
    const data = record(error.data);
    const reason = data.reason;
    if (typeof reason === "string" && REFUSAL_REASON_SHAPE.test(reason)) {
      const subjectId =
        typeof data.subjectId === "string" && SUBJECT_ID_SHAPE.test(data.subjectId)
          ? data.subjectId
          : null;
      const message = sensitive ? `Refused: ${reason}.` : sanitizeMessage(error.message);
      return toolError(message, { error: { code: error.code, reason, subjectId, message } });
    }
    if (error.code === "BAD_REQUEST") {
      const issues = orpcValidationIssues(error, sensitive);
      if (issues) return validationError(issues);
    }
    if (Object.hasOwn(STATIC_MESSAGES, error.code)) {
      // Procedure messages are developer-written (they may name ids, never secrets): an agent
      // needs "an always-on runtime is not started", not a bare "Invalid input".
      const own = sensitive ? "" : sanitizeMessage(error.message).trim();
      const message = own || (STATIC_MESSAGES[error.code] ?? "Internal error");
      return toolError(message, {
        error: { code: error.code, ...(own ? { message: own } : {}) },
      });
    }
  }
  mcpSanitizedLog(
    `tool call failed (${error instanceof Error ? error.constructor.name : typeof error})`,
    { toolName, requestId },
  );
  return toolError("Internal error", { error: { code: "INTERNAL_ERROR" }, requestId });
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  void promise.catch(() => undefined);
  if (signal.aborted) throw new McpToolAbortedError();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new McpToolAbortedError());
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function serializeResult(output: unknown): ToolResult | null {
  const safe = toJsonSafe(redactSecrets(output));
  const text = JSON.stringify(safe);
  if (text === undefined) return { content: [{ type: "text", text: "null" }] };
  const result: ToolResult = {
    content: [{ type: "text", text }],
    structuredContent: { result: safe },
  };
  return new TextEncoder().encode(JSON.stringify(result)).length > OUTPUT_BUDGET_BYTES
    ? null
    : result;
}

// ── one call ──

/** Whether a tool's input must never be logged, audited or echoed. */
export function toolInputIsSensitive(contract: McpToolContract): boolean {
  return (
    contract.sensitiveInput === true ||
    contract.procedures.some((path) => SENSITIVE_INPUT_PROCEDURES.has(path))
  );
}

/** Runs one tool call through the wrapper chain (see the module docblock). */
export async function runMcpTool(
  contract: McpToolContract,
  state: {
    dispatch: McpToolDispatch | undefined;
    args: unknown;
    invoke?: ProcedureInvoker;
  },
): Promise<ToolResult> {
  const { dispatch } = state;
  if (dispatch === undefined) {
    mcpSanitizedLog("tool dispatch rejected: no verified context", { toolName: contract.name });
    return toolError("Internal error", { error: { code: "INTERNAL_ERROR" } });
  }
  const { requestId, credential } = dispatch;
  if (!mcpToolAllowed(contract.name, credential.level)) return unknownToolError(contract.name);

  const sensitive = toolInputIsSensitive(contract);
  const parsed = contract.input.safeParse(state.args ?? {});
  if (!parsed.success) return validationError(validationIssues(parsed.error, sensitive));
  const input = record(parsed.data);

  const retryAfterSeconds = await consumeRateLimit(contract, credential, input);
  if (retryAfterSeconds !== null)
    return toolError("Too many requests for this tool; try again shortly.", {
      error: { code: "TOO_MANY_REQUESTS", retryAfterSeconds },
    });

  const calls = routeToolCall(contract.name, input);
  if (calls.length === 0 && contract.procedures.length === 1)
    calls.push({ path: contract.procedures[0] ?? "", input });
  if (calls.length === 0 || calls.some((entry) => !contract.procedures.includes(entry.path))) {
    mcpSanitizedLog("tool dispatch rejected: no procedure route", {
      toolName: contract.name,
      requestId,
    });
    return toolError("Internal error", { error: { code: "INTERNAL_ERROR" }, requestId });
  }

  const tracked = trackCall(credential, dispatch.signal, !READ_TOOL_NAMES.has(contract.name));
  const invoke = state.invoke ?? invokeBoundProcedure;
  try {
    const outputs: unknown[] = [];
    for (const entry of calls) {
      if (tracked.signal.aborted) throw new McpToolAbortedError();
      outputs.push(
        await raceAbort(
          runWithDbAbortFence(tracked.signal, () =>
            invoke(entry.path, entry.input, dispatch.orpcContext, tracked.signal),
          ),
          tracked.signal,
        ),
      );
    }
    if (tracked.signal.aborted) throw new McpToolAbortedError();
    const result = serializeResult(combineOutputs(contract.name, calls, outputs));
    if (result === null) {
      mcpSanitizedLog("tool output exceeded the size cap", { toolName: contract.name, requestId });
      return toolError("Tool output exceeded the maximum size.", {
        error: { code: "OUTPUT_TOO_LARGE", maxBytes: MCP_TOOL_OUTPUT_MAX_BYTES },
      });
    }
    return result;
  } catch (error) {
    return mapError(error, requestId, contract.name, sensitive);
  } finally {
    tracked.done();
  }
}
