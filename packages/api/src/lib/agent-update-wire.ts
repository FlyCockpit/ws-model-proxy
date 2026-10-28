/**
 * The wire vocabulary of `wsmp` self-update (relay 3.0, extended in place): the hello `build`
 * and `environment` the node reports, the `agent.update` frame the server sends and the
 * `agent.update.progress` phases and reasons the node answers with. The relay schemas
 * (`apps/server/src/relay/frames.ts`) and the procedures (`nodes/agent-update.ts`) share these;
 * the Rust mirror is `apps/cli/src/protocol/frames.rs`.
 */
import { z } from "zod";

/** How the node's wsmp was installed (the node's install receipt, or its best guess). */
export const AGENT_INSTALL_METHODS = [
  "script",
  "script-ps1",
  "homebrew",
  "cargo",
  "binstall",
  "npm",
  "source",
  "unknown",
] as const;
export type AgentInstallMethod = (typeof AGENT_INSTALL_METHODS)[number];

/** `hello.node.build`: tells two builds of one version apart. */
export const nodeBuildSchema = z
  .object({
    commit: z
      .string()
      .regex(/^[0-9a-f]{40}$/)
      .nullable(),
    installMethod: z.enum(AGENT_INSTALL_METHODS),
    /** The Rust target triple the binary was built for. */
    target: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/),
  })
  .strict();
export type NodeBuild = z.infer<typeof nodeBuildSchema>;

/** `hello.node.environment`: sent only when there is something to say. */
export const nodeEnvironmentSchema = z.object({ wsl: z.boolean().optional() }).strict();
export type NodeEnvironment = z.infer<typeof nodeEnvironmentSchema>;

/** Phases the node reports in `agent.update.progress`. */
export const AGENT_UPDATE_NODE_PHASES = [
  "refused",
  "waiting_idle",
  "downloading",
  "verifying",
  "armed",
  "swapped",
  "restarting",
  "confirmed",
  "rolled_back",
  "failed",
] as const;
export type AgentUpdateNodePhase = (typeof AGENT_UPDATE_NODE_PHASES)[number];

/** Every phase of an update as the server records it: the node's plus `requested`, `timed_out`. */
export const AGENT_UPDATE_PHASES = ["requested", ...AGENT_UPDATE_NODE_PHASES, "timed_out"] as const;
export type AgentUpdatePhase = (typeof AGENT_UPDATE_PHASES)[number];

export const AGENT_UPDATE_TERMINAL_PHASES: ReadonlySet<AgentUpdatePhase> = new Set([
  "confirmed",
  "rolled_back",
  "failed",
  "refused",
  "timed_out",
]);

/** Why the node refused or failed an update (`reason`, only with `refused` or `failed`). */
export const AGENT_UPDATE_REASONS = [
  "not_owner_trust",
  "opted_out",
  "source_build",
  "unsupported_method",
  "busy",
  "signature_mismatch",
  "checksum_mismatch",
  "download_failed",
  "version_mismatch",
  "already_current",
  "in_progress",
  "internal",
] as const;
export type AgentUpdateReason = (typeof AGENT_UPDATE_REASONS)[number];

/** `detail`: at most this many characters (Unicode scalar values, as the node counts them). */
export const AGENT_UPDATE_DETAIL_MAX_CHARS = 4000;

/** The dead-man deadline the server sends (`rollbackAfterSecs`). */
export const AGENT_UPDATE_ROLLBACK_SECS_MIN = 30;
export const AGENT_UPDATE_ROLLBACK_SECS_MAX = 600;
export const AGENT_UPDATE_ROLLBACK_SECS_DEFAULT = 180;

/** An `agent.update` updateId: 16 random bytes, unpadded base64url. */
export const agentUpdateIdSchema = z.string().regex(/^[A-Za-z0-9_-]{21}[AQgw]$/);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** https only, except plain http to the loopback host (tests, development). */
export function agentUpdateArtifactUrlAllowed(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/** `agent.update` (server → node), as the procedures build it. */
export type AgentUpdateFrame = {
  type: "agent.update";
  updateId: string;
  version: string;
  artifactUrl: string;
  sha256: string;
  /** Reserved for minisign (self-update D9); null today. */
  signature: string | null;
  force: boolean;
  rollbackAfterSecs: number;
};
