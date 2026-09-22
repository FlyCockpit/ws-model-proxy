import { MCP_TOOL_EXCLUSIONS, MCP_TOOL_MANIFEST } from "./tool-manifest";

/**
 * Generator for the pinned tool-coverage artifact
 * (`docs/mcp-tool-coverage.md`, Phase 9: "checked coverage artifact
 * ... generated/validated from the manifest, fails on drift").
 *
 * The markdown below is FULLY GENERATED from `MCP_TOOL_MANIFEST` +
 * `MCP_TOOL_EXCLUSIONS` — every appRouter leaf appears exactly once as a
 * tool row or an exclusion row (the completeness invariant itself is
 * separately enforced by tool-manifest.test.ts against the real appRouter;
 * the drift test tool-coverage-doc.test.ts pins the committed artifact
 * byte-for-byte against this renderer).
 *
 * Regenerate after changing the manifest:
 *   UPDATE_MCP_TOOL_COVERAGE=1 pnpm --filter server test -- tool-coverage-doc
 */

const HEADER = `# MCP tool coverage

GENERATED FILE — do not edit by hand. Produced from
\`apps/server/src/mcp/tool-manifest.ts\` (\`MCP_TOOL_MANIFEST\` +
\`MCP_TOOL_EXCLUSIONS\`) by \`apps/server/src/mcp/tool-coverage-doc.ts\`;
\`apps/server/src/mcp/tool-coverage-doc.test.ts\` fails when this file
drifts from the manifest. Regenerate with:

\`\`\`sh
UPDATE_MCP_TOOL_COVERAGE=1 pnpm --filter server test -- tool-coverage-doc
\`\`\`

Every \`appRouter\` leaf is either an MCP tool target or an explicit
exclusion (invariant 12); the completeness check walks the real router and
fails the suite when a leaf is unclassified.`;

const FOOTER = `## Human-only procedures (Phase 7)

The \`mcpGrants\` router (\`packages/api/src/routers/mcp-grants.ts\`) and the
\`mcpTokens\` router (\`packages/api/src/routers/mcp-tokens.ts\`) are
HUMAN-ONLY: they are mounted on \`appRouter\` for the browser-session settings
page (\`/{lang}/settings/mcp\`) and are excluded from the MCP tool catalog in
\`MCP_TOOL_EXCLUSIONS\`. None of these procedures may ever appear as an MCP
tool: a connected MCP client must not be able to enumerate, mint, or revoke
the human's other authorizations or personal tokens.

Enforcement (all pinned by \`apps/server/src/mcp/tool-manifest.test.ts\`):

- the invariant-12 completeness check walks every \`appRouter\` leaf and fails
  unless each leaf is a tool target or an explicit \`MCP_TOOL_EXCLUSIONS\`
  entry — adding \`mcpGrants\` or \`mcpTokens\` without an exclusion fails the
  suite;
- the pinned exclusion list asserts the \`mcpGrants\` and \`mcpTokens\` leaves
  verbatim;
- a dedicated Phase 7 assertion proves those leaves are absent from the tool
  catalog under any name, and drives EVERY procedure-backed tool's real
  invoker through a recording proxy client: each tool must dispatch to
  exactly its declared target leaf (so a selector swap fails the suite) and
  no dispatch may touch any \`mcpGrants\` or \`mcpTokens\` path.

Unlike authorization, discovery, MCP login/consent, and \`/mcp\`, grant and
token *revocation* and the settings page are deliberately NOT gated on
\`WMP_MCP_ENABLED\` (invariant 13): humans must be able to kill outstanding
authorization during an emergency MCP shutdown. Personal-token *creation*
is gated on the flag. Normal browser authentication still applies.`;

interface CoverageRow {
  readonly target: string;
  readonly tool: string;
  readonly scope: string;
  readonly confirmation: string;
  readonly classification: string;
  readonly projector: string;
  readonly featureGates: string;
  readonly reason: string;
}

/**
 * Deterministic label for a descriptor's `outputProjector` (Phase 9
 * requires the coverage artifact to disclose the projector). The manifest
 * stores the projector as a function (`projectCredentialRows` et al.), so
 * the label is its function name — stable because the manifest is authored
 * as named module-level functions; an anonymous projector is surfaced as
 * `(anonymous projector)` rather than silently omitted.
 */
function projectorLabel(projector: ((output: unknown) => unknown) | undefined): string {
  if (!projector) return "—";
  return `\`${projector.name || "(anonymous projector)"}\``;
}

function renderRow(row: CoverageRow): string {
  const cells = [
    `\`${row.target}\``,
    row.tool,
    row.scope,
    row.confirmation,
    row.classification,
    row.projector,
    row.featureGates,
    row.reason,
  ];
  return `| ${cells.join(" | ")} |`;
}

/** Render the complete coverage artifact markdown (deterministic output). */
export function renderMcpToolCoverageDoc(): string {
  const rows: CoverageRow[] = [
    ...MCP_TOOL_MANIFEST.map(
      (tool): CoverageRow => ({
        target: tool.target,
        tool: `\`${tool.name}\``,
        scope: tool.scope,
        confirmation: tool.confirmation ?? "—",
        classification: tool.classification,
        projector: projectorLabel(tool.outputProjector),
        featureGates: tool.featureDependencies?.length
          ? tool.featureDependencies.map((name) => `\`${name}\``).join(", ")
          : "—",
        reason: "—",
      }),
    ),
    ...MCP_TOOL_EXCLUSIONS.map(
      (exclusion): CoverageRow => ({
        target: exclusion.target,
        tool: "— (excluded)",
        scope: "—",
        confirmation: "—",
        classification: "—",
        projector: "—",
        featureGates: "—",
        reason: exclusion.reason,
      }),
    ),
  ];

  const table = [
    "| Procedure / core target | Tool name | Scope | Confirmation | Side-effect class | Output projector | Feature gates | Exclusion reason |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0)).map(renderRow),
  ];

  return `${HEADER}\n\n## Coverage table\n\n${table.join("\n")}\n\n${FOOTER}\n`;
}
