/**
 * Whether a node can run a runtime's launch: the management modes it supports and the shells its
 * text commands need. Placement leaves out a node that cannot (`unsupported_platform`). The node's
 * platform is reported but not matched: a launch does not say which operating system its commands
 * are for, so an `sh` command that only Linux can run (`systemctl`) may still be placed on macOS,
 * where it fails on the node. Pure: contracts are also bundled for the browser.
 */
import {
  COMMAND_FIELDS,
  type NodePlatform,
  nodeFeaturesSchema,
  type RuntimeLaunch,
  type RuntimeManagement,
  type RuntimeShell,
} from "./runtime-spec";

export type LaunchCapabilities = {
  platform: NodePlatform;
  management: ReadonlySet<RuntimeManagement>;
  shells: ReadonlySet<RuntimeShell>;
};

/** Stored launch evidence, ignoring retired top-level fields; null when unavailable. */
export function launchCapabilities(features: unknown): LaunchCapabilities | null {
  const parsed = nodeFeaturesSchema.strip().safeParse(features);
  const launch = parsed.success ? parsed.data.launch : undefined;
  if (launch)
    return {
      platform: launch.platform,
      management: new Set(launch.management),
      shells: new Set(launch.shells),
    };
  return null;
}

/** The parts of a launch that say what it needs; a launch shape without them needs nothing. */
export type LaunchNeeds = Partial<Pick<RuntimeLaunch, "management" | "commands" | "shell">>;

/** Whether any command of the launch's command sets is text (argv commands need no shell). */
function usesShell(commands: LaunchNeeds["commands"]): boolean {
  return (commands ?? []).some((set) =>
    COMMAND_FIELDS.some((field) => typeof set[field] === "string"),
  );
}

/**
 * The shell the launch's text commands run in (`launch.shell`, `sh` when absent), or null when
 * it has none.
 */
export function launchShell(launch: LaunchNeeds): RuntimeShell | null {
  return usesShell(launch.commands) ? (launch.shell ?? "sh") : null;
}

/**
 * Whether a node with `capabilities` can run `launch`: its management mode, and the launch's
 * shell, or for argv commands alone any shell but `cmd` (the node quotes an argv for it).
 */
export function launchRunsOn(launch: LaunchNeeds, capabilities: LaunchCapabilities): boolean {
  if (launch.management && !capabilities.management.has(launch.management)) return false;
  const shell = launchShell(launch);
  if (shell !== null) return capabilities.shells.has(shell);
  if (!launch.commands || launch.commands.length === 0) return true;
  return [...capabilities.shells].some((available) => available !== "cmd");
}
