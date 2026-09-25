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
