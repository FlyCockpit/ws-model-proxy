import { createFileRoute } from "@tanstack/react-router";

import { McpGrantsPanel } from "@/components/mcp/mcp-grants-panel";
import { McpTokensPanel } from "@/components/mcp/mcp-tokens-panel";
import { getMcpWebAvailability } from "@/server/mcp-availability";

/**
 * Human MCP grant and personal-token management. Deliberately NOT gated on
 * WMP_MCP_ENABLED: the page must stay available during an emergency MCP
 * shutdown so a human can kill outstanding authorization. Token *creation*
 * is disabled while MCP is off; list/revoke stay available. Normal browser
 * authentication (the _auth layout) still applies.
 */
export const Route = createFileRoute("/$lang/_auth/settings/mcp")({
  beforeLoad: async () => {
    const availability = await getMcpWebAvailability();
    return { mcpEnabled: availability.enabled, mcpPatAllowNoExpiry: availability.allowNoExpiry };
  },
  component: McpSettingsPage,
});

function McpSettingsPage() {
  const { mcpEnabled, mcpPatAllowNoExpiry } = Route.useRouteContext();
  return (
    <div className="space-y-6">
      <McpTokensPanel createEnabled={mcpEnabled} allowNoExpiry={mcpPatAllowNoExpiry} />
      <McpGrantsPanel />
    </div>
  );
}
