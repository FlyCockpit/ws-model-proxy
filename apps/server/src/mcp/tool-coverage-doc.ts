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

const FOOTER = `## Supervised CLI file writes

The five file mutation tools return a supervised request id when the node's effective
mode is supervised. A person's keypress on the CLI-drawn screen is required; the CLI
computes a complete diff from disk with byte provenance. Disk-derived removed/context
lines are masked; an added line carrying any masked disk byte (including whole-line
and continuation masks) blocks with redacted_span after dismissal. Pure requester
additions stay visible with controls escaped. Diff and mask use LF-only lines; a
lone CR stays escaped content, and unmappable line counts block with redacted_span.
Details discloses creation mode, all preserved permission bits, parent creation,
ifExists, overwrite and byte counts. Diffs exceeding
the 8 KiB display cap are blocked with too_large after dismissal. A supervised directory
rename without replacement is refused with unsupported on macOS. Poll \`forwarder_cli_command_result\` for
\`file:{op,result}\` or \`error:{code,message,outcome?}\`. Approval implies no read grant.
Physical root confinement (path_denied), including outside-root text, escaping links
and unavailable roots, and normalized argument growth above 128 KiB (too_large)
are blocked screens whose codes reach the agent only after dismissal. Aliases
resolving inside roots are allowed. The child uses the daemon startup root snapshot;
apply rechecks authoritative policy. Pre-display refusals depend only on request
text/input policy (invalid_input, secret_file, protected/staging names, special trees,
declared sizes), process/mode and capacity checks. The full read grant admits reads
in supervised/off modes and never writes; off refuses writes.
Server termination after dispatch without authoritative CLI settlement is unknown
with started:true when the server received acceptance and started:null otherwise. CLI decline/rejection
and blocked done before acceptance, and undispatched failures remain definitive.
Finished file answers and their single audit event do not change on late reports.
Only a supervised start id is delivered despite MCP abort; headless file results keep
the abort fence. See [CLI file tools](mcp.md#cli-file-tools-relay-protocol-24).

Overwrite rename preflights before capture and supports exchange-less no-replace
and link mounts. Stable-inode link publication links the source onto the destination
before capturing it; no-replace and noino/sshfs vacate first. Neither primitive
means \`unsafe_filesystem\` with no public change. Plain link rename uses that same
order, own-name alias proofs, and a source-bound etag at the published name.
Directories require no-replace, never overwrite, and own-subtree moves are invalid_input.
Alias cleanup vetoes the unlink on a believable link count below 2 (statx FORCE_SYNC on Linux, calibrated per operation) and reports a last surviving alias; residual
(g) also applies to rename. Crash residue includes captured source/destination, an
INTENT slot map fsynced before the first capture, and private preflight dummies.
Startup reports \`.wsmp-recover-*\` and never deletes them; there is no replay. Rust tests
cover Linux/macOS injected capability, ownership, race, cancellation and reply-loss
tables; the strict real-mount test checks six declared primitive/inode classes (plus a constant-link-count and a cached-attribute class). CI
runs it on real FUSE mounts in the \`exchangeless-fs\` job (\`apps/cli/scripts/test-exchangeless-fs.sh\`,
no installs; a failed mount fails the job).

## Human-only procedures (Phase 7)

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
is gated on the flag. Normal browser authentication still applies.

## External fallback settings and consent

Sending request data to external providers needs consent a person gave.
MCP tools can never grant it:

- \`modelApiTokens.updateExternalAccess\` (a token's \`allowExternal\` and
  per-pool \`includeExternal\`) is excluded from the catalog (decision C1);
- \`modelApiTokens.updateExternalWait\` (a token's \`externalAfterWaitMs\`) is
  an ordinary \`mcp:write\` tool, \`model_api_token_external_wait_update\`,
  with no confirmation. Null uses each pool's wait; a request header or MCP
  argument cannot exceed the token setting (or the pool cap when the token
  has no override). Grantees cannot shorten below the pool value;
- \`providerManagement.setAllowDataCollection\` (the OpenRouter
  "providers that may collect data" opt-out, decision D9) is excluded, and
  \`provider_account_create\` / \`provider_account_update\` reject
  \`allowDataCollection\` in their input schemas; \`providerManagement.updateAccount\`
  refuses an MCP session moving an OpenRouter account to another provider
  type (the privacy preference is keyed on the type).

The pool owner's fallback switches (\`fallbackEnabled\`,
\`fallbackForGrantees\`, \`externalAfterWaitMs\`) are an ordinary
\`mcp:write\` tool, \`forwarder_pool_fallback_update\`, with no per-change
confirmation (owner decision on issue #67). Its description states the cost
effect, and every change, from MCP or the dashboard, writes a
\`POOL_FALLBACK_UPDATED\` provider audit event. So that the cost statement is
always seen:

- \`forwarder_model_pool_create\` and \`forwarder_model_pool_update\` reject
  \`fallbackEnabled\` and \`fallbackForGrantees\` in their input schemas
  (advertised as \`not: {}\` with a description naming
  \`forwarder_pool_fallback_update\`), whatever the value; they still accept
  \`externalAfterWaitMs\`, and their descriptions state its cost;
- \`forwarder_guarded_pool_create\` rejects non-empty \`providerModels\`,
  because attaching external members there turns fallback on implicitly.

\`forwarder_pool_fallback_get\` reads the same data as the dashboard: owners
get the switches, the external members in fallback order and the own-key
request count; grantees get provider types only and their own-key route.

No tool result can carry a secret value WMP holds (provider API keys,
encrypted credential material, token secrets or hashes, device-flow and 2FA
backup codes), in any encoding: pinned for every tool by
\`apps/server/src/mcp/secret-output.test.ts\`. Pinned by \`apps/server/src/mcp/tool-manifest.test.ts\`.`;

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
