/**
 * Per-request MCP tool dispatch binding (Phase 5).
 *
 * The Phase 4 `onVerified` seam (mcp/auth.ts) runs after EVERY admission
 * check and receives `{ authInfo, orpcContext }`. The transport factory
 * (mcp/handler.ts) later receives the SAME `authInfo` object by reference —
 * the installed `@modelcontextprotocol/server@2.0.0` handler threads the
 * `fetch(request, { authInfo })` argument verbatim into the factory's
 * `McpRequestContext.authInfo` (verified in the installed dist: the factory
 * call site spreads `authInfo` unchanged).
 *
 * This module bridges the two: `bindMcpToolDispatch` is invoked by the
 * production `/mcp` wiring (app.ts) inside `onVerified`; the tool
 * registration (mcp/tools.ts) resolves the dispatch for the request's
 * `authInfo` when the per-request `McpServer` is constructed (tools are
 * registered BEFORE any dispatch can run, so the binding always exists for
 * verified requests).
 *
 * SECURITY PROPERTIES:
 * - keyed by OBJECT IDENTITY in a `WeakMap`, so entries cannot outlive the
 *   request's AuthInfo and can never be looked up by a guessed key;
 * - an unbound authInfo resolves `undefined` and every tool fails CLOSED
 *   (generic internal error, no procedure call) — there is no path from an
 *   unverified request to a router client;
 * - the bound payload never contains the presented access token (the
 *   synthetic oRPC context is token-free by construction — mcp/context.ts).
 */

import type { AuthInfo } from "@modelcontextprotocol/server";
import type { McpContext } from "./context";

/** Everything a tool wrapper needs to execute on behalf of one verified request. */
export interface McpToolDispatch {
  /** The per-request oRPC context (synthetic session; never the token). */
  orpcContext: McpContext;
  /** Correlation ID from the /mcp route (for sanitized logs + error bodies). */
  requestId: string;
  /**
   * The OWNED admission signal (G1): the wrapper races the procedure
   * invocation / diagnostic core against it and fences every post-await
   * pipeline stage, so a client abort or gate.close() never leaves a tool
   * continuation that can START new work. Optional so direct unit-test
   * dispatches (and older bindings) keep working; production always sets it.
   */
  signal?: AbortSignal;
}

const dispatchByAuthInfo = new WeakMap<AuthInfo, McpToolDispatch>();

/** Bind the dispatch payload for one verified request's AuthInfo. */
export function bindMcpToolDispatch(authInfo: AuthInfo, dispatch: McpToolDispatch): void {
  dispatchByAuthInfo.set(authInfo, dispatch);
}

/**
 * Resolve the dispatch payload for a request's AuthInfo. `undefined` for
 * unverified/unbound requests — callers must fail closed on that.
 */
export function resolveMcpToolDispatch(
  authInfo: AuthInfo | undefined,
): McpToolDispatch | undefined {
  if (authInfo === undefined) return undefined;
  return dispatchByAuthInfo.get(authInfo);
}
