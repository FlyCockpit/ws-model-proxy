/**
 * `runtimes.start` / `runtimes.stop`: placement preview, the people-echo-the-fingerprint rule
 * (D13) and the agent trust rule (agents act only on Full-control nodes, `trust_relay`).
 *
 * Preview-quality placement (TODO(planner)): nodes are chosen by connection, hold, labels and
 * free ports. Memory accounting, fabrics for multi-node starts and preemption (`stops`) belong
 * to the planner, which is not ported yet; `stops` is always empty here.
 */
import { createHash, randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/server";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import type { z } from "zod";
import { contractProcedure, type SignedInContext } from "../contract-procedure";
import { agentRulesApply, isHumanCaller } from "../contracts/auth-context";
import type { RefusalReason } from "../contracts/refusals";
import {
  runtimesContract as c,
  type placementSchema,
  type previewWarningSchema,
  type startPreviewSchema,
} from "../contracts/runtimes";
import { callerActor, notFound, refusal } from "../lib/caller-actor";
import { canonicalJson } from "../lib/canonical-json";
import { runtimeSpecWarnings } from "../lib/runtime-spec";
import { effectiveTrust, specIsInteractive, type Tx } from "../lib/runtime-store";
import { INSTANCE_INCLUDE, instanceView, storedSpec } from "../lib/runtime-views";
import { runSerializableTransaction } from "../lib/serializable-transaction";

type StartInput = z.infer<typeof c.start.input>;
type StartPreview = z.infer<typeof startPreviewSchema>;
type Placement = z.infer<typeof placementSchema>;
type Warning = z.infer<typeof previewWarningSchema>;
type Refusal = { reason: RefusalReason; subjectId: string | null; message: string };

const REFUSAL_MESSAGES: Partial<Record<RefusalReason, string>> = {
  trust_relay:
    "This node is Relay only: agents cannot start or stop runtimes there. A person can do it in the browser.",
  node_offline: "This node is offline.",
  node_held: "A person put this node on hold; nothing is placed there until it is released.",
  label_mismatch: "This node lacks a label the runtime requires.",
  no_free_ports: "This node has no free port in its range.",
  port_in_use: "The runtime's fixed port is already claimed on this node.",
  unknown_node: "That node does not exist.",
  invalid_node_count: "Give exactly one node per rank (groupSize).",
  not_enough_nodes: "Not enough eligible nodes are online for this runtime.",
};

function refusalOf(reason: RefusalReason, subjectId: string | null): Refusal {
  return { reason, subjectId, message: REFUSAL_MESSAGES[reason] ?? reason };
}

/** A cuid2-shaped id (lower-case, starts with a letter) so the handle can be derived from it. */
function newRowId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(24);
  let id = "c";
  for (let index = 1; index < 24; index++) id += alphabet[(bytes[index] ?? 0) % alphabet.length];
  return id;
}

function fingerprintOf(preview: Omit<StartPreview, "fingerprint">): string {
  return createHash("sha256").update(canonicalJson(preview), "utf8").digest("hex");
}

type NodeRow = {
  id: string;
  slug: string;
  trust: "RELAY" | "FULL" | null;
  trustLowerRequestedAt: Date | null;
  connection: "ONLINE" | "OFFLINE";
  holdAt: Date | null;
  labels: string[];
  portStart: number;
  portEnd: number;
  Ranks: Array<{ port: number }>;
};

async function loadNodes(db: Tx, userId: string): Promise<NodeRow[]> {
  return db.node.findMany({
    where: { userId },
    select: {
      id: true,
      slug: true,
      trust: true,
      trustLowerRequestedAt: true,
      connection: true,
      holdAt: true,
      labels: true,
      portStart: true,
      portEnd: true,
      Ranks: { where: { claim: { in: ["HELD", "HELD_UNKNOWN"] } }, select: { port: true } },
    },
    orderBy: { slug: "asc" },
  });
}

/** Why this node cannot take a rank (first reason), or null. Trust is checked first for agents. */
function nodeRefusal(
  node: NodeRow,
  agent: boolean,
  labels: readonly string[],
): RefusalReason | null {
  if (agent && effectiveTrust(node) !== "FULL") return "trust_relay";
  if (node.holdAt) return "node_held";
  if (node.connection !== "ONLINE") return "node_offline";
  if (!labels.every((label) => node.labels.includes(label))) return "label_mismatch";
  return null;
}

function freePort(
  node: NodeRow,
  taken: Set<number>,
  fixed: number | undefined,
): number | RefusalReason {
  const used = new Set([...node.Ranks.map((rank) => rank.port), ...taken]);
  if (fixed !== undefined) return used.has(fixed) ? "port_in_use" : fixed;
  for (let port = node.portStart; port <= node.portEnd; port++) if (!used.has(port)) return port;
  return "no_free_ports";
}

type Computed = {
  preview: StartPreview;
  runtimeId: string;
  versionId: string;
  restart: { instanceId: string } | null;
};

async function computeStart(
  db: Tx,
  context: SignedInContext,
  input: StartInput,
): Promise<Computed> {
  const userId = context.session.user.id;
  const agent = agentRulesApply(context.auth);
  const runtime = await db.runtime.findFirst({
    where: { id: input.runtimeId, userId },
    select: { id: true, kind: true, currentVersionId: true },
  });
  if (!runtime) throw notFound("That runtime does not exist.");
  if (runtime.kind !== "STARTABLE")
    throw new ORPCError("BAD_REQUEST", { message: "An always-on runtime is not started." });
  const versionId = input.versionId ?? runtime.currentVersionId;
  const version = versionId
    ? await db.runtimeVersion.findFirst({
        where: { id: versionId, runtimeId: runtime.id },
        select: { id: true, spec: true },
      })
    : null;
  if (!version) throw notFound("That version does not exist.");
  const spec = storedSpec(version.spec);
  const launch = spec.launch;
  if (!launch) throw new ORPCError("BAD_REQUEST", { message: "This version has no launch." });

  const nodes = await loadNodes(db, userId);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const refusals: Refusal[] = [];
  const warnings: Warning[] = [];
  const starts: StartPreview["starts"] = [];
  const takenPorts = new Map<string, Set<number>>();
  const portsOn = (nodeId: string) => {
    let set = takenPorts.get(nodeId);
    if (!set) {
      set = new Set();
      takenPorts.set(nodeId, set);
    }
    return set;
  };
  const resourcesOf = (rank: number) =>
    (launch.resources[rank] ?? launch.resources[0]) as unknown as Record<string, unknown>;

  /** Places one instance on exactly these nodes (rank order), collecting refusals. */
  const placeOn = (nodeIds: readonly string[], ownPorts: readonly number[] | null) => {
    const placements: Placement[] = [];
    nodeIds.forEach((nodeId, rank) => {
      const node = byId.get(nodeId);
      if (!node) {
        refusals.push(refusalOf("unknown_node", nodeId));
        return;
      }
      const reason = nodeRefusal(node, agent, launch.labels);
      if (reason) {
        refusals.push(refusalOf(reason, node.id));
        return;
      }
      const ownPort = ownPorts?.[rank];
      const port =
        ownPort !== undefined ? ownPort : freePort(node, portsOn(node.id), launch.port?.fixed);
      if (typeof port !== "number") {
        refusals.push(refusalOf(port, node.id));
        return;
      }
      portsOn(node.id).add(port);
      placements.push({
        nodeId: node.id,
        nodeSlug: node.slug,
        nodeNumber: rank + 1,
        port,
        resources: resourcesOf(rank),
      });
    });
    return placements;
  };

  let restart: Computed["restart"] = null;
  if (input.instanceId) {
    const instance = await db.runtimeInstance.findFirst({
      where: { id: input.instanceId, runtimeId: runtime.id, userId },
      select: {
        id: true,
        Ranks: { select: { nodeId: true, port: true, claim: true }, orderBy: { rank: "asc" } },
      },
    });
    if (!instance) throw notFound("That instance does not exist.");
    if (instance.Ranks.length !== launch.groupSize)
      refusals.push(refusalOf("invalid_node_count", instance.id));
    restart = { instanceId: instance.id };
    // The instance keeps its own ports; a still-held claim does not block itself.
    const nodeIds = instance.Ranks.map((rank) => rank.nodeId ?? "");
    for (const rank of instance.Ranks)
      if (rank.nodeId && rank.claim !== "RELEASED") {
        const node = byId.get(rank.nodeId);
        if (node) node.Ranks = node.Ranks.filter((held) => held.port !== rank.port);
      }
    starts.push({
      runtimeId: runtime.id,
      versionId: version.id,
      instanceId: instance.id,
      placements: placeOn(
        nodeIds,
        instance.Ranks.map((rank) => rank.port),
      ),
    });
  } else if (input.nodeIds) {
    if (
      input.nodeIds.length !== launch.groupSize ||
      new Set(input.nodeIds).size !== input.nodeIds.length
    )
      refusals.push(refusalOf("invalid_node_count", null));
    else
      starts.push({
        runtimeId: runtime.id,
        versionId: version.id,
        instanceId: null,
        placements: placeOn(input.nodeIds, null),
      });
  } else {
    const count = input.count ?? 1;
    const eligible = nodes.filter((node) => nodeRefusal(node, agent, launch.labels) === null);
    for (let index = 0; index < count; index++) {
      // Least-loaded first; one rank per node within an instance.
      const ranked = [...eligible].sort(
        (a, b) =>
          a.Ranks.length + portsOn(a.id).size - (b.Ranks.length + portsOn(b.id).size) ||
          a.slug.localeCompare(b.slug),
      );
      const chosen = ranked
        .filter((node) => typeof freePort(node, portsOn(node.id), launch.port?.fixed) === "number")
        .slice(0, launch.groupSize);
      if (chosen.length < launch.groupSize) {
        const onlyTrust =
          agent &&
          nodes.some(
            (node) =>
              effectiveTrust(node) !== "FULL" && nodeRefusal(node, false, launch.labels) === null,
          );
        refusals.push(refusalOf(onlyTrust ? "trust_relay" : "not_enough_nodes", null));
        break;
      }
      starts.push({
        runtimeId: runtime.id,
        versionId: version.id,
        instanceId: null,
        placements: placeOn(
          chosen.map((node) => node.id),
          null,
        ),
      });
    }
  }

  if (specIsInteractive(spec))
    warnings.push({
      code: "interactive_needs_person",
      nodeId: null,
      detail: "A step of this runtime runs in an operator terminal and waits for a person.",
    });
  if (runtimeSpecWarnings(spec).includes("binds_all_interfaces"))
    warnings.push({
      code: "binds_all_interfaces",
      nodeId: null,
      detail: "A command binds 0.0.0.0 or ::, which exposes the server beyond the node.",
    });

  const body = { starts, stops: [], kept: [], warnings, refusals };
  return {
    preview: { fingerprint: fingerprintOf(body), ...body },
    runtimeId: runtime.id,
    versionId: version.id,
    restart,
  };
}

function actorRefOf(operation: {
  actor: "USER" | "AGENT" | "SYSTEM";
  actorUserId: string;
  agentTokenId: string | null;
}) {
  return {
    actor: operation.actor,
    userId: operation.actorUserId,
    agentTokenId: operation.agentTokenId,
    label: null,
  };
}

async function operationView(operationId: string) {
  const operation = await prisma.runtimeOperation.findUniqueOrThrow({
    where: { id: operationId },
    select: {
      id: true,
      kind: true,
      createdAt: true,
      actor: true,
      actorUserId: true,
      agentTokenId: true,
      Instances: { include: INSTANCE_INCLUDE, orderBy: { createdAt: "asc" } },
    },
  });
  return {
    id: operation.id,
    kind: operation.kind,
    createdAt: operation.createdAt.toISOString(),
    actor: actorRefOf(operation),
    instances: operation.Instances.map(instanceView),
  };
}

function throwFirstRefusal(refusals: readonly Refusal[]): void {
  const first = refusals[0];
  if (first) throw refusal(first.reason, first.message, first.subjectId);
}

export const runtimeStart = contractProcedure(c.start).handler(async ({ input, context }) => {
  const userId = context.session.user.id;
  if (input.preview) {
    const computed = await computeStart(prisma, context, input);
    return { mode: "preview" as const, preview: computed.preview };
  }
  // People apply exactly the preview they saw (D13); agents may omit the fingerprint.
  const person = isHumanCaller(context.auth);
  if (person && !input.fingerprint)
    throw refusal("preview_required", "Preview the start first, then confirm it.");
  const actor = callerActor(context.auth, userId);
  const operationId = await runSerializableTransaction(async (tx) => {
    const computed = await computeStart(tx, context, input);
    if (input.fingerprint && input.fingerprint !== computed.preview.fingerprint)
      throw refusal("preview_stale", "Things changed since the preview. Preview again.");
    throwFirstRefusal(computed.preview.refusals);
    const operation = await tx.runtimeOperation.create({
      data: {
        userId,
        kind: computed.restart ? "RESTART" : "START",
        actor: actor.actor,
        actorUserId: actor.actorUserId,
        agentTokenId: actor.agentTokenId,
        summary: computed.preview as unknown as Prisma.InputJsonValue,
        fingerprint: computed.preview.fingerprint,
      },
      select: { id: true },
    });
    const now = new Date();
    for (const start of computed.preview.starts) {
      if (start.instanceId) {
        await tx.runtimeInstance.update({
          where: { id: start.instanceId },
          data: {
            versionId: computed.versionId,
            launchVersionId: computed.versionId,
            operationId: operation.id,
            startedBy: actor.actor,
            desiredState: "RUNNING",
            phase: "STARTING",
            phaseChangedAt: now,
            phaseReason: "restart_requested",
            needsOperator: null,
            needsOperatorSince: null,
            restartsInWindow: 0,
            restartWindowStartedAt: null,
            nextRestartAt: null,
          },
        });
        await tx.instanceRank.updateMany({
          where: { instanceId: start.instanceId, claim: { not: "HELD" } },
          data: { claim: "HELD", claimChangedAt: now, stoppedAt: null },
        });
        continue;
      }
      const id = newRowId();
      const handle = `i-${id.slice(0, 12)}`;
      await tx.runtimeInstance.create({
        data: {
          id,
          userId,
          runtimeId: computed.runtimeId,
          versionId: computed.versionId,
          launchVersionId: computed.versionId,
          handle,
          operationId: operation.id,
          startedBy: actor.actor,
          desiredState: "RUNNING",
          phase: "STARTING",
          Ranks: {
            create: start.placements.map((placement) => ({
              nodeId: placement.nodeId,
              rank: placement.nodeNumber - 1,
              unitName: `wsmp-${handle}-r${placement.nodeNumber - 1}`,
              port: placement.port,
              portFixed: false,
              resources: placement.resources as object,
            })),
          },
        },
      });
    }
    return operation.id;
  });
  await context.services?.dispatchRuntimeOperation?.({ userId, operationId });
  return { mode: "applied" as const, operation: await operationView(operationId) };
});

export const runtimeStop = contractProcedure(c.stop).handler(async ({ input, context }) => {
  const userId = context.session.user.id;
  const actor = callerActor(context.auth, userId);
  const where =
    "instanceId" in input
      ? { id: input.instanceId, userId, desiredState: "RUNNING" as const }
      : {
          runtimeId: input.runtimeId,
          userId,
          desiredState: "RUNNING" as const,
          ...(input.nodeId ? { Ranks: { some: { nodeId: input.nodeId } } } : {}),
        };
  const instances = await prisma.runtimeInstance.findMany({
    where,
    select: {
      id: true,
      Ranks: {
        select: { Node: { select: { id: true, trust: true, trustLowerRequestedAt: true } } },
      },
    },
  });
  if (instances.length === 0) throw notFound("Nothing of this runtime is running there.");
  if (agentRulesApply(context.auth))
    for (const instance of instances)
      for (const rank of instance.Ranks)
        if (!rank.Node || effectiveTrust(rank.Node) !== "FULL")
          throw refusal(
            "trust_relay",
            REFUSAL_MESSAGES.trust_relay ?? "trust_relay",
            rank.Node?.id ?? instance.id,
          );
  const ids = instances.map((instance) => instance.id);
  const operationId = await prisma.$transaction(async (tx) => {
    const operation = await tx.runtimeOperation.create({
      data: {
        userId,
        kind: "STOP",
        actor: actor.actor,
        actorUserId: actor.actorUserId,
        agentTokenId: actor.agentTokenId,
        summary: { stops: ids },
        fingerprint: createHash("sha256")
          .update(canonicalJson({ stops: ids }), "utf8")
          .digest("hex"),
      },
      select: { id: true },
    });
    await tx.runtimeInstance.updateMany({
      where: { id: { in: ids }, desiredState: "RUNNING" },
      data: {
        desiredState: "STOPPED",
        phase: "STOPPING",
        phaseChangedAt: new Date(),
        phaseReason: "stop_requested",
        operationId: operation.id,
      },
    });
    return operation.id;
  });
  await context.services?.dispatchRuntimeOperation?.({ userId, operationId });
  return operationView(operationId);
});
