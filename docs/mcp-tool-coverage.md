# MCP tool coverage

Status: partial (built incrementally by the staged MCP implementation). The
FULL generated artifact — every `appRouter` leaf with its tool name or
exclusion reason, scope, confirmation policy, projector, feature gate, and
side-effect class — is produced by MCP plan Phase 9 from
`apps/server/src/mcp/tool-manifest.ts`. Until then, this document records
exclusion decisions that must hold in the final artifact.

## Human-only procedures (Phase 7)

The `mcpGrants` router (`packages/api/src/routers/mcp-grants.ts`) is
HUMAN-ONLY: it is mounted on `appRouter` for the browser-session settings
page (`/{lang}/settings/mcp`) and is excluded from the MCP tool catalog in
`MCP_TOOL_EXCLUSIONS`. Neither procedure may ever appear as an MCP tool: a
connected MCP client must not be able to enumerate or revoke the human's
other authorizations.

| Procedure | Tool name | Exclusion reason |
| --- | --- | --- |
| `mcpGrants.listMine` | — (excluded) | Human-only MCP grant management: a connected MCP client must not enumerate the user's other authorizations. |
| `mcpGrants.revokeMine` | — (excluded) | Human-only MCP grant revocation: only the browser session may kill grant generations. |

Enforcement (all pinned by `apps/server/src/mcp/tool-manifest.test.ts`):

- the invariant-12 completeness check walks every `appRouter` leaf and fails
  unless each leaf is a tool target or an explicit `MCP_TOOL_EXCLUSIONS`
  entry — adding `mcpGrants` without an exclusion fails the suite;
- the pinned exclusion list asserts both `mcpGrants` leaves verbatim;
- a dedicated Phase 7 assertion proves both leaves are absent from the tool
  catalog under any name, and drives EVERY procedure-backed tool's real
  invoker through a recording proxy client: each tool must dispatch to
  exactly its declared target leaf (so a selector swap fails the suite) and
  no dispatch may touch any `mcpGrants` path.

Unlike authorization, discovery, MCP login/consent, and `/mcp`, the
`mcpGrants` procedures and the settings page are deliberately NOT gated on
`WMP_MCP_ENABLED` (MCP plan invariant 13): humans must be able to kill
outstanding authorization during an emergency MCP shutdown. Normal browser
authentication still applies.
