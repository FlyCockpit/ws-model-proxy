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
 * Why the relay would refuse a command right now, per command kind. These are
 * the relay's own error codes (`apps/server/src/relay/cli-commands.ts`); the
 * token (switch 1) and the per-CLI concurrency limit are not device state and
 * are not modelled here.
 * - `grant_disabled`: the dashboard grant is `off` (headless), or does not
 *   allow supervised commands (supervised).
 * - `grant_supervised_only` / `cli_supervised_only`: the relay's single
 *   `supervised_only` (headless exec needs `unsupervised`), split by which
 *   switch is `supervised`: the grant is checked first, so the grant when it is
 *   `supervised`, otherwise the CLI's config.
 * - `offline`: the CLI is not connected, predates command support, or (for
 *   supervised) does not implement supervised terminals.
 * - `feature_disabled`: the CLI's own config refuses.
 * - `unsupported`: supervised only; the CLI has no PTY (Windows).
 */
export type McpCommandRefusal =
  | "grant_disabled"
  | "grant_supervised_only"
  | "cli_supervised_only"
  | "offline"
  | "feature_disabled"
  | "unsupported";

/** The live CLI facts the relay reads; null when offline or older than protocol 2.6. */
export type McpCommandLive = {
  mode: McpCommandModeName;
  supervisedCommands: boolean;
  terminalSupported: boolean;
};

export type McpCommandRefusals = {
  /** `forwarder_cli_command_run`; null when the relay would admit it. */
  headless: McpCommandRefusal | null;
  /** `forwarder_cli_supervised_command_start`; null when the relay would admit it. */
  supervised: McpCommandRefusal | null;
};

/**
 * The ONE place that mirrors the relay's device-state refusal order, for
 * display only (it gates nothing; the relay still decides). Codes equal the
 * relay's, except `supervised_only`, which is split by switch. Both checks run
 * in the relay's exact order, so the first refusal here is the one an agent
 * would get. `relay/cli-commands.supervised.test.ts` compares this against the
 * real start functions for every state.
 */
export function mcpCommandRefusals(input: {
  grant: McpCommandModeName;
  live: McpCommandLive | null;
}): McpCommandRefusals {
  return {
    headless: headlessRefusal(input.grant, input.live),
    supervised: supervisedRefusal(input.grant, input.live),
  };
}

function headlessRefusal(
  grant: McpCommandModeName,
  live: McpCommandLive | null,
): McpCommandRefusal | null {
  if (grant === "off") return "grant_disabled";
  if (!allowsHeadlessCommands(grant)) return "grant_supervised_only";
  if (!live) return "offline";
  if (live.mode === "off") return "feature_disabled";
  if (!allowsHeadlessCommands(live.mode)) return "cli_supervised_only";
  return null;
}

function supervisedRefusal(
  grant: McpCommandModeName,
  live: McpCommandLive | null,
): McpCommandRefusal | null {
  if (!allowsSupervisedCommands(grant)) return "grant_disabled";
  if (!live?.supervisedCommands) return "offline";
  if (!allowsSupervisedCommands(live.mode)) return "feature_disabled";
  if (!live.terminalSupported) return "unsupported";
  return null;
}
