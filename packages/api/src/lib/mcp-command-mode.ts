/**
 * MCP command policy for a CLI device: `off`, `supervised` (only commands a
 * person confirms in a supervised terminal), or `unsupervised` (headless exec
 * too; it also permits supervised). The server grant, the CLI's own config,
 * and the live hello each carry one; the effective mode is the lowest.
 */
export const MCP_COMMAND_MODES = ["off", "supervised", "unsupervised"] as const;
export type McpCommandModeName = (typeof MCP_COMMAND_MODES)[number];
export type McpCommandModeDb = "OFF" | "SUPERVISED" | "UNSUPERVISED";

const RANK: Record<McpCommandModeName, number> = { off: 0, supervised: 1, unsupervised: 2 };

export function mcpCommandModeFromDb(value: McpCommandModeDb): McpCommandModeName;
export function mcpCommandModeFromDb(value: McpCommandModeDb | null): McpCommandModeName | null;
export function mcpCommandModeFromDb(value: McpCommandModeDb | null): McpCommandModeName | null {
  if (value === "UNSUPERVISED") return "unsupervised";
  if (value === "SUPERVISED") return "supervised";
  if (value === "OFF") return "off";
  return null;
}

export function mcpCommandModeToDb(value: McpCommandModeName): McpCommandModeDb {
  if (value === "unsupervised") return "UNSUPERVISED";
  if (value === "supervised") return "SUPERVISED";
  return "OFF";
}

export function isMcpCommandMode(value: unknown): value is McpCommandModeName {
  return value === "off" || value === "supervised" || value === "unsupervised";
}

/** The lower of the given modes; a missing mode counts as `off`. */
export function lowestMcpCommandMode(
  ...modes: ReadonlyArray<McpCommandModeName | null | undefined>
): McpCommandModeName {
  let lowest: McpCommandModeName = "unsupervised";
  for (const mode of modes) {
    const value = mode ?? "off";
    if (RANK[value] < RANK[lowest]) lowest = value;
  }
  return lowest;
}

export function mcpCommandModeAtLeast(
  mode: McpCommandModeName | null | undefined,
  minimum: McpCommandModeName,
): boolean {
  return RANK[mode ?? "off"] >= RANK[minimum];
}

/** Supervised terminals are allowed in `supervised` and `unsupervised`. */
export function allowsSupervisedCommands(mode: McpCommandModeName | null | undefined): boolean {
  return mcpCommandModeAtLeast(mode, "supervised");
}

/** Headless exec (`forwarder_cli_command_run`) needs `unsupervised`. */
export function allowsHeadlessCommands(mode: McpCommandModeName | null | undefined): boolean {
  return mode === "unsupervised";
}

/**
 * Which switch holds `effectiveMode` below `unsupervised`, in the order the
 * relay refuses a command (`apps/server/src/relay/cli-commands.ts`):
 * - `grant`: the dashboard grant is the stricter of the two (or the grant is
 *   `off`, which the relay refuses before it looks at the CLI);
 * - `offline`: the grant allows commands but the CLI is not connected or
 *   predates command support, so its config cannot be read;
 * - `cliConfig`: the CLI's own `wsmp config set-mcp-commands` is stricter;
 * - `both`: the grant and the CLI config are equal, and below `unsupervised`;
 * - `null`: nothing limits the device (both allow `unsupervised`).
 * The token switch (allowCliCommands + mcp:write) is per token, not per device.
 */
export type McpCommandLimit = "grant" | "offline" | "cliConfig" | "both" | null;

export function mcpCommandLimit(input: {
  grant: McpCommandModeName;
  /** The CLI is connected and reports a mode (protocol 2.6 or later). */
  live: boolean;
  /** The CLI's reported config mode; ignored unless `live`. */
  cliMode: McpCommandModeName | null | undefined;
}): McpCommandLimit {
  if (input.grant === "off") return "grant";
  if (!input.live) return "offline";
  const grantRank = RANK[input.grant];
  const cliRank = RANK[input.cliMode ?? "off"];
  if (grantRank < cliRank) return "grant";
  if (cliRank < grantRank) return "cliConfig";
  return input.grant === "unsupervised" ? null : "both";
}
