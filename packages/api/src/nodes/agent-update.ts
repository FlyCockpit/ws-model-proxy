/**
 * `nodes.agentUpdate.*`: wsmp self-update from the owner's browser (plan D4, D7, D8). Every
 * procedure is `human` access (a CSRF-checked cookie session; never MCP, OAuth or an agent
 * token), scoped to the caller's own nodes (`Node.userId`), and refused in an admin's
 * impersonation session: an admin never updates someone else's node. The domain logic is
 * `lib/agent-updates.ts`; the relay is `context.services.agentUpdates`.
 */
import prisma from "@ws-model-proxy/db";
import { env } from "@ws-model-proxy/env/server";
import type { z } from "zod";
import type { Context } from "../context";
import { contractProcedure, type SignedInContext } from "../contract-procedure";
import {
  type agentUpdateBatchViewSchema,
  type agentUpdateViewSchema,
  nodesContract as c,
  type nodeAgentUpdateViewSchema,
} from "../contracts/nodes";
import type { RefusalReason } from "../contracts/refusals";
import {
  AGENT_UPDATE_NODE_SELECT,
  type AgentUpdatePort,
  type AgentUpdateRelease,
  advanceAgentUpdateBatch,
  agentUpdateEligibility,
  agentUpdateRefusalMessage,
  agentUpdateReleaseDigest,
  chooseCanary,
  orderForBatch,
  parseWsl,
  phaseFromDb,
  startAgentUpdate,
  untouchedNodeIds,
} from "../lib/agent-updates";
import { isUniqueViolation, notFound, refuse, refuseAbout } from "../lib/refuse";
import { stopInstancesOnNode } from "../routers/runtime-lifecycle";
import { effectiveTrust } from "./trust";

type UpdateView = z.infer<typeof agentUpdateViewSchema>;
type NodeUpdateView = z.infer<typeof nodeAgentUpdateViewSchema>;
type BatchView = z.infer<typeof agentUpdateBatchViewSchema>;

/** Without the relay (tests, a server without it): nothing updates from the browser. */
const NO_PORT: AgentUpdatePort = {
  server: async () => ({
    version: "",
    commit: null,
    sourceBuild: false,
    cargoInstall: "",
    windowsUpdates: false,
  }),
  release: async () => ({ kind: "unavailable", version: "", commit: null }),
  liveNode: () => null,
  send: () => false,
};

function portOf(context: Context): AgentUpdatePort {
  return context.services?.agentUpdates ?? NO_PORT;
}

function origin(): string {
  return env.BETTER_AUTH_URL;
}

/** D4: the owner's own session, never an admin acting as them. */
function assertOwnSession(context: SignedInContext): string {
  if (context.session.session.impersonatedBy)
    throw refuse(
      "human_only",
      "Updating wsmp needs the node owner's own session, not an impersonation.",
      "FORBIDDEN",
    );
  return context.session.user.id;
}

const BATCH_RECENT_MS = 24 * 3_600_000;

const UPDATE_SELECT = {
  id: true,
  nodeId: true,
  phase: true,
  reason: true,
  detail: true,
  fromVersion: true,
  toVersion: true,
  force: true,
  strategy: true,
  fromCommit: true,
  availableVersion: true,
  createdAt: true,
  updatedAt: true,
  endedAt: true,
} as const;

type UpdateRow = {
  id: string;
  phase: Parameters<typeof phaseFromDb>[0];
  reason: string | null;
  detail: string | null;
  fromVersion: string | null;
  toVersion: string;
  force: boolean;
  strategy: string;
  createdAt: Date;
  updatedAt: Date;
  endedAt: Date | null;
};

function toUpdateView(row: UpdateRow): UpdateView {
  return {
    id: row.id,
    phase: phaseFromDb(row.phase),
    reason: row.reason,
    detail: row.detail,
    fromVersion: row.fromVersion,
    toVersion: row.toVersion,
    force: row.force,
    strategy: row.strategy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}

const BATCH_SELECT = {
  id: true,
  state: true,
  canaryNodeId: true,
  nodeIds: true,
  position: true,
  currentNodeId: true,
  currentUpdateId: true,
  skippedNodeIds: true,
  stoppedNodeId: true,
  stoppedReason: true,
} as const;

type BatchRow = {
  id: string;
  state: "RUNNING" | "DONE" | "STOPPED";
  canaryNodeId: string;
  nodeIds: string[];
  position: number;
  currentNodeId: string | null;
  currentUpdateId: string | null;
  skippedNodeIds: string[];
  stoppedNodeId: string | null;
  stoppedReason: string | null;
};

const STOP_REASONS = new Set([
  "stopped",
  "refused",
  "failed",
  "rolled_back",
  "timed_out",
  "release_changed",
]);

function toBatchView(row: BatchRow): BatchView {
  return {
    id: row.id,
    state: row.state === "RUNNING" ? "running" : row.state === "DONE" ? "done" : "stopped",
    canaryNodeId: row.canaryNodeId,
    nodeIds: row.nodeIds,
    currentNodeId: row.currentNodeId,
    stoppedReason:
      row.stoppedReason && STOP_REASONS.has(row.stoppedReason)
        ? (row.stoppedReason as BatchView["stoppedReason"])
        : null,
    untouchedNodeIds: untouchedNodeIds(row),
  };
}

/** Every node of the owner with what the Nodes page needs to offer (or explain) an update. */
async function loadOverview(userId: string, port: AgentUpdatePort, now: Date) {
  const nodes = await prisma.node.findMany({
    where: { userId },
    select: AGENT_UPDATE_NODE_SELECT,
    orderBy: { slug: "asc" },
  });
  const ids = nodes.map((node) => node.id);
  const [updates, ranks, release] = await Promise.all([
    ids.length === 0
      ? Promise.resolve([])
      : prisma.nodeAgentUpdate.findMany({
          where: { userId, nodeId: { in: ids } },
          orderBy: { createdAt: "desc" },
          distinct: ["nodeId"],
          select: UPDATE_SELECT,
        }),
    ids.length === 0
      ? Promise.resolve([])
      : prisma.instanceRank.findMany({
          where: {
            nodeId: { in: ids },
            Node: { userId },
            Instance: { userId, phase: { notIn: ["STOPPED", "FAILED"] } },
          },
          select: {
            nodeId: true,
            Instance: { select: { id: true, Runtime: { select: { name: true } } } },
          },
        }),
    port.release(),
  ]);
  const server = await port.server();
  const latestByNode = new Map(updates.map((update) => [update.nodeId, update]));
  const runningByNode = new Map<string, Map<string, string>>();
  for (const rank of ranks) {
    if (!rank.nodeId) continue;
    const running = runningByNode.get(rank.nodeId) ?? new Map<string, string>();
    running.set(rank.Instance.id, rank.Instance.Runtime.name);
    runningByNode.set(rank.nodeId, running);
  }
  const views: NodeUpdateView[] = nodes.map((node) => {
    const latest = latestByNode.get(node.id) ?? null;
    const latestPhase = latest ? phaseFromDb(latest.phase) : null;
    const eligibility = agentUpdateEligibility({
      row: node,
      live: port.liveNode(node.id),
      release,
      server,
      origin: origin(),
      active:
        latest && latest.endedAt === null && latestPhase
          ? { phase: latestPhase, strategy: latest.strategy }
          : null,
      latest:
        latest && latestPhase
          ? {
              phase: latestPhase,
              strategy: latest.strategy,
              reason: latest.reason,
              fromVersion: latest.fromVersion,
              fromCommit: latest.fromCommit,
              availableVersion: latest.availableVersion,
            }
          : null,
    });
    return {
      nodeId: node.id,
      slug: node.slug,
      connection: node.connection,
      trust: effectiveTrust(node),
      version: node.cliVersion,
      build: eligibility.build,
      wsl: parseWsl(node.environment),
      outdated: eligibility.outdated,
      newerThanServer: eligibility.newerThanServer,
      policy: node.agentUpdatePolicy,
      selfUpdate: eligibility.selfUpdate,
      canUpdate: eligibility.canUpdate,
      blockedReason: eligibility.blockedReason,
      manualCommand: eligibility.manualCommand,
      availableVersion: eligibility.availableVersion,
      availableVersionAhead: eligibility.availableVersionAhead,
      runningInstances: [...(runningByNode.get(node.id) ?? new Map()).entries()].map(
        ([id, name]) => ({ id, name }),
      ),
      latest: latest ? toUpdateView(latest) : null,
    };
  });
  const candidates = views
    .filter((view) => view.canUpdate)
    .map((view) => ({
      nodeId: view.nodeId,
      slug: view.slug,
      running: view.runningInstances.length,
    }));
  const batch = await prisma.nodeAgentUpdateBatch.findFirst({
    where: {
      userId,
      OR: [{ state: "RUNNING" }, { endedAt: { gte: new Date(now.getTime() - BATCH_RECENT_MS) } }],
    },
    orderBy: { createdAt: "desc" },
    select: BATCH_SELECT,
  });
  return { server, release, views, candidates, batch };
}

function serverView(
  server: Awaited<ReturnType<AgentUpdatePort["server"]>>,
  release: AgentUpdateRelease,
) {
  return {
    version: server.version,
    commit: server.commit,
    sourceBuild: server.sourceBuild || release.kind === "source",
  };
}

function refused(reason: RefusalReason, nodeId: string | null, slug: string) {
  return refuseAbout(reason, nodeId, agentUpdateRefusalMessage(reason, slug));
}

export const agentUpdateProcedures = {
  overview: contractProcedure(c.agentUpdate.overview).handler(async ({ context }) => {
    const userId = context.session.user.id;
    const { server, release, views, candidates, batch } = await loadOverview(
      userId,
      portOf(context),
      new Date(),
    );
    return {
      server: serverView(server, release),
      nodes: views,
      defaultCanaryNodeId: chooseCanary(candidates),
      batch: batch ? toBatchView(batch) : null,
    };
  }),

  start: contractProcedure(c.agentUpdate.start).handler(async ({ context, input }) => {
    const userId = assertOwnSession(context);
    const port = portOf(context);
    const outcome = await startAgentUpdate(port, {
      userId,
      nodeId: input.nodeId,
      force: input.force ?? false,
      origin: origin(),
      ...(input.version !== undefined ? { version: input.version } : {}),
    });
    if (outcome.kind === "not_found") throw notFound("That node does not exist.");
    if (outcome.kind === "refused")
      throw refuseAbout(outcome.reason, input.nodeId, outcome.message);
    // Only a batch step is pinned to a release.
    if (outcome.kind === "release_changed")
      throw refuse("agent_update_unavailable", "The server's release changed; try again.");
    // Force: the node's instances would not survive its restart, so the server stops them
    // itself, as `runtimes.stop` does (recorded and shown like any stop). The node waits until
    // they are stopped, then installs.
    if (input.force && port.liveNode(input.nodeId)?.selfUpdate?.instancesSurvive === false)
      await stopInstancesOnNode(context, userId, input.nodeId);
    const row = await prisma.nodeAgentUpdate.findFirst({
      where: { id: outcome.updateId, userId },
      select: UPDATE_SELECT,
    });
    if (!row) throw notFound("That update does not exist.");
    return toUpdateView(row);
  }),

  startAll: contractProcedure(c.agentUpdate.startAll).handler(async ({ context, input }) => {
    const userId = assertOwnSession(context);
    const port = portOf(context);
    const now = new Date();
    const running = await prisma.nodeAgentUpdateBatch.findFirst({
      where: { userId, state: "RUNNING" },
      select: { id: true },
    });
    if (running)
      throw refuse("agent_update_in_progress", "An Update all run is already in progress.");
    // One read of the release: the nodes are judged against the release the run pins.
    const { views, candidates, release } = await loadOverview(userId, port, now);
    let canary: string | null;
    if (input.canaryNodeId !== undefined) {
      const chosen = views.find((view) => view.nodeId === input.canaryNodeId);
      if (!chosen) throw notFound("That node does not exist.");
      if (!chosen.canUpdate)
        throw refused(
          chosen.blockedReason ?? "agent_update_unavailable",
          chosen.nodeId,
          chosen.slug,
        );
      canary = chosen.nodeId;
    } else canary = chooseCanary(candidates);
    if (canary === null)
      throw refuse("agent_update_unavailable", "No node can update from here right now.");
    const nodeIds = [
      canary,
      ...orderForBatch(candidates.filter((candidate) => candidate.nodeId !== canary)),
    ];
    let batchId: string;
    try {
      const created = await prisma.nodeAgentUpdateBatch.create({
        // Pinned for the whole run: every node gets the release the canary validated.
        data: {
          userId,
          canaryNodeId: canary,
          nodeIds,
          targetVersion: release.version,
          targetDigest: agentUpdateReleaseDigest(release),
        },
        select: { id: true },
      });
      batchId = created.id;
    } catch (error) {
      if (isUniqueViolation(error))
        throw refuse("agent_update_in_progress", "An Update all run is already in progress.");
      throw error;
    }
    // The canary starts now; the server's tick drives the rest.
    await advanceAgentUpdateBatch(port, batchId, origin(), now);
    port.wake?.();
    const row = await prisma.nodeAgentUpdateBatch.findFirst({
      where: { id: batchId, userId },
      select: BATCH_SELECT,
    });
    if (!row) throw notFound("That run does not exist.");
    return toBatchView(row);
  }),

  stopAll: contractProcedure(c.agentUpdate.stopAll).handler(async ({ context, input }) => {
    const userId = assertOwnSession(context);
    await prisma.nodeAgentUpdateBatch.updateMany({
      where: { id: input.batchId, userId, state: "RUNNING" },
      data: { state: "STOPPED", stoppedReason: "stopped", endedAt: new Date() },
    });
    const row = await prisma.nodeAgentUpdateBatch.findFirst({
      where: { id: input.batchId, userId },
      select: BATCH_SELECT,
    });
    if (!row) throw notFound("That run does not exist.");
    return toBatchView(row);
  }),

  setPolicy: contractProcedure(c.agentUpdate.setPolicy).handler(async ({ context, input }) => {
    const userId = assertOwnSession(context);
    const written = await prisma.node.updateMany({
      where: { id: input.nodeId, userId },
      data: { agentUpdatePolicy: input.policy },
    });
    if (written.count !== 1) throw notFound("That node does not exist.");
    return { policy: input.policy };
  }),
};
