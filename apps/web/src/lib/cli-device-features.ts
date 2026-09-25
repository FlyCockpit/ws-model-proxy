export type TerminalFeature = {
  granted: boolean;
  deviceAllows: boolean | null;
  supported: boolean | null;
  live: boolean;
  available: boolean;
  /** The CLI requires local approval before a browser can view a terminal. */
  approvalRequired?: boolean | null;
};

export const MCP_COMMAND_MODES = ["off", "supervised", "unsupervised"] as const;
export type McpCommandMode = (typeof MCP_COMMAND_MODES)[number];

export type CommandFeature = {
  /** The dashboard grant. */
  mode: McpCommandMode;
  /** The CLI's own config mode; null until a 2.6 CLI reports it. */
  deviceMode: McpCommandMode | null;
  /** Supervised commands need a PTY (not on Windows). */
  supported: boolean | null;
  live: boolean;
  effectiveMode: McpCommandMode;
  available: boolean;
};

export type CliDeviceFeatures = {
  cliVersion: string | null;
  relayProtocolVersion: string | null;
  features: {
    terminal: TerminalFeature;
    commands: CommandFeature;
  };
};

export type FeatureSwitchReason = "windows" | "configDisabled" | "updateWsmp";

export type TerminalOpenBlockReason =
  | FeatureSwitchReason
  | "notGranted"
  | "offline"
  | "unavailable";

const EMPTY_TERMINAL: TerminalFeature = {
  granted: false,
  deviceAllows: null,
  supported: null,
  live: false,
  available: false,
};

const EMPTY_COMMANDS: CommandFeature = {
  mode: "off",
  deviceMode: null,
  supported: null,
  live: false,
  effectiveMode: "off",
  available: false,
};

/** Reads the typed list-CLI feature fields. Missing objects mean "not reported". */
export function readCliDeviceFeatures(device: {
  cliVersion?: string | null;
  relayProtocolVersion?: string | null;
  features?: {
    terminal?: TerminalFeature;
    commands?: CommandFeature;
  } | null;
}): CliDeviceFeatures {
  return {
    cliVersion: device.cliVersion ?? null,
    relayProtocolVersion: device.relayProtocolVersion ?? null,
    features: {
      terminal: device.features?.terminal ?? EMPTY_TERMINAL,
      commands: device.features?.commands ?? EMPTY_COMMANDS,
    },
  };
}

function modeRank(mode: McpCommandMode): number {
  return MCP_COMMAND_MODES.indexOf(mode);
}

/**
 * Whether the dashboard can grant `option` for this CLI, and why not. `off`
 * and the current grant are always selectable, so a grant can always be
 * lowered. A higher mode needs the CLI to allow it in its own config, and
 * supervised commands need a PTY.
 */
export function commandModeOptionState(
  feature: CommandFeature,
  option: McpCommandMode,
): { disabled: boolean; reason: FeatureSwitchReason | null } {
  if (option === "off" || option === feature.mode) return { disabled: false, reason: null };
  if (feature.supported === false && option === "supervised") {
    return { disabled: true, reason: "windows" };
  }
  if (feature.deviceMode === null) return { disabled: true, reason: "updateWsmp" };
  if (modeRank(option) > modeRank(feature.deviceMode)) {
    return { disabled: true, reason: "configDisabled" };
  }
  return { disabled: false, reason: null };
}

/** Recommend CLI-side browser approval while agents can ask for supervised commands. */
export function recommendTerminalApproval(
  commands: CommandFeature,
  terminal: TerminalFeature,
): boolean {
  return commands.mode !== "off" && terminal.approvalRequired !== true;
}

export function featureSwitchState(
  feature: { granted: boolean; deviceAllows: boolean | null; supported?: boolean | null },
  kind: "terminal",
): { disabled: boolean; reason: FeatureSwitchReason | null } {
  let reason: FeatureSwitchReason | null = null;
  if (kind === "terminal" && feature.supported === false) reason = "windows";
  else if (feature.deviceAllows === false) reason = "configDisabled";
  else if (feature.deviceAllows !== true) reason = "updateWsmp";
  // A grant that is already on can always be switched off.
  if (feature.granted) return { disabled: false, reason };
  return { disabled: reason !== null, reason };
}

export function terminalOpenBlockReason(feature: TerminalFeature): TerminalOpenBlockReason | null {
  const gate = featureSwitchState(feature, "terminal");
  if (gate.reason) return gate.reason;
  if (!feature.granted) return "notGranted";
  if (!feature.live) return "offline";
  if (!feature.available) return "unavailable";
  return null;
}

export function featureReasonKey(reason: TerminalOpenBlockReason): string {
  switch (reason) {
    case "windows":
      return "dashboard:clis.features.windows";
    case "configDisabled":
      return "dashboard:clis.features.configDisabled";
    case "updateWsmp":
      return "dashboard:clis.features.updateWsmp";
    case "notGranted":
      return "dashboard:terminals.reasons.notGranted";
    case "offline":
      return "dashboard:terminals.reasons.offline";
    case "unavailable":
      return "dashboard:terminals.reasons.unavailable";
  }
}
