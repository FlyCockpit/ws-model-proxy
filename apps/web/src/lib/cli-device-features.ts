export type TerminalFeature = {
  granted: boolean;
  deviceAllows: boolean | null;
  supported: boolean | null;
  live: boolean;
  available: boolean;
};

export type CommandFeature = {
  granted: boolean;
  deviceAllows: boolean | null;
  live: boolean;
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
  granted: false,
  deviceAllows: null,
  live: false,
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

export function featureSwitchState(
  feature: { granted: boolean; deviceAllows: boolean | null; supported?: boolean | null },
  kind: "terminal" | "commands",
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
