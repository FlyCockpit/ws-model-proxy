/**
 * Profiles (lane B): a named desired state over owned nodes. Apply is the one-click switch:
 * people confirm the exact preview (fingerprint), agents may skip it (D13).
 */
import { ORPCError } from "@orpc/server";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import type { z } from "zod";
import type { Context } from "../context";
import { contractProcedure } from "../contract-procedure";
import { agentRulesApply, isHumanCaller } from "../contracts/auth-context";
import { profilesContract as c, type profileViewSchema } from "../contracts/profiles";
import { assertMayWrite, callerActor } from "../lib/caller-actor";
import { graphDelete, graphWrite } from "../lib/graph-write";
import { planProfileHolds } from "../lib/profile-holds";
import { planProfileSave } from "../lib/profile-save";
import { isUniqueViolation, notFound, refuse, refuseAbout } from "../lib/refuse";
import { runtimeSpecSchema } from "../lib/runtime-spec";
import { effectiveHardware, liveMetrics } from "../nodes/hardware";
import { nodeTrustView } from "../nodes/trust";
import { parseHeldDefinitions } from "../nodes/views";
import {
  instanceServesItem,
  type PlanInstance,
  type PlanItem,
  type PlanNode,
  type PlanVersion,
  profilePlan,
} from "./plan";

type ProfileView = z.infer<typeof profileViewSchema>;

const profileSelect = {
  id: true,
  slug: true,
  name: true,
  description: true,
  editor: true,
  editorUserId: true,
  updatedAt: true,
  Nodes: { select: { nodeId: true, hold: true, holdNote: true } },
  Items: {
    orderBy: { position: "asc" },
    select: {
      id: true,
      position: true,
      runtimeId: true,
      versionId: true,
      count: true,
      nodeIds: true,
      Runtime: { select: { slug: true, currentVersionId: true } },
      Version: { select: { version: true } },
    },
  },
  Operations: {
    where: { kind: "PROFILE_APPLY" },
    orderBy: { createdAt: "desc" },
    take: 1,
    select: { id: true, createdAt: true, actor: true, actorUserId: true, agentTokenId: true },
  },
} as const;

type ProfileRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  editor: "USER" | "AGENT" | "SYSTEM";
  editorUserId: string;
  updatedAt: Date;
  Nodes: Array<{ nodeId: string; hold: boolean; holdNote: string | null }>;
  Items: Array<{
    id: string;
    position: number;
    runtimeId: string;
    versionId: string;
    count: number;
    nodeIds: string[];
    Runtime: { slug: string; currentVersionId: string | null };
    Version: { version: number };
  }>;
  Operations: Array<{
    id: string;
    createdAt: Date;
    actor: "USER" | "AGENT" | "SYSTEM";
    actorUserId: string;
    agentTokenId: string | null;
  }>;
};

const ACTIVE_PHASES = ["STARTING", "READY", "UNHEALTHY", "UNAVAILABLE"] as const;

/** STARTABLE instances that should run, with a rank on one of these nodes. */
async function runningInstancesOn(userId: string, nodeIds: readonly string[]) {
  if (nodeIds.length === 0) return [];
  return prisma.runtimeInstance.findMany({
    where: {
      userId,
      Runtime: { kind: "STARTABLE" },
      Ranks: { some: { nodeId: { in: [...nodeIds] }, claim: { not: "RELEASED" } } },
    },
    select: {
      id: true,
      runtimeId: true,
      launchVersionId: true,
      desiredState: true,
      phase: true,
      Ranks: { orderBy: { rank: "asc" }, select: { nodeId: true, claim: true } },
    },
  });
}

type RunningInstance = Awaited<ReturnType<typeof runningInstancesOn>>[number];

export function toProfileView(row: ProfileRow, instances: readonly RunningInstance[]): ProfileView {
  const ownedIds = row.Nodes.map((node) => node.nodeId);
  const owned = new Set(ownedIds);
  const holdLines = new Set(row.Nodes.filter((node) => node.hold).map((node) => node.nodeId));
  const running = instances.filter(
    (instance) =>
      instance.desiredState === "RUNNING" &&
      (ACTIVE_PHASES as readonly string[]).includes(instance.phase) &&
      instance.Ranks.some((rank) => rank.nodeId !== null && owned.has(rank.nodeId)),
  );
  const matched = new Set<string>();
  const items = row.Items.map((item) => {
    const matches = running.filter(
      (instance) =>
        !matched.has(instance.id) &&
        instanceServesItem(
          {
            runtimeId: instance.runtimeId,
            launchVersionId: instance.launchVersionId,
            rankNodeIds: instance.Ranks.flatMap((rank) => (rank.nodeId ? [rank.nodeId] : [])),
          },
          item,
          ownedIds,
          holdLines,
        ),
    );
    const counted = matches.slice(0, item.count);
    for (const instance of counted) matched.add(instance.id);
    return {
      id: item.id,
      position: item.position,
      runtimeId: item.runtimeId,
      runtimeSlug: item.Runtime.slug,
      versionId: item.versionId,
      versionNumber: item.Version.version,
      pinOutdated:
        item.Runtime.currentVersionId !== null && item.Runtime.currentVersionId !== item.versionId,
      count: item.count,
      nodeIds: item.nodeIds,
      runningNow: counted.length,
    };
  });
  const satisfied =
    items.every((item) => item.runningNow >= item.count) &&
    running.every((instance) => matched.has(instance.id));
  const last = row.Operations[0];
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    editor: { actor: row.editor, userId: row.editorUserId, agentTokenId: null, label: null },
    updatedAt: row.updatedAt.toISOString(),
    nodeIds: row.Nodes.map((node) => node.nodeId),
    holds: row.Nodes.filter((node) => node.hold).map((node) => ({
      nodeId: node.nodeId,
      note: node.holdNote,
    })),
    items,
    satisfied,
    lastApply: last
      ? {
          operationId: last.id,
          at: last.createdAt.toISOString(),
          actor: {
            actor: last.actor,
            userId: last.actorUserId,
            agentTokenId: last.agentTokenId,
            label: null,
          },
        }
      : null,
  };
}

async function loadProfileViews(userId: string, profileId?: string): Promise<ProfileView[]> {
  const rows = await prisma.profile.findMany({
    where: { userId, ...(profileId ? { id: profileId } : {}) },
    orderBy: { name: "asc" },
    select: profileSelect,
  });
  const nodeIds = [...new Set(rows.flatMap((row) => row.Nodes.map((node) => node.nodeId)))];
  const instances = await runningInstancesOn(userId, nodeIds);
  return rows.map((row) => toProfileView(row, instances));
}

async function loadProfileView(userId: string, profileId: string): Promise<ProfileView> {
  const [view] = await loadProfileViews(userId, profileId);
  if (!view) throw notFound("That profile does not exist.");
  return view;
}

/** Everything `profilePlan` needs, read for one profile. */
async function loadPlanInput(context: Context, userId: string, profileId: string) {
  const profile = await prisma.profile.findFirst({
    where: { id: profileId, userId },
    select: {
      id: true,
      Nodes: { select: { nodeId: true, hold: true, holdNote: true } },
      Items: {
        // Deterministic: which item a running instance counts toward follows this order.
        orderBy: { position: "asc" },
        select: {
          id: true,
          position: true,
          runtimeId: true,
          versionId: true,
          count: true,
          nodeIds: true,
        },
      },
    },
  });
  if (!profile) throw notFound("That profile does not exist.");
  const ownedIds = profile.Nodes.map((node) => node.nodeId);
  const now = new Date();
  const [nodes, versions, instances, claims, fabrics] = await Promise.all([
    prisma.node.findMany({
      where: { userId, id: { in: ownedIds } },
      select: {
        id: true,
        slug: true,
        connection: true,
        trust: true,
        trustChangedAt: true,
        trustLowerRequestedAt: true,
        labels: true,
        holdAt: true,
        holdProfileId: true,
        portStart: true,
        portEnd: true,
        heldDefinitions: true,
        declaredResources: true,
        nodeInfo: true,
        nodeMetrics: true,
        nodeMetricsAt: true,
      },
    }),
    prisma.runtimeVersion.findMany({
      where: {
        id: { in: profile.Items.map((item) => item.versionId) },
        Runtime: { userId },
      },
      select: {
        id: true,
        runtimeId: true,
        spec: true,
        Runtime: { select: { slug: true, currentVersionId: true } },
      },
    }),
    runningInstancesOn(userId, ownedIds),
    prisma.instanceRank.findMany({
      where: { nodeId: { in: ownedIds }, claim: { not: "RELEASED" }, Instance: { userId } },
      select: { instanceId: true, nodeId: true, port: true, distPort: true, resources: true },
    }),
    prisma.fabric.findMany({
      where: { userId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, Members: { select: { nodeId: true } } },
    }),
  ]);

  const planNodes = new Map<string, PlanNode>();
  for (const node of nodes) {
    const hardware = effectiveHardware({
      declaredResources: node.declaredResources,
      nodeInfo: node.nodeInfo,
      nodeMetrics: node.nodeMetrics,
      nodeMetricsAt: node.nodeMetricsAt,
      heldClaims: [],
      now,
    });
    planNodes.set(node.id, {
      id: node.id,
      slug: node.slug,
      online: node.connection === "ONLINE",
      trust: nodeTrustView(node).effective,
      labels: node.labels,
      hold: { holdAt: node.holdAt, holdProfileId: node.holdProfileId },
      portRange: [node.portStart, node.portEnd],
      heldVersionIds: new Set(parseHeldDefinitions(node.heldDefinitions).map((d) => d.versionId)),
      usableMemoryGb: hardware.usableMemoryGb,
      usableGpuGb: hardware.gpus.reduce(
        (sum, gpu) => sum + Math.max(0, gpu.vramGb - gpu.reservedVramGb),
        0,
      ),
      gpuCount: hardware.gpus.length,
      liveFreeMemoryGb: liveMetrics(node.nodeMetrics, node.nodeMetricsAt, now).freeMemoryGb,
    });
  }
  const planVersions = new Map<string, PlanVersion>(
    versions.map((version) => {
      const spec = runtimeSpecSchema.safeParse(version.spec);
      return [
        version.id,
        {
          id: version.id,
          runtimeId: version.runtimeId,
          runtimeSlug: version.Runtime.slug,
          currentVersionId: version.Runtime.currentVersionId,
          spec: spec.success ? spec.data : null,
        },
      ];
    }),
  );
  const planInstances: PlanInstance[] = instances.map((instance) => ({
    id: instance.id,
    runtimeId: instance.runtimeId,
    launchVersionId: instance.launchVersionId,
    desiredRunning: instance.desiredState === "RUNNING",
    rankNodeIds: instance.Ranks.flatMap((rank) => (rank.nodeId ? [rank.nodeId] : [])),
  }));
  const items: PlanItem[] = profile.Items;
  return {
    profile,
    input: {
      profileId: profile.id,
      owned: profile.Nodes,
      nodes: planNodes,
      items,
      versions: planVersions,
      instances: planInstances,
      claims: claims.flatMap((claim) => (claim.nodeId ? [{ ...claim, nodeId: claim.nodeId }] : [])),
      fabrics: fabrics.map((fabric) => ({
        id: fabric.id,
        name: fabric.name,
        nodeIds: fabric.Members.map((member) => member.nodeId),
      })),
      agentRules: agentRulesApply(context.auth),
    },
  };
}

export const profileProcedures = {
  list: contractProcedure(c.list).handler(async ({ context }) => ({
    profiles: await loadProfileViews(context.session.user.id),
  })),

  get: contractProcedure(c.get).handler(async ({ context, input }) =>
    loadProfileView(context.session.user.id, input.profileId),
  ),

  save: contractProcedure(c.save).handler(async ({ context, input }) => {
    assertMayWrite(context.auth);
    const userId = context.session.user.id;
    const actor = callerActor(context.auth, userId);
    const person = isHumanCaller(context.auth);
    const nodeIds = [...new Set(input.nodeIds)];
    if (nodeIds.length !== input.nodeIds.length)
      throw new ORPCError("BAD_REQUEST", { message: "A node is listed twice." });

    let profileId: string;
    try {
      profileId = await graphWrite([userId], async (tx) => {
        const owned = await tx.node.findMany({
          where: { userId, id: { in: nodeIds } },
          select: { id: true },
        });
        if (owned.length !== nodeIds.length) throw notFound("Node");

        const existing = input.profileId
          ? await tx.profile.findFirst({
              where: { id: input.profileId, userId },
              select: {
                id: true,
                updatedAt: true,
                Nodes: { select: { nodeId: true, hold: true, holdNote: true } },
                Items: { select: { runtimeId: true, versionId: true } },
              },
            })
          : null;
        if (input.profileId && !existing) throw notFound("That profile does not exist.");

        // Hold lines are people's: lib/profile-save.ts is the one rule (security).
        const savePlan = planProfileSave({
          caller: person ? "person" : "agent",
          before: (existing?.Nodes ?? [])
            .filter((node) => node.hold)
            .map((node) => ({ nodeId: node.nodeId, note: node.holdNote })),
          after: {
            nodeIds,
            holds: input.holds?.map((hold) => ({ nodeId: hold.nodeId, note: hold.note ?? null })),
          },
        });
        if (!savePlan.ok) {
          if (savePlan.reason === "human_only")
            throw refuse(
              "human_only",
              "Only a person adds, changes or removes a profile's hold lines, or drops a held node.",
              "FORBIDDEN",
            );
          throw new ORPCError("BAD_REQUEST", {
            message:
              savePlan.reason === "duplicate_hold"
                ? "A node has two hold lines."
                : "A hold line names a node the profile does not own.",
          });
        }
        const holds = savePlan.holds;

        // Items: runtimes are the caller's STARTABLE runtimes; pins stay unless asked.
        const runtimeIds = [...new Set(input.items.map((item) => item.runtimeId))];
        const runtimes = await tx.runtime.findMany({
          where: { userId, id: { in: runtimeIds } },
          select: { id: true, kind: true, currentVersionId: true },
        });
        const runtimeById = new Map(runtimes.map((runtime) => [runtime.id, runtime]));
        const explicitVersions = input.items.flatMap((item) =>
          item.versionId ? [item.versionId] : [],
        );
        const versionRows = explicitVersions.length
          ? await tx.runtimeVersion.findMany({
              where: { id: { in: explicitVersions }, Runtime: { userId } },
              select: { id: true, runtimeId: true },
            })
          : [];
        const versionRuntime = new Map(versionRows.map((row) => [row.id, row.runtimeId]));
        const previousPins = [...(existing?.Items ?? [])];
        const items = input.items.map((item, position) => {
          const runtime = runtimeById.get(item.runtimeId);
          if (!runtime) throw notFound("Runtime");
          if (runtime.kind !== "STARTABLE")
            throw new ORPCError("BAD_REQUEST", {
              message: "A profile pins startable runtimes only.",
            });
          if (input.updatePins && item.versionId)
            throw new ORPCError("BAD_REQUEST", {
              message: "Give versionId or updatePins, not both.",
            });
          let versionId = item.versionId;
          if (versionId && versionRuntime.get(versionId) !== runtime.id)
            throw notFound("Runtime version");
          if (!versionId) {
            const index = previousPins.findIndex((pin) => pin.runtimeId === runtime.id);
            if (index >= 0) {
              versionId = previousPins[index]?.versionId;
              previousPins.splice(index, 1);
            }
          }
          if (input.updatePins || !versionId) versionId = runtime.currentVersionId ?? undefined;
          if (!versionId)
            throw new ORPCError("BAD_REQUEST", { message: "The runtime has no version yet." });
          const itemNodes = [...new Set(item.nodeIds ?? [])];
          if (!itemNodes.every((id) => nodeIds.includes(id)))
            throw new ORPCError("BAD_REQUEST", {
              message: "An item names a node the profile does not own.",
            });
          return {
            position,
            runtimeId: runtime.id,
            versionId,
            count: item.count,
            nodeIds: itemNodes,
          };
        });

        const fields = {
          slug: input.slug,
          name: input.name,
          description: input.description ?? null,
          editor: actor.actor,
          editorUserId: userId,
        };
        let profile: { id: string };
        if (existing) {
          // Optimistic: a save that read an older profile (hold lines included) loses.
          const updated = await tx.profile.updateMany({
            where: { id: existing.id, userId, updatedAt: existing.updatedAt },
            data: fields,
          });
          if (updated.count === 0)
            throw new ORPCError("CONFLICT", {
              message: "The profile changed meanwhile. Load it again and retry.",
            });
          profile = { id: existing.id };
        } else {
          profile = await tx.profile.create({ data: { ...fields, userId }, select: { id: true } });
        }
        await tx.profileNode.deleteMany({ where: { profileId: profile.id } });
        await tx.profileNode.createMany({
          data: nodeIds.map((nodeId) => {
            const hold = holds.find((line) => line.nodeId === nodeId);
            return {
              profileId: profile.id,
              nodeId,
              hold: !!hold,
              holdNote: hold?.note ?? null,
            };
          }),
        });
        // A node a person drops from the profile keeps no hold this profile set (no apply
        // could clear it). An agent's save never releases a hold (it stays for a person).
        if (person)
          await tx.node.updateMany({
            where: { userId, holdProfileId: profile.id, id: { notIn: nodeIds } },
            data: { holdAt: null, holdNote: null, holdProfileId: null },
          });
        await tx.profileItem.deleteMany({ where: { profileId: profile.id } });
        if (items.length > 0)
          await tx.profileItem.createMany({
            data: items.map((item) => ({ ...item, profileId: profile.id })),
          });
        return profile.id;
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw refuse("slug_taken", "You already have a profile with that slug.");
      throw error;
    }
    return loadProfileView(userId, profileId);
  }),

  delete: contractProcedure(c.delete).handler(async ({ context, input }) => {
    assertMayWrite(context.auth);
    const userId = context.session.user.id;
    await graphDelete({ userId, profileIds: [input.profileId] }, async (tx) => {
      await lockProfileRows(tx, userId, input.profileId, []);
      const profile = await tx.profile.findFirst({
        where: { id: input.profileId, userId },
        select: { id: true, Nodes: { where: { hold: true }, select: { nodeId: true } } },
      });
      if (!profile) throw notFound("That profile does not exist.");
      if (agentRulesApply(context.auth)) {
        // Deleting drops hold lines and releases the holds the profile set: people only.
        const holding = await tx.node.count({ where: { userId, holdProfileId: profile.id } });
        if (profile.Nodes.length > 0 || holding > 0)
          throw refuse(
            "human_only",
            "This profile has hold lines; only a person deletes it.",
            "FORBIDDEN",
          );
      }
      // Its holds stay: the FK sets holdProfileId null, so they become a person's holds
      // (docs/contracts/0.4.0.md), released only by a person.
      await tx.profile.deleteMany({ where: { id: profile.id, userId } });
    });
    return { ok: true as const };
  }),

  apply: contractProcedure(c.apply).handler(async ({ context, input }) => {
    if (!input.preview) assertMayWrite(context.auth);
    const userId = context.session.user.id;
    const { profile, input: planInput } = await loadPlanInput(context, userId, input.profileId);
    const plan = profilePlan(planInput);
    if (input.preview) return { mode: "preview" as const, preview: plan.preview };

    // D13: a person applies exactly the preview they confirmed; agents may omit it.
    if (isHumanCaller(context.auth) && input.fingerprint === undefined)
      throw refuse("preview_required", "Preview the apply and confirm it.");
    if (input.fingerprint !== undefined && input.fingerprint !== plan.preview.fingerprint)
      throw refuse("preview_stale", "Something changed since the preview. Preview again.");
    const [first] = plan.preview.refusals;
    if (first)
      throw first.subjectId
        ? refuseAbout(first.reason, first.subjectId, first.message)
        : refuse(first.reason, first.message);

    const actor = callerActor(context.auth, userId);
    const now = new Date();
    const operation = await graphWrite([userId], async (tx) => {
      const created = await tx.runtimeOperation.create({
        data: {
          userId,
          kind: "PROFILE_APPLY",
          actor: actor.actor,
          actorUserId: userId,
          agentTokenId: actor.agentTokenId,
          mcpGrantId: actor.mcpGrantId,
          profileId: profile.id,
          summary: toJsonValue(plan.preview),
          fingerprint: plan.preview.fingerprint,
        },
        select: { id: true, createdAt: true },
      });
      // Holds are planned again on the rows as they are now (planProfileHolds). A hold set
      // since the plan refuses an agent (node_held); any other change refuses the apply as
      // stale (preview_stale), for agents too. Every hold write must land as planned.
      await lockProfileRows(
        tx,
        userId,
        profile.id,
        planInput.owned.map((line) => line.nodeId),
      );
      const lines = await tx.profileNode.findMany({
        where: { profileId: profile.id },
        select: { nodeId: true, hold: true, holdNote: true },
      });
      const lineKey = (line: { nodeId: string; hold: boolean; holdNote: string | null }) =>
        `${line.nodeId}\u0000${line.hold}\u0000${line.holdNote ?? ""}`;
      if (!sameIds(lines.map(lineKey), planInput.owned.map(lineKey)))
        throw refuse("preview_stale", "The profile changed since the preview. Preview again.");
      const current = await tx.node.findMany({
        where: { userId, id: { in: planInput.owned.map((line) => line.nodeId) } },
        select: { id: true, holdAt: true, holdProfileId: true },
      });
      const holds = planProfileHolds({
        profileId: profile.id,
        caller: planInput.agentRules ? "agent" : "person",
        nodes: planInput.owned,
        current: new Map(current.map((node) => [node.id, node] as const)),
      });
      if (!holds.ok)
        throw refuseAbout(
          "node_held",
          holds.nodeIds[0] ?? profile.id,
          "A person or another profile holds a node this profile owns; agents cannot release it.",
        );
      if (
        !sameIds(
          holds.hold.map((line) => line.nodeId),
          plan.holdNodeIds,
        ) ||
        !sameIds(holds.release, plan.releaseNodeIds)
      )
        throw refuse("preview_stale", "A node's hold changed since the preview. Preview again.");
      const raced = (nodeId: string) =>
        planInput.agentRules
          ? refuseAbout(
              "node_held",
              nodeId,
              "A node's hold changed meanwhile; agents cannot apply here.",
            )
          : refuse("preview_stale", "A node's hold changed since the preview. Preview again.");
      for (const line of holds.hold) {
        const written = await tx.node.updateMany({
          where: { id: line.nodeId, userId, OR: [{ holdAt: null }, { holdProfileId: profile.id }] },
          data: { holdAt: now, holdNote: line.note, holdProfileId: profile.id },
        });
        if (written.count !== 1) throw raced(line.nodeId);
      }
      for (const nodeId of holds.release) {
        const was = current.find((node) => node.id === nodeId);
        const released = await tx.node.updateMany({
          // Only the hold that was read: a newer one (set meanwhile) stays.
          where: {
            id: nodeId,
            userId,
            holdAt: { not: null },
            holdProfileId: was?.holdProfileId ?? null,
          },
          data: { holdAt: null, holdNote: null, holdProfileId: null },
        });
        if (released.count !== 1) throw raced(nodeId);
      }
      return created;
    });
    const profileApplied = context.services?.nodes?.profileApplied;
    if (profileApplied) {
      try {
        await profileApplied(operation.id);
      } catch {
        // The operation is recorded; the lifecycle reconciler picks it up.
      }
    }
    return {
      mode: "applied" as const,
      operation: {
        id: operation.id,
        kind: "PROFILE_APPLY" as const,
        createdAt: operation.createdAt.toISOString(),
        actor: {
          actor: actor.actor,
          userId,
          agentTokenId: actor.agentTokenId,
          label: actor.actor === "USER" ? context.session.user.name : null,
        },
        instances: [],
      },
    };
  }),
};

/** A plain-JSON copy for a Json column (the preview has no Dates or class instances). */
function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");
}

/**
 * Lock the profile row and its owned node rows (sorted, one fixed order) for the rest of the
 * transaction, so a save, a hold or a release cannot change what this transaction checked
 * before it commits. Rows of another user are not touched (the filter names the owner).
 */
async function lockProfileRows(
  tx: Prisma.TransactionClient,
  userId: string,
  profileId: string,
  nodeIds: readonly string[],
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM profile WHERE id = ${profileId} AND "userId" = ${userId} FOR UPDATE`;
  for (const nodeId of [...new Set(nodeIds)].sort())
    await tx.$queryRaw`SELECT id FROM node WHERE id = ${nodeId} AND "userId" = ${userId} FOR UPDATE`;
}
