/**
 * Row → view mapping for pools (`contracts/pools.ts`) and callable IDs (`contracts/models.ts`).
 */
import {
  POOL_ADVANCED_COLUMNS,
  POOL_ADVANCED_OVERRIDES,
} from "@ws-model-proxy/config/pool-defaults";
import type { Prisma } from "@ws-model-proxy/db";
import type { z } from "zod";
import type { poolAdvancedViewSchema } from "../contracts/advanced";
import type { MEMBER_STATUS, poolMemberViewSchema, poolViewSchema } from "../contracts/pools";
import { embeddingContractSchema } from "./embedding-contract";
import { jsonObject, registryView } from "./registry-view";

export const MEMBER_INCLUDE = {
  RuntimeModel: {
    select: {
      upstreamModelId: true,
      runtimeId: true,
      retired: true,
      Runtime: {
        select: {
          slug: true,
          nodeId: true,
          Node: { select: { id: true, slug: true, userId: true } },
          Instances: {
            where: { OR: [{ desiredState: "RUNNING" }, { desiredState: null }] },
            select: {
              phase: true,
              Ranks: {
                where: { claim: "HELD" },
                select: { nodeId: true, Node: { select: { slug: true, userId: true } } },
              },
            },
          },
        },
      },
      Targets: { select: { health: true } },
    },
  },
  Share: { select: { Grantee: { select: { email: true } } } },
  ProviderModel: { select: { upstreamModelId: true, Target: { select: { health: true } } } },
} as const satisfies Prisma.PoolMemberInclude;
export type MemberRow = Prisma.PoolMemberGetPayload<{ include: typeof MEMBER_INCLUDE }>;

export const POOL_INCLUDE = {
  User: { select: { slug: true } },
  Routing: true,
  Fallback: true,
  Advanced: true,
  Sidecars: {
    include: { TargetPool: { select: { slug: true, User: { select: { slug: true } } } } },
    orderBy: { input: "asc" },
  },
  RoutingRules: { orderBy: { position: "asc" } },
  Members: {
    include: MEMBER_INCLUDE,
    orderBy: [{ kind: "asc" }, { cloudOrder: "asc" }, { createdAt: "asc" }],
  },
  _count: { select: { Shares: true } },
} as const satisfies Prisma.PoolInclude;
export type PoolRow = Prisma.PoolGetPayload<{ include: typeof POOL_INCLUDE }>;

type MemberStatus = (typeof MEMBER_STATUS)[number];
type TargetHealth = "UNKNOWN" | "HEALTHY" | "DEGRADED" | "HALF_OPEN" | "UNHEALTHY";
const HEALTH_RANK: Record<TargetHealth, number> = {
  HEALTHY: 0,
  DEGRADED: 1,
  HALF_OPEN: 2,
  UNKNOWN: 3,
  UNHEALTHY: 4,
};

function bestHealth(healths: readonly TargetHealth[]): TargetHealth {
  return healths.reduce<TargetHealth>(
    (best, health) => (HEALTH_RANK[health] < HEALTH_RANK[best] ? health : best),
    healths.length > 0 ? "UNHEALTHY" : "UNKNOWN",
  );
}

/** Derived (never stored, §3.9): what the member list shows. */
export function memberStatus(
  member: Pick<MemberRow, "kind" | "state" | "RuntimeModel">,
): MemberStatus {
  if (member.state === "DISABLED") return "disabled";
  if (member.kind === "CLOUD") return "cloud_standby";
  const model = member.RuntimeModel;
  if (!model || model.retired) return "unavailable";
  const phases = model.Runtime.Instances.map((instance) => instance.phase);
  if (phases.includes("READY")) return "serving";
  if (phases.includes("STARTING")) return "starting";
  return "unavailable";
}

export function memberView(member: MemberRow): z.infer<typeof poolMemberViewSchema> {
  const model = member.RuntimeModel;
  const instances = model?.Runtime.Instances ?? [];
  const health =
    member.kind === "CLOUD"
      ? (member.ProviderModel?.Target?.health ?? "UNKNOWN")
      : bestHealth((model?.Targets ?? []).map((target) => target.health));
  return {
    id: member.id,
    kind: member.kind,
    state: member.state,
    status: memberStatus(member),
    weight: member.weight,
    runtimeModelId: member.runtimeModelId,
    runtimeId: model?.runtimeId ?? null,
    runtimeSlug: model?.Runtime.slug ?? null,
    upstreamModelId: model?.upstreamModelId ?? member.ProviderModel?.upstreamModelId ?? "",
    shareId: member.shareId,
    contributorEmail: member.Share?.Grantee.email ?? null,
    providerModelId: member.providerModelId,
    cloudOrder: member.cloudOrder,
    health,
    live: {
      instances: instances.length,
      running: instances.filter((instance) => instance.phase === "READY").length,
      // TODO(lane A, hot path): queue depth and latency come from the relay's live state.
      waiting: 0,
      p95LatencyMs: null,
    },
  };
}

/**
 * Pool status for the Models page: the best of the LOCAL members routing may use (contributed
 * members are skipped while the owner routes to their own hardware only).
 */
export function poolStatus(
  members: ReadonlyArray<Pick<MemberRow, "kind" | "state" | "RuntimeModel" | "shareId">>,
  ownHardwareOnly = false,
): "serving" | "starting" | "unavailable" {
  const statuses = members
    .filter((member) => !(ownHardwareOnly && member.shareId))
    .map(memberStatus);
  if (statuses.includes("serving")) return "serving";
  if (statuses.includes("starting")) return "starting";
  return "unavailable";
}

export type FallbackMode = "OFF" | "OWNER" | "OWNER_AND_SHARES";

/** `owner/pool`, plus `owner/pool:external` when the pool's cloud mode covers this caller. */
export function callableIdsFor(input: {
  ownerSlug: string;
  poolSlug: string;
  mode: FallbackMode;
  callerIsOwner: boolean;
  /** Cloud egress is on for this server (`cloudEgressEnabled`). */
  cloudEnabled: boolean;
}): string[] {
  const base = `${input.ownerSlug}/${input.poolSlug}`;
  const covered =
    input.cloudEnabled &&
    (input.mode === "OWNER_AND_SHARES" || (input.mode === "OWNER" && input.callerIsOwner));
  return covered ? [base, `${base}:external`] : [base];
}

const { affinity, protection, ...flatOverrides } = POOL_ADVANCED_OVERRIDES;

export function poolAdvancedView(
  advanced: PoolRow["Advanced"],
): z.infer<typeof poolAdvancedViewSchema> {
  const overrides = jsonObject(advanced?.overrides);
  return {
    ...registryView(POOL_ADVANCED_COLUMNS, {
      maxWaitMs: advanced?.maxWaitMs ?? null,
      contextCeiling: advanced?.contextCeiling ?? null,
      contextMargin: advanced?.contextMargin ?? null,
    }),
    affinity: registryView(affinity, jsonObject(overrides.affinity)),
    protection: registryView(protection, jsonObject(overrides.protection)),
    ...registryView(flatOverrides, overrides),
  } as z.infer<typeof poolAdvancedViewSchema>;
}

function ruleView(rule: PoolRow["RoutingRules"][number]) {
  const labels =
    rule.labels === null ? undefined : (jsonObject(rule.labels) as Record<string, string>);
  return {
    id: rule.id,
    position: rule.position,
    createdAt: rule.createdAt.toISOString(),
    rule: {
      metric: rule.metric,
      ...(labels ? { labels } : {}),
      aggregate: rule.aggregate as "max" | "min" | "avg",
      op: rule.op as ">" | ">=" | "<" | "<=",
      threshold: rule.threshold,
      effect: rule.effect as "full" | "avoid",
      memberId: rule.exclude ? null : rule.memberId,
      excludeMemberId: rule.exclude ? rule.memberId : null,
    },
  };
}

export type Traffic = { requests: number; errors: number; sparkline: number[] };
export const EMPTY_TRAFFIC: Traffic = {
  requests: 0,
  errors: 0,
  sparkline: Array.from({ length: 24 }, () => 0),
};

export function poolView(
  pool: PoolRow,
  callerId: string,
  traffic: Traffic = EMPTY_TRAFFIC,
  cloudEnabled = false,
): z.infer<typeof poolViewSchema> {
  const mode = pool.Fallback?.mode ?? "OFF";
  const embedding = embeddingContractSchema.safeParse(pool.Fallback?.embeddingContract);
  const runsOn = new Map<
    string,
    { nodeId: string; slug: string; mine: boolean; instances: number }
  >();
  for (const member of pool.Members) {
    const runtime = member.RuntimeModel?.Runtime;
    if (!runtime || member.state === "DISABLED") continue;
    for (const instance of runtime.Instances) {
      if (instance.phase !== "READY") continue;
      const nodes =
        instance.Ranks.length > 0
          ? instance.Ranks.flatMap((rank) =>
              rank.nodeId && rank.Node
                ? [{ id: rank.nodeId, slug: rank.Node.slug, userId: rank.Node.userId }]
                : [],
            )
          : runtime.Node
            ? [runtime.Node]
            : [];
      for (const node of nodes) {
        const entry = runsOn.get(node.id) ?? {
          nodeId: node.id,
          slug: node.slug,
          mine: node.userId === callerId,
          instances: 0,
        };
        entry.instances += 1;
        runsOn.set(node.id, entry);
      }
    }
  }
  return {
    id: pool.id,
    slug: pool.slug,
    name: pool.name,
    description: pool.description,
    modelType: pool.modelType,
    callableIds: callableIdsFor({
      ownerSlug: pool.User.slug,
      poolSlug: pool.slug,
      mode,
      callerIsOwner: pool.userId === callerId,
      cloudEnabled,
    }),
    owner: { userId: pool.userId, slug: pool.User.slug, you: pool.userId === callerId },
    routing: {
      priorityClass: pool.Routing?.priorityClass ?? "NORMAL",
      concurrencyLimit: pool.Routing?.concurrencyLimit ?? null,
      keptSlots: pool.Routing?.keptSlots ?? 0,
      borrowKept: pool.Routing?.borrowKept ?? true,
      ownHardwareOnly: pool.Routing?.ownHardwareOnly ?? false,
    },
    cloud: {
      mode,
      embeddingContract: embedding.success ? embedding.data : null,
      paidWarmProtection: pool.Fallback?.paidWarmProtection ?? false,
      ownKeyEquivalentModel: pool.Fallback?.ownKeyEquivalentModel ?? null,
    },
    sidecars: pool.Sidecars.map((sidecar) => ({
      input: sidecar.input,
      targetPoolId: sidecar.targetPoolId,
      targetCallableId: `${sidecar.TargetPool.User.slug}/${sidecar.TargetPool.slug}`,
      prompt: sidecar.prompt,
      timeoutMs: sidecar.timeoutMs,
      maxAssets: sidecar.maxAssets,
    })),
    advanced: poolAdvancedView(pool.Advanced),
    rules: pool.RoutingRules.map(ruleView),
    members: pool.Members.map(memberView),
    sharesCount: pool._count.Shares,
    runsOn: [...runsOn.values()],
    traffic24h: traffic,
  };
}
