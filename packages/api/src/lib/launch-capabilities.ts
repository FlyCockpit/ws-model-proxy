/**
 * Whether a node can run a runtime's launch: its platform, the management modes it supports
 * and the shells its text commands need. Placement leaves out a node that cannot
 * (`unsupported_platform`), so a spec is never placed where its commands would only fail on the
 * node. Pure: contracts are also bundled for the browser.
 */
import { z } from "zod";
import {
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

const legacyInfoSchema = z.object({ executionMechanism: z.string().optional() });

/**
 * What the node reports (`features.launch`). An older CLI reports none: its
 * `node.info.executionMechanism` tells Linux with a systemd user manager (processes and
 * services) from macOS (services only), both running `sh`. Null when nothing says (an older
 * CLI on any other platform, or no user manager): the node is not checked here and refuses
 * what it cannot run itself.
 */
export function launchCapabilities(
  features: unknown,
  nodeInfo: unknown,
): LaunchCapabilities | null {
  const parsed = nodeFeaturesSchema.safeParse(features);
  const launch = parsed.success ? parsed.data.launch : undefined;
  if (launch)
    return {
      platform: launch.platform,
      management: new Set(launch.management),
      shells: new Set(launch.shells),
    };
  const info = legacyInfoSchema.safeParse(nodeInfo);
  const mechanism = info.success ? info.data.executionMechanism : undefined;
  if (mechanism === "macos")
    return { platform: "macos", management: new Set(["service"]), shells: new Set(["sh"]) };
  if (mechanism?.startsWith("systemd"))
    return {
      platform: "linux",
      management: new Set(["process", "service"]),
      shells: new Set(["sh"]),
    };
  return null;
}

/** The parts of a launch that say what it needs; a launch shape without them needs nothing. */
export type LaunchNeeds = Partial<Pick<RuntimeLaunch, "management" | "commands">>;

/** Every text command of the launch's command sets (argv commands need no shell). */
function usesShell(commands: LaunchNeeds["commands"]): boolean {
  return (commands ?? []).some((set) =>
    [set.start, set.stop, set.prepare, set.afterJoin, set.status, set.health].some(
      (command) => typeof command === "string",
    ),
  );
}

/** The shell the launch's text commands run in, or null when it has none. */
export function launchShell(launch: LaunchNeeds): RuntimeShell | null {
  return usesShell(launch.commands) ? "sh" : null;
}

/** Whether a node with `capabilities` can run `launch`. */
export function launchRunsOn(launch: LaunchNeeds, capabilities: LaunchCapabilities): boolean {
  if (launch.management && !capabilities.management.has(launch.management)) return false;
  const shell = launchShell(launch);
  return shell === null || capabilities.shells.has(shell);
}
