import prisma from "@ws-model-proxy/db";

export const POOL_MEMBER_UNHEALTHY_AFTER_RETRYABLE_FAILURES = 3;
export const POOL_MEMBER_HEALTH_COOLDOWN_MS = 60_000;
/**
 * A half-open trial claim (`halfOpenTrialStartedAt`) is a lease, not a
 * permanent latch: a claimant that dies or exits without settling (client
 * abort, crash, lost finalizer) would otherwise keep the member out of
 * rotation forever. Pool attempts are not heartbeated and may legitimately run
 * for the whole relay budget (`MODEL_API_RELAY_TIMEOUT_MS`, 15 minutes), so the
 * lease is that budget plus a one-minute margin: a live attempt can never be
 * taken over, and a stranded claim recovers within this bound. Pinned against
 * the relay budget by a test in apps/server.
 */
export const POOL_MEMBER_HALF_OPEN_LEASE_MS = 16 * 60_000;
export const POOL_MEMBER_RECOVERY_BACKOFF_MS = [
  1_000, 3_000, 5_000, 10_000, 15_000, 20_000, 30_000,
] as const;

export const poolMemberHealthStatuses = [
  "UNKNOWN",
  "HEALTHY",
  "HALF_OPEN",
  "DEGRADED",
  "UNHEALTHY",
] as const;
export type PoolMemberHealthStatus = (typeof poolMemberHealthStatuses)[number];

export const poolMemberRoutingStatuses = ["ACTIVE", "DRAINING", "DISABLED"] as const;
export type PoolMemberRoutingStatus = (typeof poolMemberRoutingStatuses)[number];

export const poolMemberFailureClasses = [
  "TRANSPORT",
  "RELAY_TIMEOUT",
  "WEBSOCKET_DISCONNECTED",
  "STALE_SESSION",
  "UPSTREAM_5XX",
] as const;
export type PoolMemberFailureClass = (typeof poolMemberFailureClasses)[number];
/** Failure classes that mean "the device is away", not an upstream/transport failure. */
const cliUnavailableFailureClasses = ["WEBSOCKET_DISCONNECTED", "STALE_SESSION"] as const;

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

export type PoolMemberRouteRow = {
  id: string;
  poolId: string;
  discoveredModelId: string;
  weight: number;
  healthStatus: PoolMemberHealthStatus;
  routingStatus: PoolMemberRoutingStatus;
  lastFailureClass: PoolMemberFailureClass | null;
  consecutiveRetryableFailures: number;
  lastFailureAt: Date | null;
  nextRetryAt: Date | null;
  halfOpenTrialStartedAt: Date | null;
  DiscoveredModel: {
    published: boolean;
    upstreamModelId: string;
    Endpoint: {
      id: string;
      slug: string;
      published: boolean;
      cliDeviceId: string;
      status?: string | null;
      CliDevice?: {
        status: string;
      } | null;
    };
  };
};

export type PoolRouteCandidate = {
  poolMemberId: string;
  poolId: string;
  discoveredModelId: string;
  upstreamModelId: string;
  endpointId: string;
  cliDeviceId: string;
  weight: number;
  healthStatus: "HEALTHY" | "HALF_OPEN";
  consecutiveRetryableFailures: number;
  lastFailureClass: PoolMemberFailureClass | null;
  lastFailureAt: Date | null;
  nextRetryAt: Date | null;
  /** True only for the one-configured-member degraded fallback path. */
  singleMemberDegradedFallback?: boolean;
};

export type PoolRouteSequenceResult =
  | {
      ok: true;
      candidates: PoolRouteCandidate[];
      state: SmoothWeightedRoundRobinState;
    }
  | {
      ok: false;
      reason: "NO_ROUTABLE_POOL_MEMBERS";
      failureClass: "no_routable_member";
      retryable: true;
    };

export type PoolMemberHealthSnapshot = {
  healthStatus: PoolMemberHealthStatus;
  lastFailureClass: PoolMemberFailureClass | null;
  consecutiveRetryableFailures: number;
  lastFailureAt: Date | null;
  nextRetryAt: Date | null;
  halfOpenTrialStartedAt: Date | null;
};

export type PoolMemberHealthUpdate = PoolMemberHealthSnapshot;

type WeightedCandidate = {
  id: string;
  weight: number;
};

type WeightedRouteCandidate = WeightedCandidate & {
  route: PoolRouteCandidate;
};

type WeightedPick<TCandidate extends WeightedCandidate> = {
  candidate: TCandidate;
  state: SmoothWeightedRoundRobinState;
};

export function poolMemberFailureClassForRelayFailure(
  failure: RelayFailureClass,
): PoolMemberFailureClass | null {
  if (failure === "transport") return "TRANSPORT";
  if (failure === "timeout") return "RELAY_TIMEOUT";
  if (failure === "disconnected") return "WEBSOCKET_DISCONNECTED";
  if (failure === "upstream_5xx") return "UPSTREAM_5XX";
  // A protocol violation is attributable to the selected upstream member in
  // the same way as a broken relay payload: keep it out of the healthy path
  // instead of recording the adapted request as an unpenalized failure.
  if (failure === "protocol_error") return "TRANSPORT";
  return null;
}

export function isRetryablePoolMemberRelayFailure(failure: RelayFailureClass): boolean {
  return poolMemberFailureClassForRelayFailure(failure) !== null;
}

export function resetPoolMemberHealth(): PoolMemberHealthUpdate {
  return {
    healthStatus: "HEALTHY",
    lastFailureClass: null,
    consecutiveRetryableFailures: 0,
    lastFailureAt: null,
    nextRetryAt: null,
    halfOpenTrialStartedAt: null,
  };
}

export function poolMemberRecoveryDelayMs(consecutiveFailures: number): number {
  return POOL_MEMBER_RECOVERY_BACKOFF_MS[
    Math.min(Math.max(consecutiveFailures - 1, 0), POOL_MEMBER_RECOVERY_BACKOFF_MS.length - 1)
  ]!;
}

export function transitionPoolMemberHealthAfterRetryableFailure({
  member,
  failureClass,
  now,
}: {
  member: PoolMemberHealthSnapshot;
  failureClass: PoolMemberFailureClass;
  now: Date;
}): PoolMemberHealthUpdate {
  const consecutiveRetryableFailures = member.consecutiveRetryableFailures + 1;
  const cooldownUntil = new Date(
    now.getTime() + poolMemberRecoveryDelayMs(consecutiveRetryableFailures),
  );
  const failedHalfOpenTrial =
    member.healthStatus === "HALF_OPEN" ||
    (member.healthStatus === "UNHEALTHY" &&
      member.nextRetryAt !== null &&
      member.nextRetryAt.getTime() <= now.getTime());

  if (
    failedHalfOpenTrial ||
    consecutiveRetryableFailures >= POOL_MEMBER_UNHEALTHY_AFTER_RETRYABLE_FAILURES
  ) {
    return {
      healthStatus: "UNHEALTHY",
      lastFailureClass: failureClass,
      consecutiveRetryableFailures,
      lastFailureAt: now,
      nextRetryAt: cooldownUntil,
      halfOpenTrialStartedAt: null,
    };
  }

  return {
    healthStatus: "DEGRADED",
    lastFailureClass: failureClass,
    consecutiveRetryableFailures,
    lastFailureAt: now,
    nextRetryAt: cooldownUntil,
    halfOpenTrialStartedAt: null,
  };
}

export function transitionPoolMemberHealthForCliUnavailable({
  failureClass,
  now,
}: {
  failureClass: Extract<PoolMemberFailureClass, "WEBSOCKET_DISCONNECTED" | "STALE_SESSION">;
  now: Date;
}): PoolMemberHealthUpdate {
  return {
    healthStatus: "UNHEALTHY",
    lastFailureClass: failureClass,
    consecutiveRetryableFailures: POOL_MEMBER_UNHEALTHY_AFTER_RETRYABLE_FAILURES,
    lastFailureAt: now,
    nextRetryAt: new Date(now.getTime() + POOL_MEMBER_HEALTH_COOLDOWN_MS),
    halfOpenTrialStartedAt: null,
  };
}

export function beginPoolMemberHalfOpenTrial(
  now: Date,
): Pick<PoolMemberHealthUpdate, "healthStatus" | "halfOpenTrialStartedAt"> {
  return {
    healthStatus: "HALF_OPEN",
    halfOpenTrialStartedAt: now,
  };
}

/**
 * The one lease predicate: a trial is live iff it was claimed after
 * `now - lease`. The claim `where` in markPoolMemberHalfOpenTrial is its exact
 * complement (expired iff `startedAt <= cutoff`).
 */
export function poolMemberTrialLive(startedAt: Date | null, now: Date): boolean {
  return startedAt !== null && startedAt.getTime() > now.getTime() - POOL_MEMBER_HALF_OPEN_LEASE_MS;
}

function effectiveHealthStatusForRouting(
  member: Pick<PoolMemberRouteRow, "healthStatus" | "nextRetryAt" | "halfOpenTrialStartedAt">,
  now: Date,
  allowDegraded: boolean,
): "HEALTHY" | "HALF_OPEN" | null {
  if (member.healthStatus === "HEALTHY" || member.healthStatus === "UNKNOWN") {
    return "HEALTHY";
  }
  if (member.healthStatus === "HALF_OPEN") {
    return poolMemberTrialLive(member.halfOpenTrialStartedAt, now) ? null : "HALF_OPEN";
  }
  // A one-member pool has no alternative. Permit its normal execution path to
  // decide availability/compatibility rather than making health state alone a
  // permanent outage. Multi-member pools continue to fail over.
  // The sole configured member is allowed a *due* half-open request.  It is
  // intentionally not based on the compatible subset: a pool with another
  // configured (but currently incompatible or disabled) member still has an
  // alternative configuration and must not bypass this member's cooldown.
  if (
    member.healthStatus === "DEGRADED" &&
    allowDegraded &&
    member.nextRetryAt !== null &&
    member.nextRetryAt.getTime() <= now.getTime()
  )
    return "HALF_OPEN";
  if (
    member.healthStatus === "UNHEALTHY" &&
    member.nextRetryAt !== null &&
    member.nextRetryAt.getTime() <= now.getTime()
  ) {
    return "HALF_OPEN";
  }
  return null;
}

export function isPublishedEndpointExecutable({
  modelPublished,
  endpointPublished,
  endpointStatus,
  cliDeviceId,
  cliDeviceStatus,
  activeCliDeviceIds,
}: {
  modelPublished: boolean;
  endpointPublished: boolean;
  endpointStatus: string | null | undefined;
  cliDeviceId: string;
  cliDeviceStatus: string | null | undefined;
  activeCliDeviceIds: Set<string>;
}): boolean {
  return (
    modelPublished &&
    endpointPublished &&
    endpointStatus !== "OFFLINE" &&
    cliDeviceStatus === "CONNECTED" &&
    activeCliDeviceIds.has(cliDeviceId)
  );
}

export function routablePoolMembers({
  members,
  activeCliDeviceIds,
  now,
}: {
  members: PoolMemberRouteRow[];
  activeCliDeviceIds: Iterable<string>;
  now: Date;
}): PoolRouteCandidate[] {
  const activeCliDeviceIdSet = new Set(activeCliDeviceIds);
  const candidates: PoolRouteCandidate[] = [];

  for (const member of members) {
    const endpoint = member.DiscoveredModel.Endpoint;
    const singleMemberDegradedFallback = members.length === 1 && member.healthStatus === "DEGRADED";
    const healthStatus = effectiveHealthStatusForRouting(member, now, singleMemberDegradedFallback);
    if (healthStatus === null) continue;
    if (
      !isPublishedEndpointExecutable({
        modelPublished: member.DiscoveredModel.published,
        endpointPublished: endpoint.published,
        endpointStatus: endpoint.status,
        cliDeviceId: endpoint.cliDeviceId,
        cliDeviceStatus: endpoint.CliDevice?.status,
        activeCliDeviceIds: activeCliDeviceIdSet,
      })
    )
      continue;
    if (member.routingStatus !== "ACTIVE") continue;
    if (member.weight <= 0) continue;

    candidates.push({
      poolMemberId: member.id,
      poolId: member.poolId,
      discoveredModelId: member.discoveredModelId,
      upstreamModelId: member.DiscoveredModel.upstreamModelId,
      endpointId: endpoint.id,
      cliDeviceId: endpoint.cliDeviceId,
      weight: member.weight,
      healthStatus,
      consecutiveRetryableFailures: member.consecutiveRetryableFailures,
      lastFailureClass: member.lastFailureClass,
      lastFailureAt: member.lastFailureAt,
      nextRetryAt: member.nextRetryAt,
      singleMemberDegradedFallback,
    });
  }

  return candidates;
}

function pickSmoothWeighted<TCandidate extends WeightedCandidate>({
  candidates,
  state,
}: {
  candidates: TCandidate[];
  state: SmoothWeightedRoundRobinState;
}): WeightedPick<TCandidate> {
  const nextState: SmoothWeightedRoundRobinState = {};
  let selected: TCandidate | null = null;
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

  if (!selected) {
    throw new Error("Cannot select from an empty weighted candidate list.");
  }

  nextState[selected.id] = (nextState[selected.id] ?? 0) - totalWeight;
  return { candidate: selected, state: nextState };
}

function buildFailoverSequence({
  candidates,
  primary,
  stateAfterPrimary,
}: {
  candidates: PoolRouteCandidate[];
  primary: PoolRouteCandidate;
  stateAfterPrimary: SmoothWeightedRoundRobinState;
}): PoolRouteCandidate[] {
  const ordered = [primary];
  let remaining = candidates.filter((candidate) => candidate.poolMemberId !== primary.poolMemberId);
  let cursor = stateAfterPrimary;

  while (remaining.length > 0) {
    const pick = pickSmoothWeighted({
      candidates: remaining.map(weightedRouteCandidate),
      state: cursor,
    });
    ordered.push(pick.candidate.route);
    cursor = pick.state;
    remaining = remaining.filter(
      (candidate) => candidate.poolMemberId !== pick.candidate.route.poolMemberId,
    );
  }

  return ordered;
}

function weightedRouteCandidate(candidate: PoolRouteCandidate): WeightedRouteCandidate {
  return {
    id: candidate.poolMemberId,
    weight: candidate.weight,
    route: candidate,
  };
}

export function buildPoolRouteSequence({
  members,
  activeCliDeviceIds,
  now,
  state = {},
}: {
  members: PoolMemberRouteRow[];
  activeCliDeviceIds: Iterable<string>;
  now: Date;
  state?: SmoothWeightedRoundRobinState;
}): PoolRouteSequenceResult {
  const candidates = routablePoolMembers({ members, activeCliDeviceIds, now });
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: "NO_ROUTABLE_POOL_MEMBERS",
      failureClass: "no_routable_member",
      retryable: true,
    };
  }

  const primaryPick = pickSmoothWeighted({
    candidates: candidates.map(weightedRouteCandidate),
    state,
  });

  return {
    ok: true,
    candidates: buildFailoverSequence({
      candidates,
      primary: primaryPick.candidate.route,
      stateAfterPrimary: primaryPick.state,
    }),
    state: primaryPick.state,
  };
}

export async function selectPoolRouteSequence({
  poolId,
  activeCliDeviceIds,
  now = new Date(),
  state = {},
}: {
  poolId: string;
  activeCliDeviceIds: Iterable<string>;
  now?: Date;
  state?: SmoothWeightedRoundRobinState;
}): Promise<PoolRouteSequenceResult> {
  const rows = await prisma.poolMember.findMany({
    where: { poolId },
    orderBy: { id: "asc" },
    select: {
      id: true,
      poolId: true,
      discoveredModelId: true,
      ExecutionTarget: {
        select: {
          DiscoveredModel: {
            select: {
              id: true,
              published: true,
              upstreamModelId: true,
              Endpoint: {
                select: {
                  id: true,
                  slug: true,
                  published: true,
                  cliDeviceId: true,
                  status: true,
                  CliDevice: { select: { status: true } },
                },
              },
            },
          },
        },
      },
      weight: true,
      healthStatus: true,
      routingStatus: true,
      lastFailureClass: true,
      consecutiveRetryableFailures: true,
      lastFailureAt: true,
      nextRetryAt: true,
      halfOpenTrialStartedAt: true,
      DiscoveredModel: {
        select: {
          id: true,
          published: true,
          upstreamModelId: true,
          Endpoint: {
            select: {
              id: true,
              slug: true,
              published: true,
              cliDeviceId: true,
              status: true,
              CliDevice: { select: { status: true } },
            },
          },
        },
      },
    },
  });
  const members = rows.flatMap((row) => {
    const discoveredModel = row.ExecutionTarget?.DiscoveredModel ?? row.DiscoveredModel;
    if (!discoveredModel) return [];
    return [{ ...row, discoveredModelId: discoveredModel.id, DiscoveredModel: discoveredModel }];
  });

  return buildPoolRouteSequence({ members, activeCliDeviceIds, now, state });
}

/**
 * The ownership fence for relay outcome writes (success/failure). One rule for
 * every attempt, so a stale actor can never overwrite a successor's epoch:
 * - `trialStartedAt` set (the attempt claimed a half-open trial): the write
 *   applies only while the row is still HALF_OPEN with exactly that claim.
 * - `trialStartedAt` null (the attempt claimed nothing): the write applies only
 *   when the row holds no LIVE trial, so it never clears another request's
 *   claim. Anything else drops the outcome; the newer state wins.
 */
function poolMemberOutcomeFence(trialStartedAt: Date | null, now: Date) {
  if (trialStartedAt)
    return { healthStatus: "HALF_OPEN" as const, halfOpenTrialStartedAt: trialStartedAt };
  return {
    OR: [
      { healthStatus: { not: "HALF_OPEN" as const } },
      { halfOpenTrialStartedAt: null },
      { halfOpenTrialStartedAt: { lte: new Date(now.getTime() - POOL_MEMBER_HALF_OPEN_LEASE_MS) } },
    ],
  };
}

export async function recordPoolMemberRelayFailure({
  poolMemberId,
  failure,
  trialStartedAt,
  now = new Date(),
}: {
  poolMemberId: string;
  failure: RelayFailureClass;
  /** The half-open trial claim this attempt holds, if any (see the fence). */
  trialStartedAt: Date | null;
  now?: Date;
}): Promise<{ retryable: boolean; update: PoolMemberHealthUpdate | null }> {
  const failureClass = poolMemberFailureClassForRelayFailure(failure);
  if (!failureClass) return { retryable: false, update: null };

  // A relay `disconnected` outcome is the in-flight echo of a device detach,
  // and the detach's own fenced write (`disconnectCliDeviceAtGeneration`) is
  // the single owner of "device unavailable" member health. Writing it here
  // too, from a request that outlived its connection, would land after a
  // reconnect and re-impose a cooldown the fence exists to prevent. Give any
  // claimed trial back (its own timestamp fence) and record nothing.
  if (failureClass === "WEBSOCKET_DISCONNECTED") {
    if (trialStartedAt) await releasePoolMemberHalfOpenTrial({ poolMemberId, trialStartedAt });
    return { retryable: true, update: null };
  }

  // Read-modify-write, versioned on the fields the transition reads: a
  // concurrent writer makes the update match 0 rows and we re-read (bounded to
  // 3 rounds; a writer that loses all of them implies >= 3 committed failures,
  // so the member is already UNHEALTHY).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const member = await prisma.poolMember.findUnique({
      where: { id: poolMemberId },
      select: {
        healthStatus: true,
        lastFailureClass: true,
        consecutiveRetryableFailures: true,
        lastFailureAt: true,
        nextRetryAt: true,
        halfOpenTrialStartedAt: true,
      },
    });
    if (!member) return { retryable: true, update: null };
    const owned = trialStartedAt
      ? member.healthStatus === "HALF_OPEN" &&
        member.halfOpenTrialStartedAt?.getTime() === trialStartedAt.getTime()
      : !(
          member.healthStatus === "HALF_OPEN" &&
          poolMemberTrialLive(member.halfOpenTrialStartedAt, now)
        );
    if (!owned) return { retryable: true, update: null };

    const update = transitionPoolMemberHealthAfterRetryableFailure({
      member,
      failureClass,
      now,
    });
    const result = await prisma.poolMember.updateMany({
      where: {
        id: poolMemberId,
        healthStatus: member.healthStatus,
        halfOpenTrialStartedAt: member.halfOpenTrialStartedAt,
        consecutiveRetryableFailures: member.consecutiveRetryableFailures,
        ...(trialStartedAt ? {} : poolMemberOutcomeFence(null, now)),
      },
      data: update,
    });
    if (result.count === 1) return { retryable: true, update };
  }
  return { retryable: true, update: null };
}

export async function markPoolMemberRelaySuccess(
  poolMemberId: string,
  { trialStartedAt, now = new Date() }: { trialStartedAt: Date | null; now?: Date },
): Promise<void> {
  await prisma.poolMember.updateMany({
    where: { id: poolMemberId, ...poolMemberOutcomeFence(trialStartedAt, now) },
    data: resetPoolMemberHealth(),
  });
}

/**
 * Claims a due member for a single recovery probe.  The timestamp is a small
 * durable lease/fence: only its owner may later settle the probe result.
 */
export async function claimPoolMemberRecoveryTrial({
  poolMemberId,
  now = new Date(),
}: {
  poolMemberId: string;
  now?: Date;
}): Promise<Date | null> {
  const result = await prisma.poolMember.updateMany({
    where: {
      id: poolMemberId,
      routingStatus: "ACTIVE",
      weight: { gt: 0 },
      healthStatus: { in: ["DEGRADED", "UNHEALTHY"] },
      nextRetryAt: { lte: now },
    },
    data: beginPoolMemberHalfOpenTrial(now),
  });
  return result.count === 1 ? now : null;
}

/** Settle only the recovery lease we claimed, never a newer foreground write. */
export async function settlePoolMemberRecoveryTrial({
  poolMemberId,
  trialStartedAt,
  healthy,
  now = new Date(),
}: {
  poolMemberId: string;
  trialStartedAt: Date;
  healthy: boolean;
  now?: Date;
}): Promise<boolean> {
  const member = await prisma.poolMember.findUnique({
    where: { id: poolMemberId },
    select: {
      healthStatus: true,
      lastFailureClass: true,
      consecutiveRetryableFailures: true,
      lastFailureAt: true,
      nextRetryAt: true,
      halfOpenTrialStartedAt: true,
    },
  });
  if (
    member?.healthStatus !== "HALF_OPEN" ||
    member.halfOpenTrialStartedAt?.getTime() !== trialStartedAt.getTime()
  )
    return false;
  const data = healthy
    ? resetPoolMemberHealth()
    : transitionPoolMemberHealthAfterRetryableFailure({
        member,
        failureClass: "TRANSPORT",
        now,
      });
  const result = await prisma.poolMember.updateMany({
    where: { id: poolMemberId, healthStatus: "HALF_OPEN", halfOpenTrialStartedAt: trialStartedAt },
    data,
  });
  return result.count === 1;
}

export async function markPoolMemberHalfOpenTrial({
  poolMemberId,
  allowSingleDegradedFallback = false,
  now = new Date(),
}: {
  poolMemberId: string;
  /** Only the routing path for one configured pool member may enable this. */
  allowSingleDegradedFallback?: boolean;
  now?: Date;
}): Promise<number> {
  const result = await prisma.poolMember.updateMany({
    where: {
      id: poolMemberId,
      OR: [
        { healthStatus: "UNHEALTHY", nextRetryAt: { lte: now } },
        { healthStatus: "HALF_OPEN", halfOpenTrialStartedAt: null },
        // An expired lease is reclaimable; the new timestamp fences the old
        // holder's late release/settlement out (0 rows).
        {
          healthStatus: "HALF_OPEN",
          halfOpenTrialStartedAt: { lte: new Date(now.getTime() - POOL_MEMBER_HALF_OPEN_LEASE_MS) },
        },
        ...(allowSingleDegradedFallback
          ? [{ healthStatus: "DEGRADED" as const, nextRetryAt: { lte: now } }]
          : []),
      ],
      routingStatus: "ACTIVE",
      weight: { gt: 0 },
      ...(allowSingleDegradedFallback
        ? {
            // Recheck the complete configured pool atomically with the
            // claim. A protocol-compatible subset must never turn a
            // multi-member pool into a single-member degraded fallback.
            ModelPool: { PoolMembers: { none: { id: { not: poolMemberId } } } },
          }
        : {}),
    },
    data: beginPoolMemberHalfOpenTrial(now),
  });
  return result.count;
}

/**
 * Give back a half-open trial whose claimant sent nothing (for example the
 * #76 owner gate refused the send): the member is not at fault and becomes a
 * half-open candidate again. Fenced on the claim's own timestamp, so a later
 * claimant's (or the recovery sweeper's) trial is never cleared.
 */
export async function releasePoolMemberHalfOpenTrial({
  poolMemberId,
  trialStartedAt,
}: {
  poolMemberId: string;
  trialStartedAt: Date;
}): Promise<boolean> {
  const result = await prisma.poolMember.updateMany({
    where: { id: poolMemberId, healthStatus: "HALF_OPEN", halfOpenTrialStartedAt: trialStartedAt },
    data: { halfOpenTrialStartedAt: null },
  });
  return result.count === 1;
}

export async function resetPoolMemberHealthForDiscoveredModels(
  discoveredModelIds: string[],
): Promise<void> {
  if (discoveredModelIds.length === 0) return;
  await prisma.poolMember.updateMany({
    where: {
      OR: [
        {
          executionTargetId: { not: null },
          ExecutionTarget: { discoveredModelId: { in: discoveredModelIds } },
        },
        { executionTargetId: null, discoveredModelId: { in: discoveredModelIds } },
      ],
      routingStatus: { not: "DISABLED" },
    },
    data: resetPoolMemberHealth(),
  });
}

/**
 * A device's relay session went away: its members are circuit-opened for the
 * full health cooldown. `generation` is the device connection generation the
 * caller saw when it detached the session, and is required: the write is a
 * single conditional `updateMany` whose WHERE re-checks it on the device row,
 * so a stale disconnect (a close delivered after a successor's hello committed,
 * in this process or another replica) matches no member row instead of
 * re-imposing the cooldown over the successor's due-write. There is no
 * unfenced variant, so a disconnect can never be written without the fence.
 *
 * Isolation: the `EXISTS` on the device row is read from the statement's
 * snapshot, so on its own it does not stop a write that waited on a member row
 * lock across a successor's commit. The caller MUST run this inside the same
 * transaction as its fenced `cliDevice` update (device row locked first, then
 * member rows: DL-1 order L0 then L7); the successor's registration then waits
 * for that transaction and its due-write always runs after this write.
 */
export async function markPoolMembersForCliUnavailable({
  cliDeviceId,
  failureClass,
  generation,
  now = new Date(),
  db = prisma,
}: {
  cliDeviceId: string;
  failureClass: Extract<PoolMemberFailureClass, "WEBSOCKET_DISCONNECTED" | "STALE_SESSION">;
  generation: number;
  now?: Date;
  db?: Pick<typeof prisma, "poolMember">;
}): Promise<void> {
  const endpointScope = { cliDeviceId, CliDevice: { connectionGeneration: generation } };
  await db.poolMember.updateMany({
    where: {
      // Real failure provenance survives a disconnect: a member circuit-open
      // for a real upstream/transport failure with its cooldown still running
      // keeps that class and cooldown, so the reconnect due-write (which only
      // touches disconnect-class members) cannot cut it short. Members that
      // were healthy, degraded, or whose cooldown ended are opened as before.
      NOT: {
        healthStatus: "UNHEALTHY",
        nextRetryAt: { gt: now },
        // `not: null` keeps a NULL class out of the exclusion: SQL `NOT (NULL AND ..)`
        // would otherwise skip the row instead of opening it.
        lastFailureClass: { not: null, notIn: [...cliUnavailableFailureClasses] },
      },
      OR: [
        {
          executionTargetId: { not: null },
          ExecutionTarget: { DiscoveredModel: { Endpoint: endpointScope } },
        },
        {
          executionTargetId: null,
          DiscoveredModel: { Endpoint: endpointScope },
        },
      ],
    },
    data: transitionPoolMemberHealthForCliUnavailable({ failureClass, now }),
  });
}

/**
 * The ONE persistence point for "no session serves this device" (status + pool
 * member circuit-open). Returns false, writing nothing, when the device's
 * stored `connectionGeneration` is no longer `generation` (a successor hello
 * committed, in this process or another replica).
 *
 * One transaction, device row first: the fenced UPDATE locks `cli_device`, so
 * a successor's registration upsert waits for this transaction and its
 * reconnect due-write always runs after our member write; member rows are
 * locked only afterwards (DL-1 order L0 then L7). Two autocommit statements
 * would let the member UPDATE, blocked on a member row lock, land after the
 * successor committed (its `EXISTS` reads the statement snapshot).
 */
export async function disconnectCliDeviceAtGeneration({
  cliDeviceId,
  generation,
  cliStatus,
  failureClass,
  now = new Date(),
}: {
  cliDeviceId: string;
  generation: number;
  cliStatus: "DISCONNECTED" | "STALE";
  failureClass: Extract<PoolMemberFailureClass, "WEBSOCKET_DISCONNECTED" | "STALE_SESSION">;
  now?: Date;
}): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.cliDevice.updateMany({
      where: { id: cliDeviceId, connectionGeneration: generation },
      data: { status: cliStatus, lastDisconnectedAt: now },
    });
    if (claimed.count === 0) return false;
    await markPoolMembersForCliUnavailable({ cliDeviceId, failureClass, generation, now, db: tx });
    return true;
  });
}

/**
 * A CLI reconnected (hello accepted): members that were circuit-opened only
 * because the device was away become due now, so the recovery probe runs at
 * once instead of after the disconnect cooldown. Members whose last failure
 * was anything else (a real upstream/transport failure) keep their state.
 * Nothing is marked healthy here; the probe decides.
 *
 * The device-status fence already forces an executable/inventory path to
 * revisit the device before this runs, so this write needs no generation of
 * its own: it only moves `nextRetryAt` earlier for members that were opened by
 * a disconnect, and a late one cannot strand routing (the recovery scan and the
 * routing gate decide from the stored `CONNECTED` status and a live session).
 */
export async function markPoolMembersDueAfterCliReconnect({
  cliDeviceId,
  now = new Date(),
}: {
  cliDeviceId: string;
  now?: Date;
}): Promise<number> {
  const result = await prisma.poolMember.updateMany({
    where: {
      healthStatus: "UNHEALTHY",
      lastFailureClass: { in: ["WEBSOCKET_DISCONNECTED", "STALE_SESSION"] },
      nextRetryAt: { gt: now },
      OR: [
        {
          executionTargetId: { not: null },
          ExecutionTarget: { DiscoveredModel: { Endpoint: { cliDeviceId } } },
        },
        {
          executionTargetId: null,
          DiscoveredModel: { Endpoint: { cliDeviceId } },
        },
      ],
    },
    data: { nextRetryAt: now },
  });
  return result.count;
}
