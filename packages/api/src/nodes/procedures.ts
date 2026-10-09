/**
 * Lane B: node procedures (list, detail, the node definition, hold, temporary, rename, delete,
 * trust lowering, fabrics, activity). Terminals, queued commands, commands and files stay with
 * lane D (`routers/nodes.ts` keeps their stubs).
 */
import { ORPCError } from "@orpc/server";
import prisma, { Prisma } from "@ws-model-proxy/db";
import type { Context } from "../context";
import { contractProcedure, type SignedInContext } from "../contract-procedure";
import { nodesContract as c } from "../contracts/nodes";
import { loadAgentNames } from "../lib/agent-names";
import { assertMayWrite, callerActor } from "../lib/caller-actor";
import { graphDelete, graphWrite } from "../lib/graph-write";
import {
  isForeignKeyViolation,
  isUniqueViolation,
  notFound,
  refuse,
  refuseAbout,
} from "../lib/refuse";
import { nodeMetricCommandsHash } from "../lib/runtime-launch-hash";
import { nodeMetricCommandsSchema } from "../lib/runtime-spec";
import {
  fabricInUseRefusal,
  fabricMemberNodeIds,
  isFabricMemberInUse,
  refreshFabricsHashes,
  replaceNodeFabrics,
} from "./fabrics";
import { loadNodeDetail, loadNodeSummary } from "./load";
import { isFullControl, nodeTrustView } from "./trust";
import { nodeListSelect, parseHeldDefinitions, toNodeListRow } from "./views";

function relayOnly(nodeId: string) {
  return refuseAbout(
    "trust_relay",
    nodeId,
    "This node is Relay only: its definition is frozen. Run `wsmp trust full` on the node to change it.",
  );
}

/** Run a relay hook after commit; the node resyncs at its next hello if it fails. */
async function afterCommit(hook: (() => Promise<void>) | undefined): Promise<void> {
  if (!hook) return;
  try {
    await hook();
  } catch {
    // Best effort: the committed state is the source of truth and is pushed on reconnect.
  }
}

function relay(context: Context) {
  return context.services?.nodes;
}

const NOT_RUNNING = ["STOPPED", "FAILED"] as const;

/** Fields of `nodes.update` that change what is pushed to the node (`runtime.define` node part). */
const PUSHED_FIELDS = ["portRange", "metricCommands", "fabrics", "commandMaxMs"] as const;

export const nodeProcedures = {
  list: contractProcedure(c.list).handler(async ({ context }) => {
    const now = new Date();
    const rows = await prisma.node.findMany({
      where: { userId: context.session.user.id },
      select: nodeListSelect,
      orderBy: { slug: "asc" },
    });
    return { nodes: rows.map((row) => toNodeListRow(row, now)) };
  }),

  get: contractProcedure(c.get).handler(async ({ context, input }) =>
    loadNodeDetail(context.session.user.id, input.nodeId),
  ),

  update: contractProcedure(c.update).handler(async ({ context, input }) => {
    assertMayWrite(context.auth);
    const userId = context.session.user.id;
    const node = await prisma.node.findFirst({
      where: { id: input.nodeId, userId },
      select: {
        id: true,
        trust: true,
        trustChangedAt: true,
        trustLowerRequestedAt: true,
        heldMetricCommandsHash: true,
      },
    });
    if (!node) throw notFound("That node does not exist.");
    if (!isFullControl(node)) throw relayOnly(node.id);
    if (input.metricCommands) nodeMetricCommandsSchema.parse(input.metricCommands);

    const changed = (
      ["labels", "portRange", "hardware", "metricCommands", "fabrics", "commandMaxMs"] as const
    ).filter((field) => input[field] !== undefined);
    const actor = callerActor(context.auth, userId);
    let pushTo: string[] = [];

    try {
      pushTo = await graphWrite([userId], async (tx) => {
        const metricCommands = input.metricCommands;
        // Conditional on Full control, so a lower that commits after the read above wins.
        const written = await tx.node.updateMany({
          where: { id: node.id, userId, trust: "FULL", trustLowerRequestedAt: null },
          data: {
            ...(input.labels !== undefined ? { labels: input.labels } : {}),
            ...(input.portRange !== undefined
              ? { portStart: input.portRange[0], portEnd: input.portRange[1] }
              : {}),
            ...(input.hardware !== undefined
              ? input.hardware === null
                ? {
                    declaredResources: Prisma.DbNull,
                    declaredResourcesAt: null,
                    declaredResourcesBy: null,
                  }
                : {
                    declaredResources: input.hardware,
                    declaredResourcesAt: new Date(),
                    declaredResourcesBy: actor.actor,
                  }
              : {}),
            ...(metricCommands !== undefined
              ? {
                  metricCommands,
                  metricCommandsHash:
                    metricCommands.length === 0 && node.heldMetricCommandsHash === null
                      ? null
                      : nodeMetricCommandsHash(metricCommands),
                }
              : {}),
            ...(input.commandMaxMs !== undefined ? { commandMaxMs: input.commandMaxMs } : {}),
          },
        });
        if (written.count === 0) throw relayOnly(node.id);
        let affected: string[] = [node.id];
        if (input.fabrics !== undefined) {
          const fabricNodes = await replaceNodeFabrics(tx, userId, node.id, input.fabrics);
          await refreshFabricsHashes(tx, userId, fabricNodes);
          affected = [...new Set([node.id, ...fabricNodes])];
        }
        if (changed.length > 0) {
          const now = new Date();
          await tx.nodeAuditEvent.create({
            data: {
              userId,
              nodeId: node.id,
              actor: actor.actor,
              agentTokenId: actor.agentTokenId,
              mcpGrantId: actor.mcpGrantId,
              kind: "node_update",
              subject: `node:${changed.join(",")}`,
              outcome: "completed",
              reason: input.note ?? null,
              startedAt: now,
              finishedAt: now,
            },
          });
        }
        return affected;
      });
    } catch (error) {
      if (isFabricMemberInUse(error)) throw fabricInUseRefusal();
      if (isUniqueViolation(error))
        throw new ORPCError("CONFLICT", {
          message: "Another node already uses that address in the fabric.",
        });
      throw error;
    }

    const services = relay(context);
    if (PUSHED_FIELDS.some((field) => input[field] !== undefined)) {
      const definitionChanged = services?.definitionChanged;
      await afterCommit(definitionChanged && (() => definitionChanged(pushTo)));
    }
    if (input.rescan) {
      const rescan = services?.rescan;
      await afterCommit(rescan && (() => rescan(node.id)));
    }
    return loadNodeDetail(userId, node.id);
  }),

  setHold: contractProcedure(c.setHold).handler(async ({ context, input }) => {
    const userId = context.session.user.id;
    const updated = await prisma.node.updateMany({
      where: { id: input.nodeId, userId },
      data: input.hold
        ? { holdAt: new Date(), holdNote: input.note ?? null, holdProfileId: null }
        : { holdAt: null, holdNote: null, holdProfileId: null },
    });
    if (updated.count === 0) throw notFound("That node does not exist.");
    return loadNodeSummary(userId, input.nodeId);
  }),

  setTemporary: contractProcedure(c.setTemporary).handler(async ({ context, input }) => {
    const userId = context.session.user.id;
    const updated = await prisma.node.updateMany({
      where: { id: input.nodeId, userId },
      data: {
        removeAfterOfflineMs:
          input.removeAfterOfflineMs === null ? null : BigInt(input.removeAfterOfflineMs),
      },
    });
    if (updated.count === 0) throw notFound("That node does not exist.");
    return loadNodeSummary(userId, input.nodeId);
  }),

  rename: contractProcedure(c.rename).handler(async ({ context, input }) => {
    const userId = context.session.user.id;
    const updated = await prisma.node.updateMany({
      where: { id: input.nodeId, userId },
      data: { name: input.name },
    });
    if (updated.count === 0) throw notFound("That node does not exist.");
    return loadNodeSummary(userId, input.nodeId);
  }),

  delete: contractProcedure(c.delete).handler(async ({ context, input }) =>
    deleteNode(context, input.nodeId, null),
  ),

  deleteOffline: contractProcedure(c.deleteOffline).handler(async ({ context, input }) => {
    assertMayWrite(context.auth);
    return deleteNode(context, input.nodeId, { note: input.note ?? null });
  }),

  lowerTrustPreview: contractProcedure(c.lowerTrustPreview).handler(async ({ context, input }) => {
    const userId = context.session.user.id;
    const node = await prisma.node.findFirst({
      where: { id: input.nodeId, userId },
      select: {
        id: true,
        heldDefinitions: true,
        metricCommands: true,
        features: true,
        FabricMembers: { select: { fabricId: true, ip: true, Fabric: { select: { name: true } } } },
      },
    });
    if (!node) throw notFound("That node does not exist.");
    const frozen = await frozenParts(userId, node.id, node.heldDefinitions, node.metricCommands);
    const [openBrowserTerminals, queuedCommandsRefused, runningCommands] = await Promise.all([
      prisma.nodeAuditEvent.count({
        where: {
          userId,
          nodeId: node.id,
          kind: "browser_terminal",
          outcome: "opened",
          finishedAt: null,
        },
      }),
      prisma.queuedNodeCommand.count({ where: { userId, nodeId: node.id, state: "QUEUED" } }),
      prisma.nodeCommand.count({ where: { userId, nodeId: node.id, state: "RUNNING" } }),
    ]);
    return {
      frozenRuntimes: frozen.runtimes,
      frozenMetricCommands: frozen.metricCommands,
      frozenFabrics: node.FabricMembers.map((member) => ({
        fabricId: member.fabricId,
        name: member.Fabric.name,
        ip: member.ip,
      })),
      secretNames: secretNamesOf(node.features),
      runningCommands,
      openBrowserTerminals,
      queuedCommandsRefused,
    };
  }),

  lowerTrust: contractProcedure(c.lowerTrust).handler(async ({ context, input }) => {
    const userId = context.session.user.id;
    const now = new Date();
    const result = await graphWrite([userId], async (tx) => {
      const node = await tx.node.findFirst({
        where: { id: input.nodeId, userId },
        select: {
          id: true,
          userId: true,
          trust: true,
          trustChangedAt: true,
          trustLowerRequestedAt: true,
          trustLowerRequestedBy: true,
          User: { select: { name: true } },
          heldDefinitions: true,
          metricCommands: true,
        },
      });
      if (!node) throw notFound("That node does not exist.");
      let trustColumns = node;
      const requested =
        node.trust !== "RELAY" && node.trustLowerRequestedAt === null
          ? await tx.node.updateMany({
              where: {
                id: node.id,
                userId,
                trustLowerRequestedAt: null,
                NOT: { trust: "RELAY" },
              },
              data: { trustLowerRequestedAt: now, trustLowerRequestedBy: userId },
            })
          : { count: 0 };
      if (requested.count === 1) {
        trustColumns = { ...node, trustLowerRequestedAt: now, trustLowerRequestedBy: userId };
        await tx.queuedNodeCommand.updateMany({
          where: { userId, nodeId: node.id, state: "QUEUED" },
          data: { state: "REFUSED", decidedAt: now, decidedBy: userId, outcome: "trust_relay" },
        });
        await tx.nodeAuditEvent.create({
          data: {
            userId,
            nodeId: node.id,
            actor: "USER",
            kind: "trust_lower",
            subject: `node:${node.id}`,
            outcome: "accepted",
            startedAt: now,
            finishedAt: now,
          },
        });
      }
      return { node, trust: nodeTrustView(trustColumns) };
    });
    const lowerTrust = relay(context)?.lowerTrust;
    await afterCommit(lowerTrust && (() => lowerTrust(result.node.id)));
    const frozen = await frozenParts(
      userId,
      result.node.id,
      result.node.heldDefinitions,
      result.node.metricCommands,
    );
    return {
      trust: result.trust,
      frozenAgentWritten: [
        ...frozen.runtimes
          .filter((runtime) => runtime.agentWritten)
          .map((runtime) => ({
            kind: "runtime" as const,
            id: `${runtime.runtimeId}@${runtime.versionId}`,
            label: runtime.name,
          })),
        ...frozen.metricCommands
          .filter((command) => command.agentWritten)
          .map((command) => ({
            kind: "metric_command" as const,
            id: command.name,
            label: command.name,
          })),
      ],
    };
  }),

  fabrics: {
    list: contractProcedure(c.fabrics.list).handler(async ({ context }) => {
      const fabrics = await prisma.fabric.findMany({
        where: { userId: context.session.user.id },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          Members: {
            select: { nodeId: true, ip: true, Node: { select: { slug: true } } },
            orderBy: { createdAt: "asc" },
          },
        },
      });
      return {
        fabrics: fabrics.map((fabric) => ({
          id: fabric.id,
          name: fabric.name,
          members: fabric.Members.map((member) => ({
            nodeId: member.nodeId,
            slug: member.Node.slug,
            ip: member.ip,
          })),
        })),
      };
    }),

    rename: contractProcedure(c.fabrics.rename).handler(async ({ context, input }) => {
      const userId = context.session.user.id;
      let members: string[] = [];
      try {
        members = await graphWrite([userId], async (tx) => {
          const updated = await tx.fabric.updateMany({
            where: { id: input.fabricId, userId },
            data: { name: input.name },
          });
          if (updated.count === 0) throw notFound("That fabric does not exist.");
          const nodeIds = await fabricMemberNodeIds(tx, userId, [input.fabricId]);
          await refreshFabricsHashes(tx, userId, nodeIds);
          return nodeIds;
        });
      } catch (error) {
        if (isUniqueViolation(error))
          throw refuse("slug_taken", "You already have a fabric with that name.");
        throw error;
      }
      const definitionChanged = relay(context)?.definitionChanged;
      await afterCommit(definitionChanged && (() => definitionChanged(members)));
      return { ok: true as const };
    }),

    delete: contractProcedure(c.fabrics.delete).handler(async ({ context, input }) => {
      const userId = context.session.user.id;
      const members = await mapFabricInUse(() =>
        graphWrite([userId], async (tx) => {
          const fabric = await tx.fabric.findFirst({
            where: { id: input.fabricId, userId },
            select: { id: true, Members: { select: { nodeId: true } } },
          });
          if (!fabric) throw notFound("That fabric does not exist.");
          const nodeIds = fabric.Members.map((member) => member.nodeId);
          // `RuntimeInstance.fabricId` is set while a multi-node instance lives on the fabric.
          if ((await tx.runtimeInstance.count({ where: { userId, fabricId: fabric.id } })) > 0)
            throw refuseAbout(
              "fabric_in_use",
              fabric.id,
              "A multi-node instance runs on this fabric. Stop it first.",
            );
          await tx.fabric.delete({ where: { id: fabric.id } });
          await refreshFabricsHashes(tx, userId, nodeIds);
          return nodeIds;
        }),
      );
      const definitionChanged = relay(context)?.definitionChanged;
      await afterCommit(definitionChanged && (() => definitionChanged(members)));
      return { ok: true as const };
    }),
  },

  activity: {
    list: contractProcedure(c.activity.list).handler(async ({ context, input }) => {
      const userId = context.session.user.id;
      // Prisma's cursor subquery ignores `where`: only the caller's own rows position a page.
      if (
        input.cursor &&
        !(await prisma.nodeAuditEvent.findFirst({
          where: { id: input.cursor, userId },
          select: { id: true },
        }))
      )
        throw new ORPCError("BAD_REQUEST", { message: "Unknown cursor." });
      const rows = await prisma.nodeAuditEvent.findMany({
        where: {
          userId,
          ...(input.nodeId ? { nodeId: input.nodeId } : {}),
          ...(input.kind ? { kind: input.kind } : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
      const page = rows.slice(0, input.limit);
      const agentName = await loadAgentNames(userId, page);
      return {
        items: page.map((row) => ({
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          nodeId: row.nodeId,
          actor: row.actor,
          agentTokenId: row.agentTokenId,
          agentName: agentName(row),
          kind: row.kind,
          subject: row.subject,
          outcome: row.outcome,
          reason: row.reason,
          exitCode: row.exitCode,
          startedAt: row.startedAt.toISOString(),
          finishedAt: row.finishedAt?.toISOString() ?? null,
        })),
        nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
      };
    }),
  },
};

/** Fabric delete: the member trigger or the instance FK (RESTRICT) both mean fabric_in_use. */
async function mapFabricInUse<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isFabricMemberInUse(error) || isForeignKeyViolation(error)) throw fabricInUseRefusal();
    throw error;
  }
}

/**
 * Deletes one of the caller's nodes: its always-on runtimes go, every reservation there is
 * released and instances with a part there stop. `agent` (nodes.deleteOffline): refused while
 * the node is online (node_online), and audited with the node's slug and id (never its
 * credentials) because the node's own activity goes with it.
 */
async function deleteNode(
  context: SignedInContext,
  nodeId: string,
  agent: { note: string | null } | null,
) {
  const userId = context.session.user.id;
  const stopped = await graphDelete({ userId, nodeIds: [nodeId] }, async (tx) => {
    const node = await tx.node.findFirst({
      where: { id: nodeId, userId },
      select: { id: true, slug: true, connection: true },
    });
    if (!node) throw notFound("That node does not exist.");
    if (agent && node.connection === "ONLINE")
      throw refuseAbout(
        "node_online",
        node.id,
        "This node is online: agents delete only offline nodes. Stop wsmp on it (or ask a person to delete it in the browser).",
      );
    // Its always-on runtimes go with it; a profile pinning one keeps the runtime (NoAction).
    const pinned = await tx.profileItem.findFirst({
      where: { Runtime: { userId, nodeId: node.id } },
      select: { Profile: { select: { id: true } } },
    });
    if (pinned)
      throw refuseAbout(
        "pinned_by_profile",
        pinned.Profile.id,
        "A profile pins a runtime on this node. Remove it from the profile first.",
      );
    const ranks = await tx.instanceRank.findMany({
      where: {
        nodeId: node.id,
        claim: { not: "RELEASED" },
        Instance: { phase: { notIn: [...NOT_RUNNING] } },
      },
      select: { instanceId: true },
    });
    const fabricIds = (
      await tx.fabricMember.findMany({
        where: { userId, nodeId: node.id },
        select: { fabricId: true },
      })
    ).map((row) => row.fabricId);
    const peers = (await fabricMemberNodeIds(tx, userId, fabricIds)).filter((id) => id !== node.id);
    // `node_delete_release` releases every claim here and stops instances with a part here.
    if (agent) {
      // The online check above is a plain read: a hello can commit after it. The delete re-checks
      // the row it locks (Postgres re-evaluates the WHERE), so an agent never deletes a node
      // that came online in between.
      const deleted = await tx.node.deleteMany({
        where: { id: node.id, userId, connection: { not: "ONLINE" } },
      });
      if (deleted.count === 0)
        throw refuseAbout(
          "node_online",
          node.id,
          "This node came online: agents delete only offline nodes. Stop wsmp on it (or ask a person to delete it in the browser).",
        );
    } else {
      await tx.node.delete({ where: { id: node.id } });
    }
    await refreshFabricsHashes(tx, userId, peers);
    const instanceIds = [...new Set(ranks.map((rank) => rank.instanceId))];
    if (agent) {
      const actor = callerActor(context.auth, userId);
      await tx.auditEvent.create({
        data: {
          userId,
          actor: actor.actor,
          actorUserId: actor.actorUserId,
          agentTokenId: actor.agentTokenId,
          mcpGrantId: actor.mcpGrantId,
          action: "node.delete",
          resourceType: "node",
          resourceId: node.id,
          before: { slug: node.slug },
          after: { stoppedInstances: instanceIds, ...(agent.note ? { note: agent.note } : {}) },
        },
      });
    }
    return { instanceIds, peers };
  });
  const services = relay(context);
  const disconnect = services?.disconnect;
  await afterCommit(disconnect && (() => disconnect(nodeId, "node_deleted")));
  const definitionChanged = services?.definitionChanged;
  if (stopped.peers.length > 0)
    await afterCommit(definitionChanged && (() => definitionChanged(stopped.peers)));
  return { deleted: true as const, stoppedInstances: stopped.instanceIds };
}

function secretNamesOf(features: unknown): string[] {
  if (!features || typeof features !== "object") return [];
  const secrets = Reflect.get(features, "secrets");
  if (!Array.isArray(secrets)) return [];
  return secrets
    .map((secret: unknown) =>
      secret && typeof secret === "object" ? Reflect.get(secret, "name") : undefined,
    )
    .filter((name): name is string => typeof name === "string");
}

/** What freezes when the node goes Relay only, with agent-written parts flagged. */
async function frozenParts(
  userId: string,
  nodeId: string,
  heldDefinitions: unknown,
  metricCommands: unknown,
) {
  const held = parseHeldDefinitions(heldDefinitions);
  const versionIds = [...new Set(held.map((entry) => entry.versionId))];
  const [versions, runningRanks, lastMetricEdit] = await Promise.all([
    versionIds.length
      ? prisma.runtimeVersion.findMany({
          where: { id: { in: versionIds }, Runtime: { userId } },
          select: { id: true, runtimeId: true, editor: true, Runtime: { select: { name: true } } },
        })
      : Promise.resolve([]),
    prisma.instanceRank.findMany({
      where: {
        nodeId,
        claim: { not: "RELEASED" },
        Instance: { phase: { notIn: [...NOT_RUNNING] } },
      },
      select: { Instance: { select: { launchVersionId: true } } },
    }),
    prisma.nodeAuditEvent.findFirst({
      where: {
        userId,
        nodeId,
        OR: [
          { kind: "metric_commands_define" },
          { kind: "node_update", subject: { contains: "metricCommands" } },
        ],
        outcome: "completed",
      },
      orderBy: { createdAt: "desc" },
      select: { actor: true },
    }),
  ]);
  const running = new Set(runningRanks.map((rank) => rank.Instance.launchVersionId));
  const commands = nodeMetricCommandsSchema.safeParse(metricCommands);
  const agentWroteCommands = lastMetricEdit?.actor === "AGENT";
  return {
    runtimes: versions.map((version) => ({
      runtimeId: version.runtimeId,
      versionId: version.id,
      name: version.Runtime.name,
      agentWritten: version.editor === "AGENT",
      running: running.has(version.id),
    })),
    metricCommands: (commands.success ? commands.data : []).map((command) => ({
      name: command.name,
      agentWritten: agentWroteCommands,
    })),
  };
}
