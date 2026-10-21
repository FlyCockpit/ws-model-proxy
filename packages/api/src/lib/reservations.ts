/**
 * Reservations (`launch.reservations`, `InstanceReservation`): memory a single-node instance
 * holds on other nodes while it runs. A reservation has no claim state of its own: it holds
 * exactly while one of its instance's ranks holds its claim. So every path that releases a
 * rank's claim (a proven stop, a crash, a failed start, a person's release without proof, a
 * deleted node) releases the reservations with it, and every retake (automatic restart,
 * restart) retakes them; nothing writes a reservation's claim. Nothing is ever dispatched to a
 * reservation's node: dispatch, crash detection, stop proofs and held-unknown probes read ranks
 * only.
 *
 * A restart that places reservations elsewhere (or shrinks or removes them) while the old run
 * may still be running keeps the old rows as superseded (`supersededGeneration`): they hold
 * (with the rank) until a START of the new run is claimed, which happens only after the new
 * run's leading STOP proved the old run stopped. Readers that count memory read every row;
 * readers that describe the current plan (the watch for offline nodes, the instance view,
 * restart preferences) read `CURRENT_RESERVATION_WHERE` rows only.
 */
import type { Prisma } from "@ws-model-proxy/db";
import { canonicalJson } from "./canonical-json";
import { clearInstanceReleaseRequests } from "./claim-release";
import { beginRun, RUN_START_PHASES } from "./instance-run";
import { resourceNeeds } from "./placement";
import { launchReservations, runtimeSpecSchema } from "./runtime-spec";

export type ClaimStateValue = "HELD" | "HELD_UNKNOWN" | "RELEASED";

/**
 * A reservation's claim from its instance's rank claims: HELD while a rank is HELD, else
 * HELD_UNKNOWN while one is (a stop not proven), else RELEASED.
 */
export function reservationClaim(
  ranks: ReadonlyArray<{ claim: ClaimStateValue }>,
): ClaimStateValue {
  if (ranks.some((rank) => rank.claim === "HELD")) return "HELD";
  if (ranks.some((rank) => rank.claim === "HELD_UNKNOWN")) return "HELD_UNKNOWN";
  return "RELEASED";
}

/** Reservations that hold now: their instance has a rank claim that is not RELEASED. */
export const HOLDING_RESERVATION_WHERE = {
  Instance: { Ranks: { some: { claim: { not: "RELEASED" } } } },
} as const satisfies Prisma.InstanceReservationWhereInput;

/** The instance's rank claims, as `reservationClaim` needs them. */
export const RESERVATION_CLAIM_SELECT = {
  Instance: { select: { Ranks: { select: { claim: true } } } },
} as const satisfies Prisma.InstanceReservationSelect;

/** GiB of node memory a reservation's resources take (GPU memory included). */
export function reservationMemoryGb(resources: unknown): number {
  const needs = resourceNeeds(resources);
  return Math.round((needs.memoryGb + needs.gpuCount * needs.vramGb) * 100) / 100;
}

/**
 * A stored spec's reservations as comparable text. They are not part of the launch hash (nodes
 * never see them), so a version update compares them too before a running instance adopts it
 * live: other reservations need a restart to be placed. An unreadable spec has none.
 */
export function reservationsKey(spec: unknown): string {
  const parsed = runtimeSpecSchema.safeParse(spec);
  return canonicalJson(parsed.success ? launchReservations(parsed.data.launch) : []);
}

/** A claim's resources as declared (the GPUs the planner recorded, `gpus`, left out). */
function declared(resources: unknown): string {
  if (typeof resources !== "object" || resources === null || Array.isArray(resources))
    return canonicalJson(resources ?? null);
  const { gpus: _recorded, ...rest } = resources as Record<string, unknown>;
  return canonicalJson(rest);
}

/**
 * Whether an instance's held claims are exactly what a spec claims: one rank claim per rank
 * with that rank's resource declaration, and the current reservation rows with each entry's
 * labels and resources. A restart that keeps the instance's claims where they are and as they
 * are (a definition update's "restart running") is only for a version claiming the same as
 * what the instance HOLDS, which an older version spec does not prove (a claim taken for an
 * earlier version stays as it was taken). Anything else is placed, with the planner's capacity
 * check, by a start (runtime_start with the instance id). An unreadable spec matches nothing.
 */
export function heldClaimsMatch(
  spec: unknown,
  ranks: ReadonlyArray<{ rank: number; resources: unknown }>,
  reservations: ReadonlyArray<{ index: number; labels: unknown; resources: unknown }>,
): boolean {
  const parsed = runtimeSpecSchema.safeParse(spec);
  const launch = parsed.success ? parsed.data.launch : undefined;
  if (!launch) return false;
  if (ranks.length !== launch.groupSize) return false;
  const byRank = [...ranks].sort((a, b) => a.rank - b.rank);
  for (const [index, rank] of byRank.entries()) {
    const want = launch.resources[launch.resources.length === 1 ? 0 : index];
    if (rank.rank !== index || !want || declared(rank.resources) !== canonicalJson(want))
      return false;
  }
  const entries = launchReservations(launch);
  if (reservations.length !== entries.length) return false;
  const byIndex = [...reservations].sort((a, b) => a.index - b.index);
  return entries.every((entry, index) => {
    const row = byIndex[index];
    return (
      row !== undefined &&
      row.index === index &&
      canonicalJson(row.labels ?? null) === canonicalJson([...entry.labels]) &&
      declared(row.resources) === canonicalJson(entry.resources)
    );
  });
}

/**
 * What a version launches, as far as a running instance must restart for it: the launch hash
 * (what nodes see) plus the server-only reservations. Equal to the launch hash without any
 * reservations, so existing versions compare as before.
 */
export function launchIdentity(version: { launchHash: string; spec: unknown }): string {
  const reservations = reservationsKey(version.spec);
  return reservations === canonicalJson([])
    ? version.launchHash
    : `${version.launchHash}|${reservations}`;
}

/** The current plan's reservations (not a replaced run's, see the module comment). */
export const CURRENT_RESERVATION_WHERE = {
  supersededGeneration: null,
} as const satisfies Prisma.InstanceReservationWhereInput;

/** A reservation a start or restart writes (`PlannedStartWrite.reservations`). */
export type ReservationWrite = {
  index: number;
  nodeId: string;
  labels: readonly string[];
  resources: Record<string, unknown>;
};

/**
 * What a reservation row holds: its entry, node and resources. Labels only chose the node: a
 * row holding the same is reused (its labels updated), never a second hold of the same memory.
 */
function reservationRowKey(row: {
  index: number;
  nodeId: string | null;
  resources: unknown;
}): string {
  return canonicalJson([row.index, row.nodeId, row.resources ?? null]);
}

/**
 * Writes an instance's reservations for run `run` (just begun), replacing the current ones.
 * Called only by `retakeInstanceClaims` (every retake of an instance's claims goes through it),
 * which holds the owner fence and the instance's capacity fence, before the new run's steps
 * exist. A row is planned at `run - 1`: it may be in use only once a start step of generation
 * `run` or later was dispatched. Beginning the run made every earlier run's pending step
 * unsendable (`claimStep` dispatches only steps of the current run), so a row whose plan never
 * dispatched cannot start being used later: deleting it is safe.
 *
 * `oldRunStopped`: every rank claim of the instance was RELEASED before this run retook them
 * (proven stopped, or released by a person): nothing of an earlier run holds anything, so every
 * earlier row goes, superseded ones included (they would otherwise hold again with the retaken
 * claim). Otherwise an earlier run may still use what its rows hold:
 * - a row holding what the new plan wants (the same entry, node and resources; current, or
 *   superseded) is kept as the current row, with the plan's labels;
 * - a current row the new plan drops is superseded at `run - 1` if it may be in use (a start step of a generation after the one it was planned at was
 *   dispatched), and deleted if its plan never ran;
 * - superseded rows stay until a START of a later generation is claimed
 *   (`dropSupersededReservations`).
 * So the rows are at most the current plan's plus those of the last run that was dispatched,
 * however many restarts come before that run's stop is proven.
 */
async function replaceInstanceReservations(
  tx: Prisma.TransactionClient,
  instanceId: string,
  next: readonly ReservationWrite[],
  oldRunStopped: boolean,
  run: number,
): Promise<void> {
  const latest = run - 1;
  const rowOf = (reservation: ReservationWrite) => ({
    instanceId,
    nodeId: reservation.nodeId,
    index: reservation.index,
    labels: [...reservation.labels],
    resources: reservation.resources as Prisma.InputJsonObject,
    plannedGeneration: latest,
  });
  if (oldRunStopped) {
    await tx.instanceReservation.deleteMany({ where: { instanceId } });
    if (next.length > 0) await tx.instanceReservation.createMany({ data: next.map(rowOf) });
    return;
  }
  const rows = await tx.instanceReservation.findMany({
    where: { instanceId },
    select: {
      id: true,
      index: true,
      nodeId: true,
      labels: true,
      resources: true,
      supersededGeneration: true,
      plannedGeneration: true,
    },
  });
  // Each wanted reservation reuses an identical row: the current one first, else a superseded
  // one (the same memory on the same node, already held: never counted twice).
  const ordered = [
    ...rows.filter((row) => row.supersededGeneration === null),
    ...rows.filter((row) => row.supersededGeneration !== null),
  ];
  const reused = new Set<string>();
  const relabelled: Array<{ id: string; labels: string[] }> = [];
  const created: ReservationWrite[] = [];
  for (const reservation of next) {
    const key = reservationRowKey(reservation);
    const row = ordered.find((entry) => !reused.has(entry.id) && reservationRowKey(entry) === key);
    if (!row) {
      created.push(reservation);
      continue;
    }
    reused.add(row.id);
    if (canonicalJson(row.labels) !== canonicalJson([...reservation.labels]))
      relabelled.push({ id: row.id, labels: [...reservation.labels] });
  }
  const dropped = rows.filter((row) => row.supersededGeneration === null && !reused.has(row.id));
  if (dropped.length > 0) {
    const dispatched =
      (
        await tx.instanceStep.aggregate({
          where: { instanceId, phase: { in: [...RUN_START_PHASES] }, attempts: { gt: 0 } },
          _max: { generation: true },
        })
      )._max.generation ?? 0;
    const inUse = dropped.filter((row) => dispatched > row.plannedGeneration);
    const neverRan = dropped.filter((row) => dispatched <= row.plannedGeneration);
    if (neverRan.length > 0)
      await tx.instanceReservation.deleteMany({
        where: { id: { in: neverRan.map((row) => row.id) } },
      });
    if (inUse.length > 0)
      await tx.instanceReservation.updateMany({
        where: { id: { in: inUse.map((row) => row.id) } },
        data: { supersededGeneration: latest },
      });
  }
  // After the dropped current rows left their index (one current row per index).
  const revived = rows.filter((row) => row.supersededGeneration !== null && reused.has(row.id));
  if (revived.length > 0)
    await tx.instanceReservation.updateMany({
      where: { id: { in: revived.map((row) => row.id) } },
      data: { supersededGeneration: null },
    });
  for (const row of relabelled)
    await tx.instanceReservation.update({ where: { id: row.id }, data: { labels: row.labels } });
  if (created.length > 0) await tx.instanceReservation.createMany({ data: created.map(rowOf) });
}

/** An instance's rank claim as a new run retakes it (`retakeInstanceClaims`). */
export type RetakenClaim = ReturnType<typeof retakenClaim>;

/**
 * A rank's claim as a new run of its instance retakes it: held again (a late stop proof of the
 * old run is not of the run that owns it now and releases nothing: `releaseClaim`), with nothing
 * left of the old run's stop (no stop time, no mark as stopped, no stop check, no release
 * without proof).
 */
function retakenClaim(now: Date) {
  return {
    claim: "HELD",
    claimChangedAt: now,
    stoppedAt: null,
    markedStoppedAt: null,
    markedStoppedBy: null,
    lastStopCheckAt: null,
    releasedUnprovenAt: null,
    releasedUnprovenBy: null,
    releasedUnprovenReason: null,
  } as const satisfies Prisma.InstanceRankUpdateManyMutationInput;
}

/**
 * The one retake of an existing instance's claims by a new run: the engine's automatic restart
 * and a person's or agent's restart (`writePlannedStarts`). The new run begins first
 * (`beginRun`, returned): from this commit on, nothing of an earlier run is dispatched and its
 * answers release nothing. `writeRanks` writes the ranks with
 * `claim` (plus what the run changes: ports, resources, the instances it waits for); then the
 * instance's reservations become `reservations` (`replaceInstanceReservations`: whether the old
 * run had stopped is read before the ranks are retaken, so a run proven stopped leaves no row,
 * superseded ones included, that the retaken claim would hold again); then the old run's
 * pending release requests end. Callers hold the owner fence and the instance's capacity fence.
 */
export async function retakeInstanceClaims(
  tx: Prisma.TransactionClient,
  input: {
    instanceId: string;
    now: Date;
    reservations: readonly ReservationWrite[];
    writeRanks: (claim: RetakenClaim) => Promise<void>;
  },
): Promise<number> {
  const run = await beginRun(tx, input.instanceId);
  const oldRunStopped = (
    await tx.instanceRank.findMany({
      where: { instanceId: input.instanceId },
      select: { claim: true },
    })
  ).every((rank) => rank.claim === "RELEASED");
  await input.writeRanks(retakenClaim(input.now));
  await replaceInstanceReservations(tx, input.instanceId, input.reservations, oldRunStopped, run);
  // The claims are held by the new run: a request to release the old one has nothing left.
  await clearInstanceReleaseRequests(tx, input.instanceId, input.now);
  return run;
}

/**
 * A START of run `generation` is being claimed: its leading STOP succeeded (after every earlier
 * launch of the rank was answered), so the runs that superseded reservations belonged to have
 * stopped and those rows go.
 */
export async function dropSupersededReservations(
  tx: Prisma.TransactionClient,
  instanceId: string,
  generation: number,
): Promise<void> {
  await tx.instanceReservation.deleteMany({
    where: { instanceId, supersededGeneration: { lt: generation } },
  });
}
