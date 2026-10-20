/**
 * Reservations (`launch.reservations`, `InstanceReservation`): memory a single-node instance
 * holds on other nodes while it runs. A reservation has no claim state of its own: it holds
 * exactly while one of its instance's ranks holds its claim. So every path that releases a
 * rank's claim (a proven stop, a crash, a failed start, a person's release without proof, a
 * deleted node) releases the reservations with it, and every retake (automatic restart,
 * restart) retakes them; nothing writes a reservation's claim. Nothing is ever dispatched to a
 * reservation's node: dispatch, crash detection, stop proofs and held-unknown probes read ranks
 * only.
 */
import type { Prisma } from "@ws-model-proxy/db";
import { canonicalJson } from "./canonical-json";
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
