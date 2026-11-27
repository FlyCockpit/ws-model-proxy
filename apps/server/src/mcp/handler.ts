import { createHash } from "node:crypto";
import {
  createMcpHandler,
  isJsonContentType,
  type McpHandlerRequestOptions,
  type McpHttpHandler,
  type McpRequestContext,
  McpServer,
} from "@modelcontextprotocol/server";
import { advertisedInputSchema, MCP_TOOLS } from "@ws-model-proxy/api/contracts";
import { compareCodePoints } from "@ws-model-proxy/api/lib/canonical-json";

import { SERVER_VERSION } from "../version";
import { registerMcpTools } from "./tools";

/**
 * MCP HTTP transport (Phase 4 item 4) on the INSTALLED
 * `@modelcontextprotocol/server@2.4.0` API surface:
 *
 * - ONE module-lifetime handler (`McpHttpHandler`); its FACTORY creates and
 *   registers a fresh `McpServer` for every request/context (verified API:
 *   `createMcpHandler(factory, options)` — factory receives
 *   `McpRequestContext` with the pass-through `authInfo`).
 * - Primary protocol `2026-07-28` (`responseMode: "json"`, `maxSubscriptions: 0`
 *   — no subscriptions, no mid-call notifications) plus stateless `2025-06-18`
 *   compatibility (`legacy: "stateless"`, `keepAliveMs: 15_000`,
 *   `maxRequestBodySize: 1_048_576` matching `mcpBodyCap`). Pinned by transport
 *   tests.
 * - JSON-RPC batch arrays are rejected with HTTP 400 `-32600` before reaching
 *   the SDK's legacy fallback so every HTTP request carries at most one JSON-RPC
 *   message (preserving IP and identity rate limits).
 * - NO MCP session map, session identifier, idle sweep, subscription
 *   endpoint, or sticky routing: each request gets its own server, and the
 *   SDK owns closing it (when the response finishes, or when a legacy SSE
 *   stream ends/cancels/aborts).
 * - The entry performs no token verification itself; `authInfo` given to
 *   `fetch(request, { authInfo })` is built by `mcp/auth.ts` from the
 *   upstream-verified JWT or agent token and passed through to the factory and
 *   tools.
 *
 * The single `close()` call site is the graceful-shutdown sequence (after
 * HTTP drain, before Prisma disconnect) in index.ts via the object returned
 * from `createApp`.
 */

/**
 * A short, deterministic hash of the tool manifest: every tool's name and advertised input
 * schema (whatever the caller's scopes may list), so a changed tool list shows in the version.
 */
export function mcpToolManifestHash(
  tools: ReadonlyArray<{ name: string; inputSchema: unknown }> = MCP_TOOLS.map((contract) => ({
    name: contract.name,
    inputSchema: advertisedInputSchema(contract),
  })),
): string {
  const manifest = tools
    .map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema }))
    .sort((a, b) => compareCodePoints(a.name, b.name));
  return createHash("sha256").update(sortedJson(manifest)).digest("hex").slice(0, 12);
}

/** JSON with object keys sorted (any JSON value, unlike `canonicalJson`, which limits numbers). */
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => compareCodePoints(a, b)))
      : entry,
  );
}

/** Advertised server identity: the app version plus the tool manifest hash (build metadata). */
export const MCP_SERVER_INFO = {
  name: "ws-model-proxy",
  version: `${SERVER_VERSION}+tools.${mcpToolManifestHash()}`,
} as const;

/**
 * Honest capabilities: the server is stateless and JSON-only with no subscriptions
 * (`maxSubscriptions: 0`), so it never sends `notifications/tools/list_changed` (the SDK would
 * advertise `listChanged: true` by default). Clients see a changed tool list in the version.
 */
export const MCP_SERVER_CAPABILITIES = { tools: { listChanged: false } } as const;

/** Request-body byte cap matching `MCP_MAX_REQUEST_BODY_BYTES` in `mcp-rate-limit.ts`. */
export const MCP_TRANSPORT_MAX_REQUEST_BODY_BYTES = 1_048_576;

/** SSE keep-alive comment interval (ms) for long legacy tool calls. */
export const MCP_SSE_KEEP_ALIVE_MS = 15_000;

/**
 * The exact transport options (pinned by transport tests): `2026-07-28`
 * primary (JSON responses, zero subscriptions) with stateless `2025-06-18`
 * legacy compatibility, 1 MiB body bound, and 15 s SSE keep-alive.
 */
export const MCP_TRANSPORT_OPTIONS = {
  legacy: "stateless",
  responseMode: "json",
  maxSubscriptions: 0,
  maxRequestBodySize: MCP_TRANSPORT_MAX_REQUEST_BODY_BYTES,
  keepAliveMs: MCP_SSE_KEEP_ALIVE_MS,
} as const;

function jsonRpcTransportErrorResponse(
  status: number,
  code: number,
  message: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code, message },
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        ...extraHeaders,
      },
    },
  );
}

function mcpBatchNotSupportedResponse(): Response {
  return jsonRpcTransportErrorResponse(
    400,
    -32600,
    "Invalid Request: JSON-RPC batching is not supported",
    { "Cache-Control": "private, no-store" },
  );
}

type BoundedBodyRead =
  | { kind: "ok"; bytes: Uint8Array }
  | { kind: "too-large" }
  | { kind: "unreadable" };

/** Initial buffer capacity when reading a streamed request body (grows geometrically up to maxBytes). */
const INITIAL_BODY_BUFFER_BYTES = 4096;

/**
 * Read a request body up to `maxBytes`. Rejects declared `Content-Length` above
 * the cap before reading, discards zero-length chunks, copies incoming bytes
 * into a single bounded geometrically grown buffer (preventing per-chunk
 * allocation amplification on fragmented streams), and stops immediately if
 * observed bytes exceed the cap.
 */
async function readBoundedBodyBytes(request: Request, maxBytes: number): Promise<BoundedBodyRead> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { kind: "too-large" };
  }
  if (request.body === null) {
    return { kind: "ok", bytes: new Uint8Array(0) };
  }
  const reader = request.body.getReader();
  let buffer = new Uint8Array(0);
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength === 0) continue;
      const nextLength = received + value.byteLength;
      if (nextLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { kind: "too-large" };
      }
      if (nextLength > buffer.byteLength) {
        let nextCapacity =
          buffer.byteLength === 0
            ? Math.min(maxBytes, Math.max(INITIAL_BODY_BUFFER_BYTES, nextLength))
            : buffer.byteLength;
        while (nextCapacity < nextLength) {
          nextCapacity = Math.min(maxBytes, nextCapacity * 2);
        }
        const grown = new Uint8Array(nextCapacity);
        if (received > 0) {
          grown.set(buffer.subarray(0, received), 0);
        }
        buffer = grown;
      }
      buffer.set(value, received);
      received = nextLength;
    }
  } catch {
    return { kind: "unreadable" };
  } finally {
    reader.releaseLock();
  }
  return { kind: "ok", bytes: received === 0 ? buffer : buffer.subarray(0, received) };
}

/**
 * Build the module-lifetime MCP HTTP handler. `registerTools` is injectable
 * so tests can observe per-request server construction; production uses the
 * {@link registerMcpTools} seam.
 * `isShuttingDown` is the FACTORY FENCE's shutdown half (F8 pass 4):
 * production passes the admission gate's closed flag.
 */
export function createMcpTransport({
  registerTools = registerMcpTools,
  isShuttingDown = () => false,
  keepAliveMs = MCP_TRANSPORT_OPTIONS.keepAliveMs,
  maxRequestBodySize = MCP_TRANSPORT_OPTIONS.maxRequestBodySize,
}: {
  registerTools?: (server: McpServer, ctx: McpRequestContext) => void;
  /** Factory fence (F8 pass 4): refuse server creation once shutdown began. */
  isShuttingDown?: () => boolean;
  /** SSE keep-alive interval in ms (legacy fallback). Injectable for tests. */
  keepAliveMs?: number;
  /** Max request body size in bytes (matching mcpBodyCap). Injectable for tests. */
  maxRequestBodySize?: number;
} = {}): McpHttpHandler {
  let closed = false;
  const inner = createMcpHandler(
    (ctx) => {
      // FACTORY FENCE (F8 pass 4): the installed SDK checks its `closed`
      // flag only at FETCH ENTRY and never rechecks before invoking the
      // factory — a request admitted before close (or aborted while its
      // body was still parsing) would otherwise create a server, register
      // tools, and reach the database during/after shutdown teardown.
      // Throwing here lands in the SDK's own catch: the client is gone or
      // the process is shutting down, so its 500 (or the route-level abort
      // race's 499) is the correct terminal answer. `requestInfo.signal`
      // is the route's OWNED admission signal (see mcp/auth.ts), so client
      // aborts and gate.close() both trip this fence.
      if (closed || isShuttingDown() || ctx.requestInfo?.signal?.aborted === true) {
        throw new Error("MCP exchange aborted or shutting down");
      }
      const server = new McpServer(
        { name: MCP_SERVER_INFO.name, version: MCP_SERVER_INFO.version },
        { capabilities: { tools: { ...MCP_SERVER_CAPABILITIES.tools } } },
      );
      registerTools(server, ctx);
      return server;
    },
    {
      ...MCP_TRANSPORT_OPTIONS,
      keepAliveMs,
      maxRequestBodySize,
      // Sanitized (Part D regime): constructor name only — SDK/transport
      // errors can carry request bodies and stack traces. NOTE (F9): the
      // installed CreateMcpHandlerOptions.onerror receives ONLY the Error
      // (no request context hook exists in @modelcontextprotocol/server
      // typings), so request-ID correlation for SDK-handled internal
      // errors is added at the ROUTE layer in mcp/auth.ts, which stamps
      // error.data.requestId onto the SDK's returned 500 JSON-RPC body.
      onerror: (error) => {
        console.error(`[mcp] transport error (${error.constructor.name})`);
      },
    },
  );

  async function fetch(
    request: Request,
    requestOptions?: McpHandlerRequestOptions,
  ): Promise<Response> {
    if (closed) {
      return inner.fetch(request, requestOptions);
    }
    if (requestOptions?.parsedBody !== undefined) {
      if (Array.isArray(requestOptions.parsedBody)) {
        return mcpBatchNotSupportedResponse();
      }
      return inner.fetch(request, requestOptions);
    }
    if (
      request.method.toUpperCase() !== "POST" ||
      !isJsonContentType(request.headers.get("content-type"))
    ) {
      return inner.fetch(request, requestOptions);
    }
    const read = await readBoundedBodyBytes(request, maxRequestBodySize);
    if (closed) {
      return inner.fetch(request, requestOptions);
    }
    if (read.kind === "unreadable") {
      return jsonRpcTransportErrorResponse(
        400,
        -32700,
        "Parse error: the request body could not be read",
      );
    }
    if (read.kind === "too-large") {
      return jsonRpcTransportErrorResponse(
        413,
        -32000,
        `Request body exceeds maximum size of ${maxRequestBodySize} bytes`,
      );
    }
    let parsed: unknown;
    let hasParsedJson = false;
    if (read.bytes.byteLength > 0) {
      try {
        parsed = JSON.parse(new TextDecoder().decode(read.bytes));
        hasParsedJson = true;
      } catch {
        // Malformed JSON: forward raw bytes to inner so the SDK answers with
        // its exact parse-error / Accept-negotiation error response.
      }
    }
    if (hasParsedJson) {
      if (Array.isArray(parsed)) {
        return mcpBatchNotSupportedResponse();
      }
      return inner.fetch(request, { ...requestOptions, parsedBody: parsed });
    }
    const rebuilt = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: read.bytes.byteLength > 0 ? read.bytes : null,
      signal: request.signal,
    });
    return inner.fetch(rebuilt, requestOptions);
  }

  return {
    fetch,
    notify: inner.notify,
    bus: inner.bus,
    close: async () => {
      closed = true;
      await inner.close();
    },
  };
}
