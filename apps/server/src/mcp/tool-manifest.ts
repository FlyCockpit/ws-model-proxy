/**
 * Typed MCP tool manifest (MCP plan Phase 4 module seam; Phase 5 fills the
 * catalog). Every procedure-backed tool must carry one of these descriptors;
 * the Phase 5 coverage artifact (`docs/mcp-tool-coverage.md`) is generated
 * from this list and fails when an `appRouter` leaf is unclassified.
 *
 * Phase 4 ships the manifest EMPTY: the transport is wired, but no tool is
 * registered — `tools/list` answers an empty catalog until Phase 5 lands.
 */

/** Endpoint-wide scope requirement. Write tools require literal `mcp:write`. */
export type McpToolScope = "read" | "write";

/**
 * Human-confirmation policy literal surfaced to the client (Phase 5):
 * - `DELETE` — destructive removal;
 * - `RUN` — externally visible or costly execution;
 * - `null` — ordinary mutation/read, no confirmation gate.
 */
export type McpToolConfirmation = "DELETE" | "RUN" | null;

/** Side-effect classification used by the Phase 5 coverage checks. */
export type McpToolClass = "pure" | "external" | "cost" | "destructive";

/** One checked tool descriptor. `target` is the exact oRPC procedure path. */
export interface McpToolDescriptor {
  /** Exact public MCP tool name (stable wire contract). */
  name: string;
  /** Exact oRPC procedure or extracted core (e.g. `providerManagement.listAccounts`). */
  target: string;
  /** Required scope: `read` (mcp:read or mcp:write) or `write` (literal mcp:write). */
  scope: McpToolScope;
  /** Confirmation policy literal (`DELETE` / `RUN` / null). */
  confirmation: McpToolConfirmation;
  /** Optional feature flag the underlying procedure depends on. */
  featureDependency?: string;
  /** Side-effect class for coverage-artifact checks. */
  classification: McpToolClass;
  /** Phase 5: input adapter (MCP args → procedure input). */
  inputAdapter?: (input: unknown) => unknown;
  /** Phase 5: safe output projector applied before redaction + caps. */
  outputProjector?: (output: unknown) => unknown;
}

/**
 * The checked catalog. EMPTY in Phase 4 — Phase 5 registers the ~70 tools
 * from the plan's read/write tables and the exclusions list.
 */
export const MCP_TOOL_MANIFEST: readonly McpToolDescriptor[] = [];
