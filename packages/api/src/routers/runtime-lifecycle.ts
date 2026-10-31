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
import {
  agentBlockedNodeWithCleanup,
  currentReservations,
  OCCUPANCY_SELECT,
  placedOnNodesWhere,
} from "../lib/instance-occupancy";
import { PlacementPlanner } from "../lib/placement";
import { loadPlacementContext } from "../lib/placement-load";
import { previewFingerprint } from "../lib/preview-fingerprint";
import { notFound, refusalOf, refuse, refuseAbout } from "../lib/refuse";
import { runtimeSpecWarnings } from "../lib/runtime-spec";
import {
  markInstancesStopping,
  specIsInteractive,
  type Tx,
  writePlannedStarts,
} from "../lib/runtime-store";
import { INSTANCE_INCLUDE, instanceView, loadStepRefs, storedSpec } from "../lib/runtime-views";

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
    select: { id: true, kind: true, currentVersionId: true, origin: true },
  });
  if (!runtime) throw notFound("That runtime does not exist.");
  if (runtime.kind !== "STARTABLE")
    // Always-on: the engine runs on its own and the proxy only connects to it. Starting (or
    // restarting an instance, preview included) would mean nothing: its health is re-checked
    // automatically, so the answer says what to do instead.
    throw refuseAbout(
      "always_on_runtime",
      runtime.id,
      `Runtime ${runtime.id} is always-on: it runs outside wsmp and is never started or stopped here; it is ready when its node reports it serving. Check it now with model_test, or change its address with runtime_update.`,
      "BAD_REQUEST",
    );
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
  if (!launch)
    throw new ORPCError("BAD_REQUEST", {
      message: "This version has no launch (spec.launch) to start.",
    });

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
    // A node-origin runtime's version takes no definition slot.
    nodeOrigin: runtime.origin === "NODE",
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
      reservations: result.start.reservations,
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
        // Every node the instance occupies (`OCCUPANCY_SELECT`): its ranks (with their ports)
        // and every reservation row, a replaced run's too.
        Ranks: {
          ...OCCUPANCY_SELECT.Ranks,
          select: { ...OCCUPANCY_SELECT.Ranks.select, port: true, distPort: true },
        },
        Reservations: OCCUPANCY_SELECT.Reservations,
      },
    });
    if (!instance) throw notFound("That instance does not exist.");
    restart = { instanceId: instance.id };
    // An agent's restart reaches every node the instance holds now (the leading stop acts on the
    // old launch, its ranks and reservations, a replaced run's included, and the nodes a launch
    // that may still run names) besides the new plan's:
    // each must be at Full control (a pending lowering counts as Relay only, a deleted node as
    // not Full), as a stop's (`runtimeStop`).
    const blocked = agentRulesApply(context.auth)
      ? await agentBlockedNodeWithCleanup(db, userId, instance)
      : null;
    if (blocked) {
      refusals.push({
        reason: "trust_relay",
        subjectId: blocked.nodeId ?? instance.id,
        message: TRUST_RELAY_MESSAGE,
      });
    } else {
      // Its reservations prefer the nodes they hold now (by index), still placed by labels.
      const reservationNodeIds: Array<string | null> = [];
      // Rows read without the select (older callers' fixtures) have none.
      for (const reservation of currentReservations(instance.Reservations ?? []))
        reservationNodeIds[reservation.index] = reservation.nodeId;
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
            reservationNodeIds,
          },
        }),
      );
    }
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
      userId: true,
      Instances: { include: INSTANCE_INCLUDE, orderBy: { createdAt: "asc" } },
    },
  });
  const stepRefs = await loadStepRefs(prisma, operation.userId, operation.Instances);
  return {
    id: operation.id,
    kind: operation.kind,
    createdAt: operation.createdAt.toISOString(),
    actor: actorRefOf(operation),
    instances: operation.Instances.map((row) => instanceView(row, undefined, undefined, stepRefs)),
  };
}

function throwFirstRefusal(refusals: readonly Refusal[]): void {
  const first = refusals[0];
  if (first) throw refusalOf(first);
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
      const stopped = await markInstancesStopping(tx, userId, stopIds, operation.id, "preempted");
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
  const where =
    "instanceId" in input
      ? { id: input.instanceId, userId, desiredState: "RUNNING" as const }
      : {
          runtimeId: input.runtimeId,
          userId,
          desiredState: "RUNNING" as const,
          // On that node: a rank there, or a reservation of its current plan there.
          ...(input.nodeId ? placedOnNodesWhere([input.nodeId]) : {}),
        };
  const operationId = await stopInstancesWhere(context, userId, where);
  if (!operationId) throw notFound("Nothing of this runtime is running there.");
  return operationView(operationId);
});

/**
 * Every running instance placed on `nodeId` (a rank there, or a reservation of its plan there),
 * stopped as `runtimes.stop` stops them: one recorded STOP operation, dispatched. A forced wsmp
 * update uses it on a node whose instances do not survive the agent's restart. Null when
 * nothing runs there, or when `allowed` says the stop's reason no longer holds: it runs in the
 * stop's transaction after its fences (it may take row locks there), before anything is
 * recorded and again after the last write, before the commit; false either time rolls the whole
 * stop back, so nothing is recorded or dispatched.
 */
export async function stopInstancesOnNode(
  context: SignedInContext,
  userId: string,
  nodeId: string,
  allowed?: (tx: Prisma.TransactionClient) => Promise<boolean>,
): Promise<string | null> {
  return stopInstancesWhere(
    context,
    userId,
    {
      userId,
      desiredState: "RUNNING" as const,
      ...placedOnNodesWhere([nodeId]),
    },
    allowed,
  );
}

/** The STOP operation of `runtimes.stop`, for the running instances `where` selects. */
async function stopInstancesWhere(
  context: SignedInContext,
  userId: string,
  where: Prisma.RuntimeInstanceWhereInput,
  allowed?: (tx: Prisma.TransactionClient) => Promise<boolean>,
): Promise<string | null> {
  const actor = callerActor(context.auth, userId);
  // Read, check and write under the owner fence, so a trust lowering (an owner write) cannot
  // land in between and let an agent's stop through; then the capacity fences of the stops.
  let ids: string[] = [];
  const operationId: string | null = await graphWrite(
    [userId],
    async (tx) => {
      // The stop's reason, decided after the fences and the instance read (both waits), right
      // before the writes.
      if (allowed && !(await allowed(tx))) throw new NotAllowed();
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
      await markInstancesStopping(tx, userId, ids, operation.id, "stop_requested");
      // And once more before the commit: whatever changed during these writes rolls them back.
      if (allowed && !(await allowed(tx))) throw new NotAllowed();
      return operation.id;
    },
    async (tx) => {
      const instances = await tx.runtimeInstance.findMany({
        where,
        select: { id: true, ...OCCUPANCY_SELECT },
        orderBy: { id: "asc" },
      });
      if (instances.length === 0) throw new NothingRunning();
      // Every node the stop reaches: the ranks', the reservations' that still hold, and those a
      // launch that may still run names.
      if (agentRulesApply(context.auth))
        for (const instance of instances) {
          const blocked = await agentBlockedNodeWithCleanup(tx, userId, instance);
          if (blocked)
            throw refuseAbout("trust_relay", blocked.nodeId ?? instance.id, TRUST_RELAY_MESSAGE);
        }
      ids = instances.map((instance) => instance.id);
      return instanceCapacityFences(ids);
    },
  ).catch((error: unknown) => {
    // Rolled back whole: nothing was recorded.
    if (error instanceof NothingRunning || error instanceof NotAllowed) return null;
    throw error;
  });
  if (!operationId) return null;
  // The STOP's authorization point is its commit (`allowed` ran inside the transaction, last
  // right before the commit). A committed STOP is always dispatched, here, after the commit; it is
  // not checked again or called back, whatever changes after it (as a sent update is not).
  await context.services?.dispatchRuntimeOperation?.({ userId, operationId });
  return operationId;
}

class NothingRunning extends Error {}

/** `allowed` said no: the stop's reason no longer holds. */
class NotAllowed extends Error {}
