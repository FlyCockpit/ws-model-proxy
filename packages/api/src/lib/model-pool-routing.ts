import prisma from "@ws-model-proxy/db";

export const POOL_MEMBER_UNHEALTHY_AFTER_RETRYABLE_FAILURES = 3;
export const POOL_MEMBER_HEALTH_COOLDOWN_MS = 60_000;
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

function effectiveHealthStatusForRouting(
  member: Pick<PoolMemberRouteRow, "healthStatus" | "nextRetryAt" | "halfOpenTrialStartedAt">,
  now: Date,
  allowDegraded: boolean,
): "HEALTHY" | "HALF_OPEN" | null {
  if (member.healthStatus === "HEALTHY" || member.healthStatus === "UNKNOWN") {
    return "HEALTHY";
  }
  if (member.healthStatus === "HALF_OPEN") {
    return member.halfOpenTrialStartedAt === null ? "HALF_OPEN" : null;
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
  }) as PoolMemberRouteRow[];

  return buildPoolRouteSequence({ members, activeCliDeviceIds, now, state });
}

export async function recordPoolMemberRelayFailure({
  poolMemberId,
  failure,
  now = new Date(),
}: {
  poolMemberId: string;
  failure: RelayFailureClass;
  now?: Date;
}): Promise<{ retryable: boolean; update: PoolMemberHealthUpdate | null }> {
  const failureClass = poolMemberFailureClassForRelayFailure(failure);
  if (!failureClass) return { retryable: false, update: null };

  const member = (await prisma.poolMember.findUnique({
    where: { id: poolMemberId },
    select: {
      healthStatus: true,
      lastFailureClass: true,
      consecutiveRetryableFailures: true,
      lastFailureAt: true,
      nextRetryAt: true,
      halfOpenTrialStartedAt: true,
    },
  })) as PoolMemberHealthSnapshot | null;
  if (!member) return { retryable: true, update: null };

  const update = transitionPoolMemberHealthAfterRetryableFailure({
    member,
    failureClass,
    now,
  });
  await prisma.poolMember.update({
    where: { id: poolMemberId },
    data: update,
    select: { id: true },
  });

  return { retryable: true, update };
}

export async function markPoolMemberRelaySuccess(poolMemberId: string): Promise<void> {
  await prisma.poolMember.update({
    where: { id: poolMemberId },
    data: resetPoolMemberHealth(),
    select: { id: true },
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
  const member = (await prisma.poolMember.findUnique({
    where: { id: poolMemberId },
    select: {
      healthStatus: true,
      lastFailureClass: true,
      consecutiveRetryableFailures: true,
      lastFailureAt: true,
      nextRetryAt: true,
      halfOpenTrialStartedAt: true,
    },
  })) as PoolMemberHealthSnapshot | null;
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

export async function markPoolMembersForCliUnavailable({
  cliDeviceId,
  failureClass,
  now = new Date(),
}: {
  cliDeviceId: string;
  failureClass: Extract<PoolMemberFailureClass, "WEBSOCKET_DISCONNECTED" | "STALE_SESSION">;
  now?: Date;
}): Promise<void> {
  await prisma.poolMember.updateMany({
    where: {
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
    data: transitionPoolMemberHealthForCliUnavailable({ failureClass, now }),
  });
}
