import {
  createMcpHandler,
  type McpHttpHandler,
  type McpRequestContext,
  McpServer,
} from "@modelcontextprotocol/server";

import { registerMcpTools } from "./tools";

/**
 * MCP HTTP transport (Phase 4 item 4) on the INSTALLED
 * `@modelcontextprotocol/server@2.0.0` API surface:
 *
 * - ONE module-lifetime handler (`McpHttpHandler`); its FACTORY creates and
 *   registers a fresh `McpServer` for every request/context (verified API:
 *   `createMcpHandler(factory, options)` — factory receives
 *   `McpRequestContext` with the pass-through `authInfo`).
 * - Exactly `legacy: "reject"` (modern-only strict endpoint), `responseMode:
 *   "json"` (never stream; mid-call notifications dropped), and
 *   `maxSubscriptions: 0` (the first release has NO subscriptions — listen
 *   streams are refused in-band). Pinned by transport tests.
 * - NO MCP session map, session identifier, idle sweep, subscription
 *   endpoint, or sticky routing: each request gets its own server, and the
 *   SDK owns closing it (`close()` on the handler tears down only the
 *   module-lifetime modern leg — application code NEVER double-closes a
 *   per-request server).
 * - The entry performs no token verification itself; `authInfo` given to
 *   `fetch(request, { authInfo })` is built by `mcp/auth.ts` from the
 *   upstream-verified JWT and passed through to the factory and tools.
 *
 * The single `close()` call site is the graceful-shutdown sequence (after
 * HTTP drain, before Prisma disconnect) in index.ts via the object returned
 * from `createApp`.
 */

/** Advertised server identity (stable wire contract for `initialize`). */
export const MCP_SERVER_INFO = { name: "ws-model-proxy", version: "1.0.0" } as const;

/**
 * The exact transport options (pinned by transport tests): modern-only
 * strict endpoint, JSON-only responses, NO subscriptions in the first
 * release.
 */
export const MCP_TRANSPORT_OPTIONS = {
  legacy: "reject",
  responseMode: "json",
  maxSubscriptions: 0,
} as const;

/**
 * Build the module-lifetime MCP HTTP handler. `registerTools` is injectable
 * so tests can observe per-request server construction; production uses the
 * {@link registerMcpTools} seam (empty manifest until Phase 5).
 * `isShuttingDown` is the FACTORY FENCE's shutdown half (F8 pass 4):
 * production passes the admission gate's closed flag.
 */
export function createMcpTransport({
  registerTools = registerMcpTools,
  isShuttingDown = () => false,
}: {
  registerTools?: (server: McpServer, ctx: McpRequestContext) => void;
  /** Factory fence (F8 pass 4): refuse server creation once shutdown began. */
  isShuttingDown?: () => boolean;
} = {}): McpHttpHandler {
  return createMcpHandler(
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
      if (isShuttingDown() || ctx.requestInfo?.signal?.aborted === true) {
        throw new Error("MCP exchange aborted or shutting down");
      }
      const server = new McpServer({
        name: MCP_SERVER_INFO.name,
        version: MCP_SERVER_INFO.version,
      });
      registerTools(server, ctx);
      return server;
    },
    {
      ...MCP_TRANSPORT_OPTIONS,
      // Sanitized (Part D regime): constructor name only — SDK/transport
      // errors can carry request bodies and stack traces. NOTE (F9): the
      // installed CreateMcpHandlerOptions.onerror receives ONLY the Error
      // (no request context hook exists in @modelcontextprotocol/server@
      // 2.0.0 typings), so request-ID correlation for SDK-handled internal
      // errors is added at the ROUTE layer in mcp/auth.ts, which stamps
      // error.data.requestId onto the SDK's returned 500 JSON-RPC body.
      onerror: (error) => {
        console.error(`[mcp] transport error (${error.constructor.name})`);
      },
    },
  );
}
