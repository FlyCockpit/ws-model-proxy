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
import { assertMayWrite, callerActor } from "../lib/caller";
import { isUniqueViolation, notFound, refuse, refuseAbout } from "../lib/refuse";
import { runtimeSpecSchema } from "../lib/runtime-spec";
import { effectiveHardware, liveMetrics } from "../nodes/hardware";
import { nodeTrustView } from "../nodes/trust";
import { parseHeldDefinitions } from "../nodes/views";
import {
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
  const owned = new Set(row.Nodes.map((node) => node.nodeId));
  const holdLines = new Set(row.Nodes.filter((node) => node.hold).map((node) => node.nodeId));
  const running = instances.filter(
    (instance) =>
      instance.desiredState === "RUNNING" &&
      (ACTIVE_PHASES as readonly string[]).includes(instance.phase) &&
      instance.Ranks.some((rank) => rank.nodeId !== null && owned.has(rank.nodeId)),
  );
  const matched = new Set<string>();
  const items = row.Items.map((item) => {
    const allowed = item.nodeIds.length > 0 ? new Set(item.nodeIds) : owned;
    const matches = running.filter(
      (instance) =>
        instance.runtimeId === item.runtimeId &&
        instance.launchVersionId === item.versionId &&
        !matched.has(instance.id) &&
        instance.Ranks[0]?.nodeId != null &&
        allowed.has(instance.Ranks[0].nodeId) &&
        !instance.Ranks.some((rank) => rank.nodeId !== null && holdLines.has(rank.nodeId)),
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
  if (!view) throw notFound("Profile");
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
  if (!profile) throw notFound("Profile");
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
      hold: node.holdAt ? { profileId: node.holdProfileId } : null,
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
    const actor = callerActor(context.auth);
    const person = isHumanCaller(context.auth);
    const nodeIds = [...new Set(input.nodeIds)];
    if (nodeIds.length !== input.nodeIds.length)
      throw new ORPCError("BAD_REQUEST", { message: "A node is listed twice." });

    let profileId: string;
    try {
      profileId = await prisma.$transaction(async (tx) => {
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
                Nodes: { select: { nodeId: true, hold: true, holdNote: true } },
                Items: { select: { runtimeId: true, versionId: true } },
              },
            })
          : null;
        if (input.profileId && !existing) throw notFound("Profile");

        // Hold lines are people's (a hold is a deletion of capacity for everyone).
        const existingHolds = (existing?.Nodes ?? [])
          .filter((node) => node.hold)
          .map((node) => ({ nodeId: node.nodeId, note: node.holdNote ?? undefined }));
        const holds = input.holds ?? existingHolds;
        if (!person && input.holds !== undefined && !sameHolds(input.holds, existingHolds))
          throw refuse("human_only", "Only a person changes a profile's hold lines.", "FORBIDDEN");
        const holdIds = new Set(holds.map((hold) => hold.nodeId));
        if (holdIds.size !== holds.length)
          throw new ORPCError("BAD_REQUEST", { message: "A node has two hold lines." });
        for (const hold of holds)
          if (!nodeIds.includes(hold.nodeId)) {
            if (!person)
              throw refuse(
                "human_only",
                "Keep every hold line's node: only a person removes a hold line.",
                "FORBIDDEN",
              );
            throw new ORPCError("BAD_REQUEST", {
              message: "A hold line names a node the profile does not own.",
            });
          }

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
        const profile = existing
          ? await tx.profile.update({
              where: { id: existing.id },
              data: fields,
              select: { id: true },
            })
          : await tx.profile.create({ data: { ...fields, userId }, select: { id: true } });
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
    const deleted = await prisma.profile.deleteMany({ where: { id: input.profileId, userId } });
    if (deleted.count === 0) throw notFound("Profile");
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

    const actor = callerActor(context.auth);
    const now = new Date();
    const holdNotes = new Map(profile.Nodes.map((node) => [node.nodeId, node.holdNote]));
    const operation = await prisma.$transaction(async (tx) => {
      const created = await tx.runtimeOperation.create({
        data: {
          userId,
          kind: "PROFILE_APPLY",
          actor: actor.actor,
          actorUserId: userId,
          agentTokenId: actor.agentTokenId,
          profileId: profile.id,
          summary: toJsonValue(plan.preview),
          fingerprint: plan.preview.fingerprint,
        },
        select: { id: true, createdAt: true },
      });
      for (const nodeId of plan.holdNodeIds)
        await tx.node.updateMany({
          where: { id: nodeId, userId },
          data: { holdAt: now, holdNote: holdNotes.get(nodeId) ?? null, holdProfileId: profile.id },
        });
      if (plan.releaseNodeIds.length > 0)
        await tx.node.updateMany({
          where: { id: { in: plan.releaseNodeIds }, userId, holdProfileId: profile.id },
          data: { holdAt: null, holdNote: null, holdProfileId: null },
        });
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

function sameHolds(
  a: ReadonlyArray<{ nodeId: string; note?: string }>,
  b: ReadonlyArray<{ nodeId: string; note?: string }>,
): boolean {
  const key = (lines: ReadonlyArray<{ nodeId: string; note?: string }>) =>
    lines
      .map((line) => `${line.nodeId}\u0000${line.note ?? ""}`)
      .sort()
      .join("\u0001");
  return key(a) === key(b);
}

/** A plain-JSON copy for a Json column (the preview has no Dates or class instances). */
function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
