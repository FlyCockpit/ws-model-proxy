import type { McpServer } from "@modelcontextprotocol/server";

import { MCP_TOOL_MANIFEST, type McpToolDescriptor } from "./tool-manifest";

/**
 * Register the checked tool manifest on a fresh per-request McpServer
 * (MCP plan Phase 4 module seam). Phase 5 replaces the placeholder
 * registration body with the real wrappers: scope enforcement
 * (`mcp:write` literal for write tools), confirmation-field stripping,
 * output caps, `toJsonSafe` serialization, allowlisted oRPC error mapping,
 * and descriptor-specific projectors.
 *
 * Phase 4: the manifest is empty, so this registers nothing — `tools/list`
 * serves an empty catalog through the live transport.
 */
export function registerMcpTools(server: McpServer): void {
  for (const descriptor of MCP_TOOL_MANIFEST) {
    registerManifestTool(server, descriptor);
  }
}

/**
 * Placeholder registration for a manifest entry. Unreachable in Phase 4
 * (empty manifest); Phase 5 provides the real wrapper. Throwing (rather
 * than silently serving an un-wrapped procedure) keeps the seam honest: a
 * descriptor added to the manifest without its Phase 5 wrapper fails loudly
 * on first use instead of bypassing the enforcement layers.
 */
function registerManifestTool(_server: McpServer, descriptor: McpToolDescriptor): void {
  throw new Error(`MCP tool wrapper not implemented yet: ${descriptor.name}`);
}
