/**
 * Central MCP tool wrappers (Phase 5).
 *
 * `registerMcpTools` is the production `registerTools` seam the transport
 * factory calls once per request (mcp/handler.ts). For every manifest
 * descriptor it registers ONE tool on the per-request `McpServer` whose
 * callback passes through this wrapper chain — in order:
 *
 *   1. DISPATCH: resolve the per-request oRPC context bound by the Phase 4
 *      `onVerified` seam (mcp/auth.ts → app.ts wiring). No binding (an
 *      unverified request somehow reaching dispatch) fails CLOSED with a
 *      generic internal error and NO procedure call.
 *   2. SCOPE: read tools require the read baseline (`mcp:read` or
 *      `mcp:write`); write tools require the LITERAL `mcp:write` — enforced
 *      with the SAME pure predicate the endpoint admission uses
 *      (`mcpScopesAllow`). Insufficient scope is an in-band tool error with
 *      a stable message (the HTTP-level 403 challenge answers requests that
 *      lack even the read baseline; a tool-level denial surfaces where the
 *      client can see WHICH scope to step up to).
 *   3. CONFIRMATION: gated tools require the exact literal
 *      (`confirm: "DELETE"` / `confirm: "RUN"`); the field is then STRIPPED
 *      so it can never reach a procedure input.
 *   4. INPUT: the (remaining) arguments go through the descriptor's input
 *      adapter, then to `createRouterClient(appRouter, { context })` — MCP
 *      does NOT repeat ownership or validation checks; the oRPC layer owns
 *      them. Extracted diagnostic cores are invoked with the VERIFIED user
 *      id only.
 *   5. OUTPUT: descriptor projector → defense-in-depth secret redactor →
 *      JSON-safe serialization → byte cap.
 *   6. ERRORS: ONLY allowlisted oRPC error codes map to stable MCP tool
 *      errors (arbitrary messages are never copied — Prisma/oRPC messages
 *      can carry SQL and credential material); ownership-hiding `NOT_FOUND`
 *      keeps its indistinguishable "Not found"; every unknown failure is a
 *      generic internal error carrying the request id, with a sanitized log
 *      line (constructor name + tool name + request id ONLY).
 */

import type {
  CallToolResult,
  McpRequestContext,
  McpServer,
  StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { createRouterClient, ORPCError } from "@orpc/server";
import { type AppRouterClient, appRouter } from "@ws-model-proxy/api/routers/index";
import { mcpScopesAllow } from "@ws-model-proxy/auth/mcp-config";
import { runWithDbAbortFence } from "@ws-model-proxy/db/shutdown-fence";
import { mcpSanitizedLog } from "./errors";
import { redactSecrets } from "./redaction";
import { toJsonSafe } from "./serialization";
import { resolveMcpToolDispatch } from "./tool-dispatch";
import {
  MCP_TOOL_MANIFEST,
  McpInvalidDateInputError,
  type McpToolDescriptor,
} from "./tool-manifest";

/** One router client per request — the oRPC layer is the ownership boundary. */
type RouterClient = AppRouterClient;

/** In-band tool results use the SDK's own CallToolResult shape verbatim. */
type ToolResult = CallToolResult;

/**
 * Hard cap on one tool's serialized output (bytes of the JSON encoding).
 * Procedures already paginate (limit ≤ 200); this bound exists so a future
 * unbounded select cannot blow up a JSON-RPC response.
 */
export const MCP_TOOL_OUTPUT_MAX_BYTES = 256 * 1024;

/**
 * G5: fixed headroom reserved for the fields the installed SDK adds to the
 * wrapper's measured result AFTER the size check (resultType, server-info
 * `_meta`; the installed SDK measured 115 bytes — 1 KiB keeps generous
 * slack across SDK patch bumps). Both size checks below bound the tool's
 * result to `MCP_TOOL_OUTPUT_MAX_BYTES - MCP_TOOL_OUTPUT_SDK_HEADROOM_BYTES`
 * so the EMITTED (post-SDK) result stays within the advertised cap.
 */
export const MCP_TOOL_OUTPUT_SDK_HEADROOM_BYTES = 1024;

/**
 * The budget the wrapper's own checks enforce: the advertised cap minus the
 * SDK headroom. `OUTPUT_TOO_LARGE` still reports the advertised cap.
 */
const MCP_TOOL_OUTPUT_EMITTED_BUDGET_BYTES =
  MCP_TOOL_OUTPUT_MAX_BYTES - MCP_TOOL_OUTPUT_SDK_HEADROOM_BYTES;

/**
 * Allowlisted oRPC error codes → stable tool-error messages. Codes outside
 * this map (and non-ORPCError failures) become the generic internal error;
 * ORPCError messages are NEVER copied verbatim into tool output.
 */
const ORPC_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  BAD_REQUEST: "Invalid input",
  UNAUTHORIZED: "Unauthorized",
  FORBIDDEN: "Forbidden",
  NOT_FOUND: "Not found",
  CONFLICT: "Conflict",
  TOO_MANY_REQUESTS: "Too many requests",
});

const GENERIC_TOOL_ERROR_MESSAGE = "Internal error";

function toolError(message: string, structured: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: structured,
    isError: true,
  };
}

function insufficientScopeError(descriptor: McpToolDescriptor): ToolResult {
  return toolError(
    `Insufficient scope: ${descriptor.name} requires mcp:${descriptor.scope === "write" ? "write" : "read"}.`,
    {
      error: {
        code: "INSUFFICIENT_SCOPE",
        requiredScope: descriptor.scope === "write" ? "mcp:write" : "mcp:read",
      },
    },
  );
}

function confirmationRequiredError(descriptor: McpToolDescriptor): ToolResult {
  const literal = descriptor.confirmation;
  return toolError(`Confirmation required: pass confirm="${literal}" to run ${descriptor.name}.`, {
    error: { code: "CONFIRMATION_REQUIRED", requiredConfirm: literal },
  });
}

function internalToolError(requestId: string): ToolResult {
  return toolError(GENERIC_TOOL_ERROR_MESSAGE, {
    error: { code: "INTERNAL_ERROR" },
    requestId,
  });
}

/** Strip the ceremonial `confirm` field so it never reaches a procedure. */
function stripConfirmation(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const { confirm: _confirm, ...rest } = input as Record<string, unknown>;
  return rest;
}

/** Serialize + cap. Returns null when the payload exceeds the emitted budget. */
function serializeBounded(payload: unknown): string | null {
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) return null;
  if (new TextEncoder().encode(serialized).length > MCP_TOOL_OUTPUT_EMITTED_BUDGET_BYTES) {
    return null;
  }
  return serialized;
}

/**
 * Register every manifest tool on one per-request server. `ctx` is the
 * transport factory's request context; the dispatch context is resolved
 * from its `authInfo` (bound by the Phase 4 `onVerified` seam). When no
 * dispatch resolves, tools are still registered but every call fails
 * closed — `tools/list` stays stable while `tools/call` can never reach a
 * procedure without a verified, admitted request.
 */
export function registerMcpTools(server: McpServer, ctx?: McpRequestContext): void {
  const dispatch = resolveMcpToolDispatch(ctx?.authInfo);
  const scopes = ctx?.authInfo?.scopes;
  // One router client per request, shared by every tool closure below. MCP
  // never re-checks ownership: the oRPC procedures own those checks against
  // this per-request synthetic-session context.
  const client: RouterClient | undefined = dispatch
    ? createRouterClient(appRouter, { context: dispatch.orpcContext })
    : undefined;

  for (const descriptor of MCP_TOOL_MANIFEST) {
    // Explicit type arguments: the SDK's first overload cannot infer
    // OutputArgs when no outputSchema is passed (tools deliberately declare
    // none — no output validation, no SEP-2106 result wrapping), and InputArgs
    // is the erased descriptor schema. The callback receives `unknown` args
    // (already validated by the schema) and returns the SDK's own
    // CallToolResult shape.
    server.registerTool<StandardSchemaWithJSON, StandardSchemaWithJSON>(
      descriptor.name,
      {
        title: descriptor.name,
        description: toolDescription(descriptor),
        inputSchema: descriptor.inputSchema,
        annotations: {
          readOnlyHint: descriptor.scope === "read",
          destructiveHint: descriptor.confirmation === "DELETE",
          idempotentHint: descriptor.scope === "read",
          openWorldHint:
            descriptor.classification === "external" || descriptor.classification === "cost",
        },
      },
      async (args: unknown): Promise<ToolResult> =>
        runManifestTool(descriptor, { dispatch, scopes, client, args }),
    );
  }
}

function toolDescription(descriptor: McpToolDescriptor): string {
  const parts = [`Target: ${descriptor.target}.`];
  parts.push(
    descriptor.scope === "write"
      ? "Requires the mcp:write scope (literal)."
      : "Requires the mcp:read or mcp:write scope.",
  );
  if (descriptor.confirmation !== null) {
    parts.push(`Requires confirm: "${descriptor.confirmation}".`);
  }
  if (descriptor.featureDependencies !== undefined && descriptor.featureDependencies.length > 0) {
    parts.push(`Depends on ${descriptor.featureDependencies.join(", ")}.`);
  }
  return parts.join(" ");
}

/**
 * The wrapper chain for one manifest tool invocation (see module docblock).
 * Exported for tests to drive directly with a synthetic dispatch.
 */
export async function runManifestTool(
  descriptor: McpToolDescriptor,
  state: {
    dispatch: ReturnType<typeof resolveMcpToolDispatch>;
    scopes: readonly string[] | undefined;
    client: RouterClient | undefined;
    args: unknown;
  },
): Promise<ToolResult> {
  const { dispatch, scopes, client, args } = state;

  // 1. Dispatch: fail CLOSED without a verified, admitted request context.
  if (dispatch === undefined) {
    mcpSanitizedLog("tool dispatch rejected: no verified context", {
      toolName: descriptor.name,
    });
    return toolError(GENERIC_TOOL_ERROR_MESSAGE, { error: { code: "INTERNAL_ERROR" } });
  }
  const requestId = dispatch.requestId;
  // G1: the verified request's OWNED admission signal — the invocation and
  // every post-await pipeline stage race/fence against it, so a client
  // abort or gate.close() never leaves a tool continuation that can START
  // new work (the DB-seam fence covers continuations that resume anyway).
  const signal = dispatch.signal;

  // 2. Scope: write tools require the literal mcp:write; read tools accept
  //    either scope through the shared endpoint predicate.
  const scopeOk =
    descriptor.scope === "write"
      ? mcpScopesAllow(scopes ?? [], "write")
      : mcpScopesAllow(scopes ?? [], "read");
  if (!scopeOk) {
    mcpSanitizedLog("tool call denied: insufficient scope", {
      toolName: descriptor.name,
      requestId,
    });
    return insufficientScopeError(descriptor);
  }

  // 3. Confirmation gate + field stripping.
  const argsRecord =
    args !== null && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  if (descriptor.confirmation !== null && argsRecord.confirm !== descriptor.confirmation) {
    mcpSanitizedLog("tool call denied: missing confirmation", {
      toolName: descriptor.name,
      requestId,
    });
    return confirmationRequiredError(descriptor);
  }

  // 4-6. The ENTIRE pipeline (adapt → invoke → project → redact →
  //    serialize → size → build) runs inside ONE sanitizing boundary (G4):
  //    ANY throw — input adaptation, the procedure/core, projection,
  //    redaction, serialization, or sizing — becomes a stable in-band tool
  //    error. NOTHING reaches the installed SDK, whose own catch would
  //    copy `Error.message` verbatim into tool output.
  try {
    if (signal?.aborted) throw new McpToolAbortedError();
    const adaptedInput = descriptor.inputAdapter
      ? descriptor.inputAdapter(stripConfirmation(argsRecord))
      : stripConfirmation(argsRecord);

    // Invoke (procedure through the per-request client, or extracted core),
    // raced against the admission signal (G1): abort settles THIS wrapper
    // promptly, and the invocation runs inside the PER-REQUEST DB ABORT
    // FENCE (runWithDbAbortFence): the shared Prisma client rejects any NEW
    // database operation by this call's continuations once the signal
    // aborts (ALS propagates through the await tree, covering resumed
    // procedure continuations and transaction callbacks alike; an in-flight
    // single operation may still complete — atomic semantics). Normal HTTP
    // traffic runs outside the fence context and is unaffected.
    let output: unknown;
    const invokeCore = descriptor.invokeCore;
    const invokeProcedure = descriptor.invokeProcedure;
    if (invokeCore !== undefined) {
      output = await raceAbort(
        runWithDbAbortFence(signal, () =>
          invokeCore(adaptedInput, {
            userId: dispatch.orpcContext.session.user.id,
            signal,
          }),
        ),
        signal,
      );
    } else if (invokeProcedure !== undefined && client !== undefined) {
      output = await raceAbort(
        runWithDbAbortFence(signal, () => invokeProcedure(client, adaptedInput)),
        signal,
      );
    } else {
      // A descriptor with no invocation is a manifest bug; fail closed.
      mcpSanitizedLog("tool dispatch rejected: descriptor has no invocation", {
        toolName: descriptor.name,
        requestId,
      });
      return internalToolError(requestId);
    }
    // Post-await fence (G1): never START the output pipeline after abort.
    if (signal?.aborted) throw new McpToolAbortedError();

    // Project → redact → serialize → cap (G5: the FINAL serialized result —
    // text + structuredContent combined — is what must stay within the
    // advertised cap; the payload pre-check below is only the fast fail for
    // grossly oversized payloads).
    const projected = descriptor.outputProjector ? descriptor.outputProjector(output) : output;
    if (signal?.aborted) throw new McpToolAbortedError();
    const safe = toJsonSafe(redactSecrets(projected));
    const serialized = serializeBounded(safe);
    if (serialized === null) {
      mcpSanitizedLog("tool output exceeded the size cap", {
        toolName: descriptor.name,
        requestId,
      });
      return outputTooLargeError();
    }
    const result: ToolResult = {
      content: [{ type: "text", text: serialized }],
      structuredContent: { result: safe },
    };
    // G5: the emitted budget (cap minus SDK headroom) — the SDK adds
    // resultType/_meta AFTER this check, so the post-encoding result stays
    // within the advertised cap.
    if (byteLength(JSON.stringify(result)) > MCP_TOOL_OUTPUT_EMITTED_BUDGET_BYTES) {
      mcpSanitizedLog("tool output exceeded the size cap", {
        toolName: descriptor.name,
        requestId,
      });
      return outputTooLargeError();
    }
    return result;
  } catch (error) {
    if (error instanceof McpToolAbortedError) {
      mcpSanitizedLog("tool call aborted", { toolName: descriptor.name, requestId });
      return toolError("Request cancelled.", { error: { code: "REQUEST_ABORTED" } });
    }
    if (error instanceof McpInvalidDateInputError) {
      mcpSanitizedLog("tool input rejected: invalid timestamp", {
        toolName: descriptor.name,
        requestId,
      });
      return toolError(`Invalid input: field "${error.field}" must be an ISO-8601 timestamp.`, {
        error: { code: "INVALID_INPUT", field: error.field },
      });
    }
    return mapToolError(error, descriptor, requestId);
  }
}

/** Module-private sentinel: the request's admission signal aborted. */
class McpToolAbortedError extends Error {
  constructor() {
    super("MCP tool call aborted");
    this.name = "McpToolAbortedError";
  }
}

/**
 * Race one invocation promise against the admission signal (G1). The
 * underlying promise is never cancelled by the race itself (procedure
 * continuations are not cancellable) — its residual DB work is fenced by
 * the db-seam shutdown fence, its network work by the signal threading in
 * the diagnostic cores. A no-op catch keeps a losing-but-rejecting
 * continuation from surfacing as an unhandled rejection.
 */
async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) throw new McpToolAbortedError();
  void promise.catch(() => undefined);
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const rejectAborted = () => reject(new McpToolAbortedError());
      if (signal.aborted) {
        rejectAborted();
        return;
      }
      signal.addEventListener("abort", rejectAborted, { once: true });
    }),
  ]);
}

/** UTF-8 byte length of a string (edge-neutral). */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function outputTooLargeError(): ToolResult {
  return toolError("Tool output exceeded the maximum size.", {
    error: { code: "OUTPUT_TOO_LARGE", maxBytes: MCP_TOOL_OUTPUT_MAX_BYTES },
  });
}

/**
 * Allowlisted oRPC error mapping. `NOT_FOUND` keeps the SAME stable message
 * whether the target does not exist or belongs to another user — the
 * ownership-hiding convention survives the bridge intact. The lookup is
 * PROTOTYPE-SAFE (G6): `Object.hasOwn` keeps inherited properties
 * (`"toString"`, `"constructor"`, `"hasOwnProperty"`) out of the mapping,
 * so `new ORPCError("toString")` collapses to the generic internal error
 * like every other unknown code. Unknown codes and non-ORPCError failures
 * NEVER copy their message (SQL, stack, or provider detail) into tool
 * output: they become the generic internal error with the request id, plus
 * one sanitized log line.
 */
function mapToolError(
  error: unknown,
  descriptor: McpToolDescriptor,
  requestId: string,
): ToolResult {
  if (error instanceof ORPCError) {
    if (Object.hasOwn(ORPC_ERROR_MESSAGES, error.code)) {
      const stable = ORPC_ERROR_MESSAGES[error.code];
      if (stable !== undefined) {
        return toolError(stable, { error: { code: error.code } });
      }
    }
  }
  mcpSanitizedLog(
    `tool invocation failed (${error instanceof Error ? error.constructor.name : typeof error})`,
    { toolName: descriptor.name, requestId },
  );
  return internalToolError(requestId);
}
