/**
 * `runtimes.start` / `runtimes.stop`: placement preview, the people-echo-the-fingerprint rule
 * (D13) and the agent trust rule (agents act only on Full-control nodes, `trust_relay`).
 *
 * Placement is the planner's (`lib/placement.ts`): memory and GPU accounting, ports, labels,
 * holds, one fabric per multi-node instance, and preemption (`stops`, reason `preempted`).
 * The applied start writes the stops (`markInstancesStopping`) and the new claims in the same
 * transaction, under the owner fence and the capacity fences of every instance it changes.
 */

import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/server";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import type { z } from "zod";
import { contractProcedure, type SignedInContext } from "../contract-procedure";
import { agentRulesApply, isHumanCaller } from "../contracts/auth-context";
import type { RefusalReason } from "../contracts/refusals";
import {
  runtimesContract as c,
  type previewWarningSchema,
  type startPreviewSchema,
} from "../contracts/runtimes";
import { callerActor } from "../lib/caller-actor";
import { canonicalJson } from "../lib/canonical-json";
import { graphWrite, instanceCapacityFences } from "../lib/graph-write";
import { PlacementPlanner } from "../lib/placement";
import { loadPlacementContext } from "../lib/placement-load";
import { previewFingerprint } from "../lib/preview-fingerprint";
import { notFound, refuse, refuseAbout } from "../lib/refuse";
import { runtimeSpecWarnings } from "../lib/runtime-spec";
import {
  effectiveTrust,
  markInstancesStopping,
  specIsInteractive,
  type Tx,
  writePlannedStarts,
} from "../lib/runtime-store";
import { INSTANCE_INCLUDE, instanceView, storedSpec } from "../lib/runtime-views";

type StartInput = z.infer<typeof c.start.input>;
type StartPreview = z.infer<typeof startPreviewSchema>;
type Warning = z.infer<typeof previewWarningSchema>;
type Refusal = { reason: RefusalReason; subjectId: string | null; message: string };

const TRUST_RELAY_MESSAGE =
  "This node is Relay only: agents cannot start or stop runtimes there. A person can do it in the browser.";

type Computed = {
  preview: StartPreview;
  runtimeId: string;
  versionId: string;
  restart: { instanceId: string } | null;
  /** Per start (same order): instances this operation stops that the new ranks wait for. */
  blockedBy: string[][];
};

/**
 * The start preview: the placement planner (`lib/placement.ts`) decides nodes, ports, the
 * fabric and what is preempted; this adds the spec's warnings and the fingerprint.
 */
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

  const planner = new PlacementPlanner(await loadPlacementContext(db, { userId, agent }));
  const refusals: Refusal[] = [];
  const warnings: Warning[] = [];
  const starts: StartPreview["starts"] = [];
  const blockedBy: string[][] = [];
  const base = {
    runtimeId: runtime.id,
    versionId: version.id,
    launch,
    // A person may start any version on a Relay-only node (the node runs its frozen copy).
    checkFrozen: false,
    // "May stop others to make room": people see the stops in the preview they confirm.
    preempt: true,
  };
  const record = (instanceId: string | null, result: ReturnType<PlacementPlanner["place"]>) => {
    if (!result.ok) {
      refusals.push(result.refusal);
      return false;
    }
    starts.push({
      runtimeId: runtime.id,
      versionId: version.id,
      instanceId,
      placements: result.start.placements,
      fabric: result.start.fabric,
      distPort: result.start.distPort,
    });
    blockedBy.push(result.start.blockedBy);
    warnings.push(...result.warnings);
    return true;
  };

  let restart: Computed["restart"] = null;
  if (input.instanceId) {
    const instance = await db.runtimeInstance.findFirst({
      where: { id: input.instanceId, runtimeId: runtime.id, userId },
      select: {
        id: true,
        Ranks: {
          select: { nodeId: true, port: true, distPort: true },
          orderBy: { rank: "asc" },
        },
      },
    });
    if (!instance) throw notFound("That instance does not exist.");
    restart = { instanceId: instance.id };
    // The instance keeps its own nodes and ports; its own claims do not block it.
    record(
      instance.id,
      planner.place({
        ...base,
        nodeIds: instance.Ranks.map((rank) => rank.nodeId ?? ""),
        restart: {
          instanceId: instance.id,
          ports: instance.Ranks.map((rank) => rank.port),
          distPort: instance.Ranks[0]?.distPort ?? null,
        },
      }),
    );
  } else if (input.nodeIds) {
    record(null, planner.place({ ...base, nodeIds: input.nodeIds }));
  } else {
    const count = input.count ?? 1;
    for (let index = 0; index < count; index++) if (!record(null, planner.place(base))) break;
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

  const body = {
    starts,
    stops: refusals.length > 0 ? [] : planner.stops,
    kept: [],
    holds: [],
    warnings: dedupeWarnings(warnings),
    refusals,
  };
  return {
    preview: { fingerprint: previewFingerprint(body), ...body },
    runtimeId: runtime.id,
    versionId: version.id,
    restart,
    blockedBy,
  };
}

function dedupeWarnings(warnings: readonly Warning[]): Warning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = `${warning.code}|${warning.nodeId}|${warning.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  if (first) throw refuseAbout(first.reason, first.subjectId, first.message);
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
    throw refuse("preview_required", "Preview the start first, then confirm it.");
  const actor = callerActor(context.auth, userId);
  // The plan is computed under the owner fence (so no other graph write of this user lands
  // between plan and write), then the capacity fences of every instance it changes are taken:
  // the restarted one and every preempted one.
  let planned: Computed | null = null;
  const operationId = await graphWrite(
    [userId],
    async (tx) => {
      const computed = planned;
      if (!computed) throw new Error("The start plan runs before its write.");
      if (input.fingerprint && input.fingerprint !== computed.preview.fingerprint)
        throw refuse("preview_stale", "Things changed since the preview. Preview again.");
      throwFirstRefusal(computed.preview.refusals);
      const operation = await tx.runtimeOperation.create({
        data: {
          userId,
          kind: computed.restart ? "RESTART" : "START",
          actor: actor.actor,
          actorUserId: actor.actorUserId,
          agentTokenId: actor.agentTokenId,
          mcpGrantId: actor.mcpGrantId,
          summary: computed.preview as unknown as Prisma.InputJsonValue,
          fingerprint: computed.preview.fingerprint,
        },
        select: { id: true },
      });
      const stopIds = computed.preview.stops.map((stop) => stop.instanceId);
      const stopped = await markInstancesStopping(tx, stopIds, operation.id, "preempted");
      if (stopped !== stopIds.length)
        throw refuse("preview_stale", "An instance this start stops changed. Preview again.");
      await writePlannedStarts(tx, {
        userId,
        operationId: operation.id,
        startedBy: actor.actor,
        starts: computed.preview.starts,
        blockedBy: computed.blockedBy,
      });
      return operation.id;
    },
    async (tx) => {
      planned = await computeStart(tx, context, input);
      return instanceCapacityFences(
        [
          ...(planned.restart ? [planned.restart.instanceId] : []),
          ...planned.preview.stops.map((stop) => stop.instanceId),
        ].sort(),
      );
    },
  );
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
  // Read, check and write under the owner fence, so a trust lowering (an owner write) cannot
  // land in between and let an agent's stop through; then the capacity fences of the stops.
  let ids: string[] = [];
  const operationId = await graphWrite(
    [userId],
    async (tx) => {
      const operation = await tx.runtimeOperation.create({
        data: {
          userId,
          kind: "STOP",
          actor: actor.actor,
          actorUserId: actor.actorUserId,
          agentTokenId: actor.agentTokenId,
          mcpGrantId: actor.mcpGrantId,
          summary: { stops: ids },
          fingerprint: createHash("sha256")
            .update(canonicalJson({ stops: ids }), "utf8")
            .digest("hex"),
        },
        select: { id: true },
      });
      await markInstancesStopping(tx, ids, operation.id, "stop_requested");
      return operation.id;
    },
    async (tx) => {
      const instances = await tx.runtimeInstance.findMany({
        where,
        select: {
          id: true,
          Ranks: {
            select: { Node: { select: { id: true, trust: true, trustLowerRequestedAt: true } } },
          },
        },
        orderBy: { id: "asc" },
      });
      if (instances.length === 0) throw notFound("Nothing of this runtime is running there.");
      if (agentRulesApply(context.auth))
        for (const instance of instances)
          for (const rank of instance.Ranks)
            if (!rank.Node || effectiveTrust(rank.Node) !== "FULL")
              throw refuseAbout("trust_relay", rank.Node?.id ?? instance.id, TRUST_RELAY_MESSAGE);
      ids = instances.map((instance) => instance.id);
      return instanceCapacityFences(ids);
    },
  );
  await context.services?.dispatchRuntimeOperation?.({ userId, operationId });
  return operationView(operationId);
});
