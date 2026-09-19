import { createFileRoute } from "@tanstack/react-router";

import { McpGrantsPanel } from "@/components/mcp/mcp-grants-panel";

/**
 * Human MCP grant management (MCP plan Phase 7). Deliberately NOT gated on
 * WMP_MCP_ENABLED: the page must stay available during an emergency MCP
 * shutdown so a human can kill outstanding authorization. Normal browser
 * authentication (the _auth layout) still applies.
 */
export const Route = createFileRoute("/$lang/_auth/settings/mcp")({
  component: McpGrantsPanel,
});
