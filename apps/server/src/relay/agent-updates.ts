/**
 * The relay half of wsmp self-update (`packages/api/src/lib/agent-updates.ts` holds the rules):
 * the {@link AgentUpdatePort} the `nodes.agentUpdate.*` procedures use (release manifest, live
 * session, `agent.update` send), the `agent.update.progress` handler, and the tick that applies
 * the server deadline (`timed_out`) and drives "Update all" runs from the database (so a restart
 * of this server resumes them).
 */

import { AGENT_UPDATE_TERMINAL_PHASES } from "@ws-model-proxy/api/lib/agent-update-wire";
import type {
  AgentUpdateLiveNode,
  AgentUpdatePort,
  AgentUpdateRelease,
} from "@ws-model-proxy/api/lib/agent-updates";
import {
  advanceAgentUpdateBatches,
  applyAgentUpdateProgress,
  expireAgentUpdates,
  pruneAgentUpdates,
} from "@ws-model-proxy/api/lib/agent-updates";
import type { NodeSelfUpdate } from "@ws-model-proxy/api/lib/runtime-spec";
import { env } from "@ws-model-proxy/env/server";
import type { CliInstallSource, CliReleaseManifest } from "../node-http.js";
import { SERVER_VERSION } from "../version.js";
import type {
  NodeToServerControlFrame,
  NodeTrustWire,
  ServerToNodeControlFrame,
} from "./frames.js";
import type { NodeFrameHandlers, NodeSessionRef, SendGuard } from "./session-manager.js";

type ProgressFrame = Extract<NodeToServerControlFrame, { type: "agent.update.progress" }>;

export const AGENT_UPDATE_TICK_MS = 15_000;
const PRUNE_EVERY_TICKS = 240;

type RelayPort = {
  sendToNode(nodeId: string, frame: ServerToNodeControlFrame, guard?: SendGuard): boolean;
  nodeSession(nodeId: string): {
    userId: string;
    connectionGeneration: number;
    trust: NodeTrustWire;
    selfUpdate: NodeSelfUpdate | null;
  } | null;
};

export type AgentUpdateDeps = {
  manifest?: { get(): Promise<CliReleaseManifest> };
  source?: () => CliInstallSource;
  origin?: () => string;
  tickMs?: number;
};

function toRelease(manifest: CliReleaseManifest): AgentUpdateRelease {
  if (manifest.sourceBuild)
    return { kind: "source", version: manifest.version, commit: manifest.commit };
  return {
    kind: "release",
    version: manifest.version,
    commit: manifest.commit,
    releaseUrl: manifest.releaseUrl ?? "",
    artifacts: manifest.artifacts,
  };
}

/**
 * `node-http.ts` loads on first use: it pulls in the HTTP rate limiters, which modules that
 * only wire the relay (and their tests) must not need.
 */
const nodeHttp = () => import("../node-http.js");

export function createAgentUpdates(relay: RelayPort, deps: AgentUpdateDeps = {}) {
  const manifest = deps.manifest ?? {
    get: async () => (await nodeHttp()).cliReleaseManifests.get(),
  };
  const source = async (): Promise<CliInstallSource> =>
    deps.source
      ? deps.source()
      : (await nodeHttp()).cliInstallSource(env.WMP_CLI_SOURCE_REV, env.WMP_CLI_RELEASE_BASE_URL);
  const origin = deps.origin ?? (() => env.BETTER_AUTH_URL);
  let timer: ReturnType<typeof setInterval> | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let ticks = 0;

  const port: AgentUpdatePort = {
    server: async () => {
      const current = await source();
      return {
        version: SERVER_VERSION,
        commit: (await nodeHttp()).cliInstallCommit(current),
        sourceBuild: current.kind === "source",
        cargoInstall: (await nodeHttp()).cargoInstallCommand(current),
      };
    },
    release: async () => {
      try {
        return toRelease(await manifest.get());
      } catch {
        // Fail closed: no checksums, no update.
        const current = await source();
        return {
          kind: "unavailable",
          version: SERVER_VERSION,
          commit: (await nodeHttp()).cliInstallCommit(current),
        };
      }
    },
    liveNode: (nodeId): AgentUpdateLiveNode | null => {
      const session = relay.nodeSession(nodeId);
      return session
        ? {
            userId: session.userId,
            connectionGeneration: session.connectionGeneration,
            trust: session.trust,
            selfUpdate: session.selfUpdate,
          }
        : null;
    },
    // Full control and the owner are re-checked on the live session at the socket: a lowering
    // or a rebind that landed after the procedure's checks wins, and nothing is sent.
    send: (nodeId, frame, guard) =>
      relay.sendToNode(nodeId, frame, {
        connectionGeneration: guard.connectionGeneration,
        requireFullTrust: true,
        userId: guard.userId,
      }),
    wake: () => wake(),
  };

  /** One pass: deadlines, then every running batch. Passes never overlap. */
  async function tick(): Promise<void> {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        const now = new Date();
        try {
          await expireAgentUpdates(now);
          await advanceAgentUpdateBatches(port, origin(), now);
          ticks += 1;
          if (ticks % PRUNE_EVERY_TICKS === 0) await pruneAgentUpdates(now);
        } catch (error) {
          console.error(
            "[agent-update] tick failed",
            error instanceof Error ? error.constructor.name : typeof error,
          );
        }
      } while (again);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  function wake(): void {
    void tick();
  }

  const handlers: Pick<NodeFrameHandlers, "agent.update.progress"> = {
    "agent.update.progress": async (node: NodeSessionRef, frame: ProgressFrame) => {
      const result = await applyAgentUpdateProgress(
        { nodeId: node.nodeId, userId: node.userId },
        frame,
      );
      if (result.ended) wake();
      // The node reports an update's end on every session until this says it is stored.
      if (AGENT_UPDATE_TERMINAL_PHASES.has(frame.phase) && result.settled)
        relay.sendToNode(
          node.nodeId,
          { type: "agent.update.ack", updateId: frame.updateId },
          { connectionGeneration: node.connectionGeneration, userId: node.userId },
        );
    },
  };

  return {
    port,
    handlers,
    tick,
    start(): void {
      if (timer) return;
      timer = setInterval(wake, deps.tickMs ?? AGENT_UPDATE_TICK_MS);
      timer.unref?.();
      wake();
    },
    async stop(): Promise<void> {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
  };
}
