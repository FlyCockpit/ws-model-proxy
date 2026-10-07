/**
 * Pool routing over (member × target) routes and the target health circuit (spec §3.9; was
 * model-pool-routing.ts). A LOCAL member names a served model; each instance serving it is one
 * execution target, so one member can route to several targets. Health is per target (one
 * model on one instance), weight and state are per member. Health writes are hot-path status
 * columns (writer class H, one row per statement; @ws-model-proxy/db/capacity-lock-order).
 */
import prisma from "@ws-model-proxy/db";
import { serverTimeoutSqlState } from "@ws-model-proxy/db/capacity-lock-order";
import { retryableSerializableTransactionCode } from "./serializable-transaction";

export const TARGET_UNHEALTHY_AFTER_RETRYABLE_FAILURES = 3;
export const TARGET_HEALTH_COOLDOWN_MS = 60_000;
/**
 * A half-open trial claim (`halfOpenTrialStartedAt`) is a lease, not a latch: attempts are not
 * heartbeated and may run for the whole relay budget (15 minutes), so the lease is that budget
 * plus a one-minute margin.
 */
export const TARGET_HALF_OPEN_LEASE_MS = 16 * 60_000;
export const TARGET_RECOVERY_BACKOFF_MS = [
  1_000, 3_000, 5_000, 10_000, 15_000, 20_000, 30_000,
] as const;

export const targetHealthStatuses = [
  "UNKNOWN",
  "HEALTHY",
  "HALF_OPEN",
  "DEGRADED",
  "UNHEALTHY",
] as const;
export type TargetHealthStatus = (typeof targetHealthStatuses)[number];

export const targetFailureClasses = [
  "TRANSPORT",
  "RELAY_TIMEOUT",
  "WEBSOCKET_DISCONNECTED",
  "STALE_SESSION",
  "UPSTREAM_5XX",
] as const;
export type TargetFailureClass = (typeof targetFailureClasses)[number];
/** Failure classes that mean "the node is away", not an upstream/transport failure. */
const nodeUnavailableFailureClasses = ["WEBSOCKET_DISCONNECTED", "STALE_SESSION"] as const;

export const relayFailureClasses = [
  "transport",
  "timeout",
  "disconnected",
  "upstream_5xx",
  "upstream_4xx",
  "unsupported_capability",
  "not_found",
  "access_denied",
  "rate_limited",
  "request_too_large",
  "cancelled",
  "protocol_error",
  "unknown",
] as const;
export type RelayFailureClass = (typeof relayFailureClasses)[number];

export type SmoothWeightedRoundRobinState = Record<string, number>;

export type TargetHealthSnapshot = {
  health: TargetHealthStatus;
  lastFailureClass: TargetFailureClass | null;
  consecutiveRetryableFailures: number;
  lastFailureAt: Date | null;
  nextRetryAt: Date | null;
  halfOpenTrialStartedAt: Date | null;
};
export type TargetHealthUpdate = TargetHealthSnapshot;

/** One route the resolver offers: a member of the pool served by one instance. */
export type PoolRouteRow = TargetHealthSnapshot & {
  poolMemberId: string;
  poolId: string;
  runtimeModelId: string;
  upstreamModelId: string;
  executionTargetId: string;
  instanceId: string;
  instanceHandle: string;
  /** The head node the request is relayed to; null when the instance has none placed. */
  nodeId: string | null;
  instanceReady: boolean;
  nodeOnline: boolean;
  memberActive: boolean;
  weight: number;
};

export type PoolRouteCandidate = {
  poolMemberId: string;
  poolId: string;
  runtimeModelId: string;
  upstreamModelId: string;
  executionTargetId: string;
  instanceId: string;
  instanceHandle: string;
  nodeId: string;
  weight: number;
  health: "HEALTHY" | "HALF_OPEN";
  consecutiveRetryableFailures: number;
  lastFailureClass: TargetFailureClass | null;
  lastFailureAt: Date | null;
  nextRetryAt: Date | null;
  /** A due degraded route routed because no healthy route can serve (half-open request). */
  degradedFallback?: boolean;
};

export type PoolRouteSequenceResult =
  | { ok: true; candidates: PoolRouteCandidate[]; state: SmoothWeightedRoundRobinState }
  | {
      ok: false;
      reason: "NO_ROUTABLE_POOL_MEMBERS";
      failureClass: "no_routable_member";
      retryable: true;
    };

export function routeKey(route: { poolMemberId: string; executionTargetId: string }): string {
  return `${route.poolMemberId}:${route.executionTargetId}`;
}

export function targetFailureClassForRelayFailure(
  failure: RelayFailureClass,
): TargetFailureClass | null {
  if (failure === "transport") return "TRANSPORT";
  if (failure === "timeout") return "RELAY_TIMEOUT";
  if (failure === "disconnected") return "WEBSOCKET_DISCONNECTED";
  if (failure === "upstream_5xx") return "UPSTREAM_5XX";
  // A protocol violation is attributable to the selected target like a broken relay payload.
  if (failure === "protocol_error") return "TRANSPORT";
  return null;
}

/**
 * What one failed attempt says about its target's health. An adapted attempt (the proxy
 * translated a surface the member does not serve natively, e.g. a Responses request onto chat
 * completions) that the engine answers with a 5xx, or whose reply the adapter cannot
 * translate, is evidence about the translation, not the member: it never degrades it. An
 * unreachable target (transport, timeout, disconnect) still counts.
 */
export function targetHealthFailure(
  failure: RelayFailureClass,
  adapted: boolean,
): RelayFailureClass {
  return adapted && (failure === "upstream_5xx" || failure === "protocol_error")
    ? "unknown"
    : failure;
}

export function isRetryableTargetRelayFailure(failure: RelayFailureClass): boolean {
  return targetFailureClassForRelayFailure(failure) !== null;
}

export function resetTargetHealth(): TargetHealthUpdate {
  return {
    health: "HEALTHY",
    lastFailureClass: null,
    consecutiveRetryableFailures: 0,
    lastFailureAt: null,
    nextRetryAt: null,
    halfOpenTrialStartedAt: null,
  };
}

export function targetRecoveryDelayMs(consecutiveFailures: number): number {
  const index = Math.min(
    Math.max(consecutiveFailures - 1, 0),
    TARGET_RECOVERY_BACKOFF_MS.length - 1,
  );
  return TARGET_RECOVERY_BACKOFF_MS[index] ?? TARGET_HEALTH_COOLDOWN_MS;
}

export function transitionTargetHealthAfterRetryableFailure({
  target,
  failureClass,
  now,
}: {
  target: TargetHealthSnapshot;
  failureClass: TargetFailureClass;
  now: Date;
}): TargetHealthUpdate {
  const consecutiveRetryableFailures = target.consecutiveRetryableFailures + 1;
  const cooldownUntil = new Date(
    now.getTime() + targetRecoveryDelayMs(consecutiveRetryableFailures),
  );
  const failedHalfOpenTrial =
    target.health === "HALF_OPEN" ||
    (target.health === "UNHEALTHY" &&
      target.nextRetryAt !== null &&
      target.nextRetryAt.getTime() <= now.getTime());
  return {
    health:
      failedHalfOpenTrial ||
      consecutiveRetryableFailures >= TARGET_UNHEALTHY_AFTER_RETRYABLE_FAILURES
        ? "UNHEALTHY"
        : "DEGRADED",
    lastFailureClass: failureClass,
    consecutiveRetryableFailures,
    lastFailureAt: now,
    nextRetryAt: cooldownUntil,
    halfOpenTrialStartedAt: null,
  };
}

export function transitionTargetHealthForNodeUnavailable({
  failureClass,
  now,
}: {
  failureClass: (typeof nodeUnavailableFailureClasses)[number];
  now: Date;
}): TargetHealthUpdate {
  return {
    health: "UNHEALTHY",
    lastFailureClass: failureClass,
    consecutiveRetryableFailures: TARGET_UNHEALTHY_AFTER_RETRYABLE_FAILURES,
    lastFailureAt: now,
    nextRetryAt: new Date(now.getTime() + TARGET_HEALTH_COOLDOWN_MS),
    halfOpenTrialStartedAt: null,
  };
}

/** The one lease predicate: a trial is live iff it was claimed after `now - lease`. */
export function targetTrialLive(startedAt: Date | null, now: Date): boolean {
  return startedAt !== null && startedAt.getTime() > now.getTime() - TARGET_HALF_OPEN_LEASE_MS;
}

function effectiveHealthForRouting(
  target: Pick<TargetHealthSnapshot, "health" | "nextRetryAt" | "halfOpenTrialStartedAt">,
  now: Date,
  allowDegraded: boolean,
): "HEALTHY" | "HALF_OPEN" | null {
  if (target.health === "HEALTHY" || target.health === "UNKNOWN") return "HEALTHY";
  if (target.health === "HALF_OPEN")
    return targetTrialLive(target.halfOpenTrialStartedAt, now) ? null : "HALF_OPEN";
  const due = target.nextRetryAt !== null && target.nextRetryAt.getTime() <= now.getTime();
  // With no healthy alternative, a due degraded route gets its half-open request.
  if (target.health === "DEGRADED" && allowDegraded && due) return "HALF_OPEN";
  if (target.health === "UNHEALTHY" && due) return "HALF_OPEN";
  return null;
}

export function routablePoolRoutes({
  routes,
  onlineNodeIds,
  now,
  alternatives = routes,
}: {
  routes: readonly PoolRouteRow[];
  onlineNodeIds: Iterable<string>;
  now: Date;
  /** Every route of the request (all surface groups), when `routes` is one group of them. */
  alternatives?: readonly PoolRouteRow[];
}): PoolRouteCandidate[] {
  const online = new Set(onlineNodeIds);
  const servable = (route: PoolRouteRow) =>
    route.instanceReady &&
    route.nodeOnline &&
    route.nodeId !== null &&
    online.has(route.nodeId) &&
    route.memberActive &&
    route.weight > 0;
  // A degraded route is left to the recovery probe while a healthy route can serve. Without
  // one (every member degraded, or a one-route pool) a due degraded route takes a half-open
  // request: otherwise a member whose probe cannot run (or has not yet) is never routed again
  // and the pool answers 503 while its engines are fine.
  const healthyAlternative = alternatives.some(
    (route) => (route.health === "HEALTHY" || route.health === "UNKNOWN") && servable(route),
  );
  const candidates: PoolRouteCandidate[] = [];
  for (const route of routes) {
    const degradedFallback = !healthyAlternative && route.health === "DEGRADED";
    const health = effectiveHealthForRouting(route, now, degradedFallback);
    if (health === null || !servable(route) || route.nodeId === null) continue;
    candidates.push({
      poolMemberId: route.poolMemberId,
      poolId: route.poolId,
      runtimeModelId: route.runtimeModelId,
      upstreamModelId: route.upstreamModelId,
      executionTargetId: route.executionTargetId,
      instanceId: route.instanceId,
      instanceHandle: route.instanceHandle,
      nodeId: route.nodeId,
      weight: route.weight,
      health,
      consecutiveRetryableFailures: route.consecutiveRetryableFailures,
      lastFailureClass: route.lastFailureClass,
      lastFailureAt: route.lastFailureAt,
      nextRetryAt: route.nextRetryAt,
      degradedFallback,
    });
  }
  return candidates;
}

type Weighted = { id: string; weight: number; route: PoolRouteCandidate };

function pickSmoothWeighted(
  candidates: Weighted[],
  state: SmoothWeightedRoundRobinState,
): { candidate: Weighted; state: SmoothWeightedRoundRobinState } {
  const nextState: SmoothWeightedRoundRobinState = {};
  let selected: Weighted | null = null;
  let selectedWeight = Number.NEGATIVE_INFINITY;
  const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
  for (const candidate of candidates) {
    const currentWeight = (state[candidate.id] ?? 0) + candidate.weight;
    nextState[candidate.id] = currentWeight;
    if (currentWeight > selectedWeight) {
      selected = candidate;
      selectedWeight = currentWeight;
    }
  }
  if (!selected) throw new Error("Cannot select from an empty weighted candidate list.");
  nextState[selected.id] = (nextState[selected.id] ?? 0) - totalWeight;
  return { candidate: selected, state: nextState };
}

function weighted(route: PoolRouteCandidate): Weighted {
  return { id: routeKey(route), weight: route.weight, route };
}

/** Smooth weighted round robin for the first pick, then the failover order after it. */
export function buildPoolRouteSequence({
  routes,
  onlineNodeIds,
  now,
  state = {},
  alternatives,
}: {
  routes: readonly PoolRouteRow[];
  onlineNodeIds: Iterable<string>;
  now: Date;
  state?: SmoothWeightedRoundRobinState;
  /** Every route of the request, when `routes` is one surface group of them. */
  alternatives?: readonly PoolRouteRow[];
}): PoolRouteSequenceResult {
  const candidates = routablePoolRoutes({
    routes,
    onlineNodeIds,
    now,
    ...(alternatives ? { alternatives } : {}),
  });
  if (candidates.length === 0)
    return {
      ok: false,
      reason: "NO_ROUTABLE_POOL_MEMBERS",
      failureClass: "no_routable_member",
      retryable: true,
    };
  const primary = pickSmoothWeighted(candidates.map(weighted), state);
  const ordered = [primary.candidate.route];
  let remaining = candidates.filter((route) => routeKey(route) !== primary.candidate.id);
  let cursor = primary.state;
  while (remaining.length > 0) {
    const pick = pickSmoothWeighted(remaining.map(weighted), cursor);
    ordered.push(pick.candidate.route);
    cursor = pick.state;
    remaining = remaining.filter((route) => routeKey(route) !== pick.candidate.id);
  }
  return { ok: true, candidates: ordered, state: primary.state };
}

/**
 * The ownership fence for relay outcome writes: with a trial claim, only that claim may
 * settle; without one, the write never clears another request's live claim.
 */
function targetOutcomeFence(trialStartedAt: Date | null, now: Date) {
  if (trialStartedAt)
    return { health: "HALF_OPEN" as const, halfOpenTrialStartedAt: trialStartedAt };
  return {
    OR: [
      { health: { not: "HALF_OPEN" as const } },
      { halfOpenTrialStartedAt: null },
      { halfOpenTrialStartedAt: { lte: new Date(now.getTime() - TARGET_HALF_OPEN_LEASE_MS) } },
    ],
  };
}

const HEALTH_SELECT = {
  health: true,
  lastFailureClass: true,
  consecutiveRetryableFailures: true,
  lastFailureAt: true,
  nextRetryAt: true,
  halfOpenTrialStartedAt: true,
} as const;

export async function recordTargetRelayFailure({
  executionTargetId,
  failure,
  trialStartedAt,
  now = new Date(),
}: {
  executionTargetId: string;
  failure: RelayFailureClass;
  trialStartedAt: Date | null;
  now?: Date;
}): Promise<{ retryable: boolean; update: TargetHealthUpdate | null }> {
  const failureClass = targetFailureClassForRelayFailure(failure);
  if (!failureClass) {
    // Says nothing about the target: a half-open trial it held goes back to waiting out its
    // backoff (visible to the recovery probe again), not left to its 16-minute lease.
    if (trialStartedAt) await returnTargetTrial({ executionTargetId, trialStartedAt, now });
    return { retryable: false, update: null };
  }
  // A relay `disconnected` outcome is the in-flight echo of a node detach, whose own fenced
  // write (`disconnectNodeAtGeneration`) owns "node unavailable" health.
  if (failureClass === "WEBSOCKET_DISCONNECTED") {
    if (trialStartedAt) await releaseTargetHalfOpenTrial({ executionTargetId, trialStartedAt });
    return { retryable: true, update: null };
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const target = await prisma.executionTarget.findUnique({
      where: { id: executionTargetId },
      select: HEALTH_SELECT,
    });
    if (!target) return { retryable: true, update: null };
    const owned = trialStartedAt
      ? target.health === "HALF_OPEN" &&
        target.halfOpenTrialStartedAt?.getTime() === trialStartedAt.getTime()
      : !(target.health === "HALF_OPEN" && targetTrialLive(target.halfOpenTrialStartedAt, now));
    if (!owned) return { retryable: true, update: null };
    const update = transitionTargetHealthAfterRetryableFailure({ target, failureClass, now });
    const result = await prisma.executionTarget.updateMany({
      where: {
        id: executionTargetId,
        health: target.health,
        halfOpenTrialStartedAt: target.halfOpenTrialStartedAt,
        consecutiveRetryableFailures: target.consecutiveRetryableFailures,
        ...(trialStartedAt ? {} : targetOutcomeFence(null, now)),
      },
      data: update,
    });
    if (result.count === 1) return { retryable: true, update };
  }
  return { retryable: true, update: null };
}

export async function markTargetRelaySuccess(
  executionTargetId: string,
  { trialStartedAt, now = new Date() }: { trialStartedAt: Date | null; now?: Date },
): Promise<void> {
  await prisma.executionTarget.updateMany({
    where: { id: executionTargetId, ...targetOutcomeFence(trialStartedAt, now) },
    data: { ...resetTargetHealth(), lastRoutedAt: now },
  });
}

/** Claims a due target for one recovery probe; the timestamp is the lease/fence. */
export async function claimTargetRecoveryTrial({
  executionTargetId,
  now = new Date(),
}: {
  executionTargetId: string;
  now?: Date;
}): Promise<Date | null> {
  const result = await prisma.executionTarget.updateMany({
    where: {
      id: executionTargetId,
      health: { in: ["DEGRADED", "UNHEALTHY"] },
      nextRetryAt: { lte: now },
    },
    data: { health: "HALF_OPEN", halfOpenTrialStartedAt: now },
  });
  return result.count === 1 ? now : null;
}

/** Settles only the recovery lease this caller claimed. */
export async function settleTargetRecoveryTrial({
  executionTargetId,
  trialStartedAt,
  healthy,
  now = new Date(),
}: {
  executionTargetId: string;
  trialStartedAt: Date;
  healthy: boolean;
  now?: Date;
}): Promise<boolean> {
  const target = await prisma.executionTarget.findUnique({
    where: { id: executionTargetId },
    select: HEALTH_SELECT,
  });
  if (
    target?.health !== "HALF_OPEN" ||
    target.halfOpenTrialStartedAt?.getTime() !== trialStartedAt.getTime()
  )
    return false;
  const data = healthy
    ? resetTargetHealth()
    : transitionTargetHealthAfterRetryableFailure({ target, failureClass: "TRANSPORT", now });
  const result = await prisma.executionTarget.updateMany({
    where: { id: executionTargetId, health: "HALF_OPEN", halfOpenTrialStartedAt: trialStartedAt },
    data,
  });
  return result.count === 1;
}

/** A recovery probe whose connection was superseded proves nothing: give the trial back due. */
export async function abandonTargetRecoveryTrial({
  executionTargetId,
  trialStartedAt,
  now = new Date(),
}: {
  executionTargetId: string;
  trialStartedAt: Date;
  now?: Date;
}): Promise<boolean> {
  const result = await prisma.executionTarget.updateMany({
    where: { id: executionTargetId, health: "HALF_OPEN", halfOpenTrialStartedAt: trialStartedAt },
    data: { health: "UNHEALTHY", nextRetryAt: now, halfOpenTrialStartedAt: null },
  });
  return result.count === 1;
}

export async function markTargetHalfOpenTrial({
  executionTargetId,
  allowDegradedFallback = false,
  now = new Date(),
}: {
  executionTargetId: string;
  /** Only the routing path may enable this, for a route with no healthy alternative. */
  allowDegradedFallback?: boolean;
  now?: Date;
}): Promise<number> {
  const result = await prisma.executionTarget.updateMany({
    where: {
      id: executionTargetId,
      OR: [
        { health: "UNHEALTHY", nextRetryAt: { lte: now } },
        { health: "HALF_OPEN", halfOpenTrialStartedAt: null },
        {
          health: "HALF_OPEN",
          halfOpenTrialStartedAt: { lte: new Date(now.getTime() - TARGET_HALF_OPEN_LEASE_MS) },
        },
        ...(allowDegradedFallback
          ? [{ health: "DEGRADED" as const, nextRetryAt: { lte: now } }]
          : []),
      ],
    },
    data: { health: "HALF_OPEN", halfOpenTrialStartedAt: now },
  });
  return result.count;
}

/**
 * An inconclusive half-open trial (the attempt failed for a reason that is not the target's):
 * the target is degraded (unhealthy after enough failures) again with its current backoff, so
 * the recovery probe and the next due request may try it; no failure is counted.
 */
async function returnTargetTrial({
  executionTargetId,
  trialStartedAt,
  now,
}: {
  executionTargetId: string;
  trialStartedAt: Date;
  now: Date;
}): Promise<void> {
  const target = await prisma.executionTarget.findUnique({
    where: { id: executionTargetId },
    select: { consecutiveRetryableFailures: true },
  });
  if (!target) return;
  const failures = target.consecutiveRetryableFailures;
  await prisma.executionTarget.updateMany({
    where: { id: executionTargetId, health: "HALF_OPEN", halfOpenTrialStartedAt: trialStartedAt },
    data: {
      health: failures >= TARGET_UNHEALTHY_AFTER_RETRYABLE_FAILURES ? "UNHEALTHY" : "DEGRADED",
      halfOpenTrialStartedAt: null,
      nextRetryAt: new Date(now.getTime() + targetRecoveryDelayMs(failures)),
    },
  });
}

/** Gives back a half-open trial whose claimant sent nothing. */
export async function releaseTargetHalfOpenTrial({
  executionTargetId,
  trialStartedAt,
}: {
  executionTargetId: string;
  trialStartedAt: Date;
}): Promise<boolean> {
  const result = await prisma.executionTarget.updateMany({
    where: { id: executionTargetId, health: "HALF_OPEN", halfOpenTrialStartedAt: trialStartedAt },
    data: { halfOpenTrialStartedAt: null },
  });
  return result.count === 1;
}

/** Targets with a rank (or the always-on runtime) on `nodeId`. */
function targetsOnNode(nodeId: string) {
  return {
    Instance: {
      OR: [
        { Ranks: { some: { nodeId, claim: { not: "RELEASED" as const } } } },
        { Runtime: { kind: "ALWAYS_ON" as const, nodeId } },
      ],
    },
  };
}

/**
 * A node's relay session went away: its targets are circuit-opened for the cooldown, one row
 * per statement in id order, inside the caller's transaction that holds the `node` row.
 */
export async function markTargetsForNodeUnavailable({
  nodeId,
  failureClass,
  now = new Date(),
  db,
}: {
  nodeId: string;
  failureClass: (typeof nodeUnavailableFailureClasses)[number];
  now?: Date;
  db: Pick<typeof prisma, "executionTarget">;
}): Promise<void> {
  // A target cooling down for a real failure keeps its class and cooldown.
  const notRealFailureCoolingDown = {
    NOT: {
      health: { in: ["UNHEALTHY" as const, "DEGRADED" as const] },
      nextRetryAt: { gt: now },
      lastFailureClass: { not: null, notIn: [...nodeUnavailableFailureClasses] },
    },
  };
  const targets = await db.executionTarget.findMany({
    where: { ...notRealFailureCoolingDown, ...targetsOnNode(nodeId) },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  const data = transitionTargetHealthForNodeUnavailable({ failureClass, now });
  for (const target of targets)
    await db.executionTarget.updateMany({
      where: { id: target.id, ...notRealFailureCoolingDown },
      data,
    });
}

const DISCONNECT_TRANSACTION_MAX_ATTEMPTS = 5;
const DISCONNECT_TRANSACTION_TIMEOUT_MS = 10_000;
const DISCONNECT_TRANSACTION_MAX_WAIT_MS = 5_000;
const DISCONNECT_LOCK_TIMEOUT_MS = 2_000;
const DISCONNECT_RETRY_BACKOFF_MS = 100;
const DISCONNECT_LOCK_RETRY_BUDGET_MS = 30_000;

function isLockTimeout(error: unknown): boolean {
  return serverTimeoutSqlState(error) === "55P03";
}

function isRetryableDisconnectError(error: unknown): boolean {
  if (retryableSerializableTransactionCode(error) !== undefined) return true;
  if (isLockTimeout(error)) return true;
  return typeof error === "object" && error !== null && Reflect.get(error, "code") === "P2028";
}

/**
 * The ONE persistence point for "no session serves this node" (connection + target circuit).
 * Returns false, writing nothing, when the node's `connectionGeneration` is no longer
 * `generation` (a successor hello committed). Node row first, then target rows.
 */
export async function disconnectNodeAtGeneration({
  nodeId,
  generation,
  failureClass,
  now = new Date(),
}: {
  nodeId: string;
  generation: number;
  failureClass: (typeof nodeUnavailableFailureClasses)[number];
  now?: Date;
}): Promise<boolean> {
  const lockRetryDeadline = Date.now() + DISCONNECT_LOCK_RETRY_BUDGET_MS;
  let failures = 0;
  let otherFailures = 0;
  for (;;) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${DISCONNECT_LOCK_TIMEOUT_MS}ms`}, true)`;
          const claimed = await tx.node.updateMany({
            where: { id: nodeId, connectionGeneration: generation },
            data: { connection: "OFFLINE", lastDisconnectedAt: now },
          });
          if (claimed.count === 0) return false;
          await markTargetsForNodeUnavailable({ nodeId, failureClass, now, db: tx });
          return true;
        },
        { timeout: DISCONNECT_TRANSACTION_TIMEOUT_MS, maxWait: DISCONNECT_TRANSACTION_MAX_WAIT_MS },
      );
    } catch (error) {
      failures += 1;
      const lockTimeout = isLockTimeout(error);
      if (!lockTimeout) otherFailures += 1;
      const exhausted = lockTimeout
        ? Date.now() >= lockRetryDeadline
        : otherFailures >= DISCONNECT_TRANSACTION_MAX_ATTEMPTS ||
          !isRetryableDisconnectError(error);
      if (exhausted) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, DISCONNECT_RETRY_BACKOFF_MS * Math.min(failures, 10)),
      );
    }
  }
}

/**
 * A node reconnected: targets circuit-opened only because it was away become due now, so the
 * recovery probe runs at once. Nothing is marked healthy here; the probe decides.
 */
export async function markTargetsDueAfterNodeReconnect({
  nodeId,
  now = new Date(),
}: {
  nodeId: string;
  now?: Date;
}): Promise<number> {
  const eligible = {
    health: "UNHEALTHY" as const,
    lastFailureClass: { in: [...nodeUnavailableFailureClasses] },
    nextRetryAt: { gt: now },
  };
  const targets = await prisma.executionTarget.findMany({
    where: { ...eligible, ...targetsOnNode(nodeId) },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  let count = 0;
  for (const target of targets) {
    const result = await prisma.executionTarget.updateMany({
      where: { id: target.id, ...eligible },
      data: { nextRetryAt: now },
    });
    count += result.count;
  }
  return count;
}
