import { ORPCError } from "@orpc/server";
import { POOL_ADVANCED_COLUMNS } from "@ws-model-proxy/config/pool-defaults";
import prisma, { Prisma } from "@ws-model-proxy/db";
import { FenceSetChangedError } from "@ws-model-proxy/db/capacity-lock-order";
import type { z } from "zod";
import { contractProcedure, type SignedInContext } from "../contract-procedure";
import type { poolAdvancedPatchSchema } from "../contracts/advanced";
import { poolsContract as c, type routingRulesSchema } from "../contracts/pools";
import { callableIdOf } from "../lib/access-views";
import { type CallerActor, callerActor } from "../lib/caller-actor";
import { cloudEgressEnabled } from "../lib/cloud-egress";
import { graphDelete, graphWrite, modelTargetFences, poolTargetFences } from "../lib/graph-write";
import { readLiveLoad } from "../lib/live-load";
import { canUseHolders, modelNameClashes, refuseCallableIdClash } from "../lib/model-names";
import { memberLatencyP95, poolTraffic } from "../lib/overview-summary";
import { invalidatePoolRouting } from "../lib/pool-routing-invalidation";
import {
  callableIdsFor,
  MEMBER_INCLUDE,
  type MembersLive,
  memberView,
  POOL_INCLUDE,
  type PoolRow,
  poolView,
  type Traffic,
} from "../lib/pool-views";
import { isUniqueViolation, notFound, refuse, refuseAbout } from "../lib/refuse";
import { applyJsonPatch, jsonObject } from "../lib/registry-view";
import type { Tx } from "../lib/runtime-store";
import { modelAliasesRouter } from "./aliases";

type AdvancedPatch = z.infer<typeof poolAdvancedPatchSchema>;
type RoutingRules = z.infer<typeof routingRulesSchema>;
type ModelType = "LLM" | "EMBEDDINGS" | "TRANSCRIPTION";
type MemberRef = { runtimeModelId: string } | { runtimeId: string; model: string };
type SidecarPatch = {
  input: "IMAGE" | "AUDIO" | "VIDEO";
  targetPoolId: string | null;
  prompt?: string | null;
  timeoutMs?: number | null;
  maxAssets?: number | null;
};
type RoutingPatch = {
  priorityClass?: "BACKGROUND" | "NORMAL" | "HIGH";
  concurrencyLimit?: number | null;
  keptSlots?: number;
  borrowKept?: boolean;
};

function userIdOf(context: SignedInContext): string {
  return context.session.user.id;
}

/** Hourly request counts of the last 24 h (agent tests excluded), from the usage rollup. */
function trafficOf(ownerId: string, poolIds: string[]): Promise<Map<string, Traffic>> {
  return poolTraffic(ownerId, poolIds, "24h");
}

async function ownedPoolRow(userId: string, poolId: string): Promise<PoolRow> {
  const pool = await prisma.pool.findFirst({
    where: { id: poolId, userId },
    include: POOL_INCLUDE,
  });
  if (!pool) throw notFound("That pool does not exist.");
  return pool;
}

/** Live member state: the relay's in-memory engine load and each member's recent p95. */
async function membersLive(
  context: SignedInContext,
  ownerId: string,
  pools: readonly PoolRow[],
): Promise<MembersLive> {
  // Only the owner's own runtimes: a contributed member's queue is the contributor's engine
  // (their other traffic included), so it stays unknown here.
  const instanceIds = pools.flatMap((pool) =>
    pool.Members.flatMap((member) =>
      member.shareId === null
        ? (member.RuntimeModel?.Runtime.Instances.map((instance) => instance.id) ?? [])
        : [],
    ),
  );
  return {
    load: readLiveLoad(context.services?.liveLoad, instanceIds),
    p95: await memberLatencyP95(
      ownerId,
      pools.map((pool) => pool.id),
    ),
  };
}

async function ownedPoolView(context: SignedInContext, poolId: string) {
  const userId = userIdOf(context);
  const pool = await ownedPoolRow(userId, poolId);
  const [traffic, live] = await Promise.all([
    trafficOf(userId, [pool.id]),
    membersLive(context, userId, [pool]),
  ]);
  return poolView(pool, userId, traffic.get(pool.id), cloudEgressEnabled(), live);
}

async function audit(
  db: Tx,
  input: {
    ownerId: string;
    actor: CallerActor;
    poolId: string;
    action: string;
    after?: unknown;
  },
) {
  await db.auditEvent.create({
    data: {
      userId: input.ownerId,
      actor: input.actor.actor,
      actorUserId: input.actor.actorUserId,
      agentTokenId: input.actor.agentTokenId,
      mcpGrantId: input.actor.mcpGrantId,
      action: input.action,
      resourceType: "pool",
      resourceId: input.poolId,
      after: (input.after ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

/** The pool owner's own served model behind a member reference. */
async function resolveOwnModel(db: Tx, userId: string, ref: MemberRef) {
  const model = await db.runtimeModel.findFirst({
    where:
      "runtimeModelId" in ref
        ? { id: ref.runtimeModelId, userId }
        : { runtimeId: ref.runtimeId, upstreamModelId: ref.model, userId },
    select: { id: true, type: true, retired: true },
  });
  if (!model)
    throw refuse(
      "not_your_runtime",
      "Only your own served models can be added; share holders add theirs with contribute.",
    );
  return model;
}

function assertType(poolType: ModelType, modelType: ModelType, subjectId: string): void {
  if (poolType !== modelType)
    throw refuseAbout(
      "model_type_mismatch",
      subjectId,
      "This model's type does not match the pool's type.",
    );
}

/**
 * The caller's served-model ids behind member references (plain reads; checked again on write).
 * Another user's id is left out: it is refused when the member is added, and its fences are
 * never taken.
 */
async function referencedModelIds(db: Tx, userId: string, refs: readonly MemberRef[]) {
  const byRuntime = refs.flatMap((ref) =>
    "runtimeId" in ref ? [{ runtimeId: ref.runtimeId, upstreamModelId: ref.model }] : [],
  );
  const direct = refs.flatMap((ref) => ("runtimeModelId" in ref ? [ref.runtimeModelId] : []));
  if (byRuntime.length === 0 && direct.length === 0) return [];
  const resolved = await db.runtimeModel.findMany({
    where: {
      userId,
      OR: [...(direct.length ? [{ id: { in: direct } }] : []), ...byRuntime],
    },
    select: { id: true },
  });
  return resolved.map((model) => model.id);
}

/**
 * The caller's provider models among `ids` (plain read; checked again on write). Another user's
 * id is left out: replaceCloudMembers refuses it, and its fences are never taken.
 */
async function ownProviderModelIds(db: Tx, userId: string, ids: readonly string[]) {
  if (ids.length === 0) return [];
  const models = await db.providerModel.findMany({
    where: { id: { in: [...ids] }, userId },
    select: { id: true },
  });
  return models.map((model) => model.id);
}

async function addOwnMembers(
  db: Tx,
  pool: { id: string; userId: string; modelType: ModelType },
  refs: MemberRef[],
) {
  for (const ref of refs) {
    const model = await resolveOwnModel(db, pool.userId, ref);
    assertType(pool.modelType, model.type, model.id);
    if (model.retired)
      throw new ORPCError("BAD_REQUEST", {
        message: "This model is no longer served by its runtime.",
      });
    await db.poolMember.upsert({
      where: { poolId_runtimeModelId: { poolId: pool.id, runtimeModelId: model.id } },
      create: { poolId: pool.id, kind: "LOCAL", runtimeModelId: model.id },
      update: {},
    });
  }
}

const SIDECAR_TARGET_TYPE = { IMAGE: "LLM", VIDEO: "LLM", AUDIO: "TRANSCRIPTION" } as const;

async function applySidecars(
  db: Tx,
  pool: { id: string; userId: string },
  sidecars: SidecarPatch[],
) {
  for (const sidecar of sidecars) {
    if (sidecar.targetPoolId === null) {
      await db.poolSidecar.deleteMany({ where: { poolId: pool.id, input: sidecar.input } });
      continue;
    }
    if (sidecar.targetPoolId === pool.id)
      throw refuseAbout("sidecar_chain", pool.id, "A pool cannot be its own sidecar.");
    const target = await db.pool.findFirst({
      where: {
        id: sidecar.targetPoolId,
        OR: [
          { userId: pool.userId },
          { Shares: { some: { granteeUserId: pool.userId, canUse: true } } },
        ],
      },
      select: {
        id: true,
        modelType: true,
        Sidecars: { where: { input: sidecar.input }, select: { id: true } },
      },
    });
    if (!target) throw notFound("That sidecar pool does not exist.");
    if (target.modelType !== SIDECAR_TARGET_TYPE[sidecar.input])
      throw refuseAbout(
        "model_type_mismatch",
        target.id,
        "Images and video go to an LLM pool; audio goes to a transcription pool.",
      );
    // No chains: the target has no sidecar for this input, and nothing feeds this pool one.
    const feeds = await db.poolSidecar.count({
      where: { targetPoolId: pool.id, input: sidecar.input },
    });
    if (target.Sidecars.length > 0 || feeds > 0)
      throw refuseAbout("sidecar_chain", target.id, "Sidecar pools cannot be chained.");
    // Absent keeps the stored value (null clears it).
    const changes = {
      ...(sidecar.prompt !== undefined ? { prompt: sidecar.prompt } : {}),
      ...(sidecar.timeoutMs !== undefined ? { timeoutMs: sidecar.timeoutMs } : {}),
      ...(sidecar.maxAssets !== undefined ? { maxAssets: sidecar.maxAssets } : {}),
    };
    await db.poolSidecar.upsert({
      where: { poolId_input: { poolId: pool.id, input: sidecar.input } },
      create: {
        poolId: pool.id,
        input: sidecar.input,
        targetPoolId: target.id,
        prompt: sidecar.prompt ?? null,
        timeoutMs: sidecar.timeoutMs ?? null,
        maxAssets: sidecar.maxAssets ?? null,
      },
      update: { targetPoolId: target.id, ...changes },
    });
  }
}

async function applyRouting(db: Tx, poolId: string, routing: RoutingPatch | undefined) {
  if (!routing) return;
  const data = Object.fromEntries(
    Object.entries(routing).filter(([, value]) => value !== undefined),
  ) as RoutingPatch;
  // Kept slots beyond the pool's own cap could never be used by the pool, yet would still be
  // held back from other owners (no borrowing): refuse them, as the limits redesign did.
  const stored = await db.poolRouting.findUnique({
    where: { poolId },
    select: { concurrencyLimit: true, keptSlots: true },
  });
  const keptSlots = data.keptSlots ?? stored?.keptSlots ?? 0;
  const concurrencyLimit =
    data.concurrencyLimit !== undefined
      ? data.concurrencyLimit
      : (stored?.concurrencyLimit ?? null);
  const touchesSlots = data.keptSlots !== undefined || data.concurrencyLimit !== undefined;
  if (touchesSlots && concurrencyLimit !== null && keptSlots > concurrencyLimit)
    throw new ORPCError("BAD_REQUEST", {
      message: "Kept slots cannot exceed the pool's requests-at-once limit.",
    });
  await db.poolRouting.upsert({ where: { poolId }, create: { poolId, ...data }, update: data });
}

async function applyAdvanced(db: Tx, poolId: string, patch: AdvancedPatch | undefined) {
  if (!patch) return;
  const stored = await db.poolAdvanced.findUnique({ where: { poolId } });
  const columns: Record<string, number | null> = {};
  for (const key of Object.keys(POOL_ADVANCED_COLUMNS) as Array<
    keyof typeof POOL_ADVANCED_COLUMNS
  >) {
    const value = patch[key];
    if (value !== undefined) columns[key] = value;
  }
  const ceiling =
    columns.contextCeiling !== undefined
      ? columns.contextCeiling
      : (stored?.contextCeiling ?? null);
  const margin =
    columns.contextMargin !== undefined ? columns.contextMargin : (stored?.contextMargin ?? null);
  if (ceiling !== null && margin !== null && margin >= ceiling)
    throw new ORPCError("BAD_REQUEST", {
      message: "The context margin must be smaller than the context ceiling.",
    });
  const current = jsonObject(stored?.overrides);
  let overrides = current;
  if (patch.overrides) {
    const { affinity, protection, ...flat } = patch.overrides;
    overrides = applyJsonPatch(current, flat);
    for (const [group, groupPatch] of [
      ["affinity", affinity],
      ["protection", protection],
    ] as const) {
      if (!groupPatch) continue;
      const merged = applyJsonPatch(jsonObject(current[group]), groupPatch);
      if (Object.keys(merged).length === 0) delete overrides[group];
      else overrides[group] = merged;
    }
  }
  const data = { ...columns, overrides: overrides as Prisma.InputJsonValue };
  await db.poolAdvanced.upsert({ where: { poolId }, create: { poolId, ...data }, update: data });
}

async function replaceRules(db: Tx, poolId: string, rules: RoutingRules) {
  const memberIds = [
    ...new Set(
      rules
        .flatMap((rule) => [rule.memberId, rule.excludeMemberId])
        .filter((id): id is string => typeof id === "string"),
    ),
  ];
  if (memberIds.length > 0) {
    const members = await db.poolMember.count({
      where: { id: { in: memberIds }, poolId, kind: "LOCAL" },
    });
    if (members !== memberIds.length)
      throw new ORPCError("BAD_REQUEST", {
        message: "A rule names a member that is not a local member of this pool.",
      });
  }
  await db.poolRoutingRule.deleteMany({ where: { poolId } });
  if (rules.length > 0)
    await db.poolRoutingRule.createMany({
      data: rules.map((rule, position) => ({
        poolId,
        position,
        metric: rule.metric,
        labels: (rule.labels ?? undefined) as Prisma.InputJsonValue | undefined,
        aggregate: rule.aggregate,
        op: rule.op,
        threshold: rule.threshold,
        effect: rule.effect,
        memberId: rule.excludeMemberId ?? rule.memberId ?? null,
        exclude: Boolean(rule.excludeMemberId),
      })),
    });
}

async function replaceCloudMembers(
  db: Tx,
  pool: { id: string; userId: string; modelType: ModelType },
  cloudMembers: Array<{ providerModelId: string }>,
) {
  const ids = cloudMembers.map((member) => member.providerModelId);
  if (new Set(ids).size !== ids.length)
    throw new ORPCError("BAD_REQUEST", { message: "A provider model is listed twice." });
  const models = await db.providerModel.findMany({
    where: { id: { in: ids }, userId: pool.userId, enabled: true, deletedAt: null },
    select: { id: true, type: true },
  });
  const byId = new Map(models.map((model) => [model.id, model]));
  for (const id of ids) {
    const model = byId.get(id);
    if (!model)
      throw new ORPCError("BAD_REQUEST", {
        message: "Only provider models a person enabled can be cloud members.",
      });
    assertType(pool.modelType, model.type, model.id);
  }
  // Keep the rows (and their state) of members that stay; move them in place. The order
  // index is unique and not deferrable, so a move never lands on an occupied slot.
  const existing = await db.poolMember.findMany({
    where: { poolId: pool.id, kind: "CLOUD" },
    select: { id: true, providerModelId: true, cloudOrder: true },
  });
  const wanted = new Set(ids);
  const dropped = existing.filter((member) => !wanted.has(member.providerModelId ?? ""));
  if (dropped.length > 0)
    await db.poolMember.deleteMany({ where: { id: { in: dropped.map((member) => member.id) } } });
  const kept = existing.filter((member) => wanted.has(member.providerModelId ?? ""));
  const slotOf = new Map(kept.map((member) => [member.id, member.cloudOrder ?? -1]));
  const occupant = new Map(kept.map((member) => [member.cloudOrder ?? -1, member.id]));
  const recreate: string[] = [];
  const freeSlot = () => {
    for (let slot = 15; slot >= 0; slot--) if (!occupant.has(slot)) return slot;
    return null;
  };
  for (const [order, providerModelId] of ids.entries()) {
    const member = kept.find((row) => row.providerModelId === providerModelId);
    if (member && slotOf.get(member.id) === order) continue;
    const blocker = occupant.get(order);
    if (blocker !== undefined) {
      const slot = freeSlot();
      occupant.delete(order);
      if (slot === null) {
        // All 16 slots taken: the blocker is recreated at its new place below.
        await db.poolMember.delete({ where: { id: blocker } });
        recreate.push(blocker);
        slotOf.delete(blocker);
      } else {
        await db.poolMember.update({ where: { id: blocker }, data: { cloudOrder: slot } });
        occupant.set(slot, blocker);
        slotOf.set(blocker, slot);
      }
    }
    if (member && !recreate.includes(member.id)) {
      occupant.delete(slotOf.get(member.id) ?? -1);
      await db.poolMember.update({ where: { id: member.id }, data: { cloudOrder: order } });
      slotOf.set(member.id, order);
    } else {
      const created = await db.poolMember.create({
        data: { poolId: pool.id, kind: "CLOUD", providerModelId, cloudOrder: order },
        select: { id: true },
      });
      slotOf.set(created.id, order);
    }
    occupant.set(order, member && !recreate.includes(member.id) ? member.id : "new");
  }
}

/** Human-only setters (the contract binding refuses everyone else) share this. */
async function humanSetter(
  context: SignedInContext,
  poolId: string,
  action: string,
  write: (tx: Tx) => Promise<unknown>,
  after: unknown,
) {
  const userId = userIdOf(context);
  const pool = await prisma.pool.findFirst({ where: { id: poolId, userId }, select: { id: true } });
  if (!pool) throw notFound("That pool does not exist.");
  const actor = callerActor(context.auth, userId);
  await graphWrite(
    [userId],
    async (tx) => {
      await write(tx);
      await audit(tx, { ownerId: userId, actor, poolId, action, after });
    },
    (tx) => poolTargetFences(tx, poolId),
  );
  return ownedPoolView(context, poolId);
}

/** Shares of the pool that hold an own-key choice (the grantee's consent to the equivalent). */
const OWN_KEY_CHOSEN = (poolId: string) => ({
  poolId,
  OR: [{ ownKeyProviderModelId: { not: null } }, { ownKeyProtocolAdaptation: true }],
});

/**
 * A grantee's own-key choice consents to the equivalent model the owner named when it was
 * made: a changed (or cleared) equivalent clears every share's choice in the same transaction.
 * Share writes need the grantees' owner fences too; a choice made between the read of that set
 * and the fences grows it, and the transaction restarts with the larger set.
 */
async function setOwnKeyEquivalent(context: SignedInContext, poolId: string, model: string | null) {
  const userId = userIdOf(context);
  const pool = await prisma.pool.findFirst({ where: { id: poolId, userId }, select: { id: true } });
  if (!pool) throw notFound("That pool does not exist.");
  const actor = callerActor(context.auth, userId);
  const granteesOf = async (db: Pick<Tx, "share">) =>
    (
      await db.share.findMany({ where: OWN_KEY_CHOSEN(poolId), select: { granteeUserId: true } })
    ).map((share) => share.granteeUserId);
  // graphWrite re-reads this list on every attempt.
  const owners = [userId, ...(await granteesOf(prisma))];
  await graphWrite(
    owners,
    async (tx) => {
      // Under the pool owner's fence no choice is made (setOwnKey takes it): the set is final.
      const missing = (await granteesOf(tx)).filter((grantee) => !owners.includes(grantee));
      if (missing.length > 0) {
        owners.push(...missing);
        throw new FenceSetChangedError();
      }
      const before = await tx.poolFallback.findUnique({
        where: { poolId },
        select: { ownKeyEquivalentModel: true },
      });
      await tx.poolFallback.upsert({
        where: { poolId },
        create: { poolId, ownKeyEquivalentModel: model },
        update: { ownKeyEquivalentModel: model },
      });
      if ((before?.ownKeyEquivalentModel ?? null) !== model)
        await tx.share.updateMany({
          where: OWN_KEY_CHOSEN(poolId),
          data: { ownKeyProviderModelId: null, ownKeyProtocolAdaptation: false },
        });
      await audit(tx, {
        ownerId: userId,
        actor,
        poolId,
        action: "pool.fallback.own_key_equivalent",
        after: { model },
      });
    },
    (tx) => poolTargetFences(tx, poolId),
  );
  return ownedPoolView(context, poolId);
}

/**
 * Claims the callable ID `owner/slug` (lib/model-names.ts) for the pool's owner and every
 * can-use share holder: callable IDs always win over aliases, so a slug that made it equal to
 * one of their aliases would silently take that alias's traffic. The transaction holds the owner
 * fences of `fenced`; a holder outside it (a share created since the plan) retries the attempt.
 */
async function claimPoolCallableId(
  tx: Tx,
  pool: { ownerUserId: string; poolId: string | null },
  slug: string,
  fenced: ReadonlySet<string>,
) {
  const owner = await tx.user.findUnique({
    where: { id: pool.ownerUserId },
    select: { slug: true },
  });
  // No owner row: the pool write that follows fails on its reference, so nothing is named.
  if (!owner) return;
  const holders = pool.poolId
    ? (await canUseHolders(tx, [pool.poolId])).map((share) => share.granteeUserId)
    : [];
  if (holders.some((userId) => !fenced.has(userId))) throw new FenceSetChangedError();
  const callableIds = [callableIdOf(owner.slug, slug)];
  refuseCallableIdClash(
    await modelNameClashes(
      tx,
      [pool.ownerUserId, ...holders].map((userId) => ({ userId, callableIds })),
    ),
    pool.ownerUserId,
  );
}

function rethrowSlugTaken(error: unknown): never {
  if (isUniqueViolation(error))
    throw refuse("slug_taken", "You already have a pool with this slug.");
  throw error;
}

export const poolsRouter = {
  aliases: modelAliasesRouter,
  list: contractProcedure(c.list).handler(async ({ context }) => {
    const userId = userIdOf(context);
    const [pools, shares] = await Promise.all([
      prisma.pool.findMany({
        where: { userId },
        include: POOL_INCLUDE,
        orderBy: { createdAt: "asc" },
      }),
      prisma.share.findMany({
        where: { granteeUserId: userId },
        select: {
          poolId: true,
          canUse: true,
          canContribute: true,
          Owner: { select: { email: true } },
          Pool: {
            select: {
              slug: true,
              modelType: true,
              User: { select: { slug: true } },
              Fallback: { select: { mode: true } },
            },
          },
        },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    const [traffic, live] = await Promise.all([
      trafficOf(
        userId,
        pools.map((pool) => pool.id),
      ),
      membersLive(context, userId, pools),
    ]);
    return {
      pools: pools.map((pool) =>
        poolView(pool, userId, traffic.get(pool.id), cloudEgressEnabled(), live),
      ),
      sharedWithMe: shares.map((share) => ({
        poolId: share.poolId,
        callableIds: share.canUse
          ? callableIdsFor({
              ownerSlug: share.Pool.User.slug,
              poolSlug: share.Pool.slug,
              mode: share.Pool.Fallback?.mode ?? "OFF",
              callerIsOwner: false,
              cloudEnabled: cloudEgressEnabled(),
            })
          : [`${share.Pool.User.slug}/${share.Pool.slug}`],
        ownerEmail: share.Owner.email,
        modelType: share.Pool.modelType,
        canUse: share.canUse,
        canContribute: share.canContribute,
      })),
    };
  }),

  get: contractProcedure(c.get).handler(async ({ input, context }) =>
    ownedPoolView(context, input.poolId),
  ),

  history: {
    list: contractProcedure(c.history.list).handler(async ({ input, context }) => {
      const userId = userIdOf(context);
      const pool = await prisma.pool.findFirst({
        where: { id: input.poolId, userId },
        select: { id: true },
      });
      if (!pool) throw notFound("That pool does not exist.");
      const rows = await prisma.auditEvent.findMany({
        where: { userId, resourceType: "pool", resourceId: pool.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
      const page = rows.slice(0, input.limit);
      return {
        items: page.map((row) => ({
          id: row.id,
          createdAt: row.createdAt.toISOString(),
          actor: {
            actor: row.actor,
            userId: row.actorUserId,
            agentTokenId: row.agentTokenId,
            label: null,
          },
          action: row.action,
          before: row.before,
          after: row.after,
        })),
        nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
      };
    }),
  },

  create: contractProcedure(c.create).handler(async ({ input, context }) => {
    const userId = userIdOf(context);
    const actor = callerActor(context.auth, userId);
    let poolId: string;
    try {
      poolId = await graphWrite(
        [userId],
        async (tx) => {
          await claimPoolCallableId(
            tx,
            { ownerUserId: userId, poolId: null },
            input.slug,
            new Set([userId]),
          );
          const pool = await tx.pool.create({
            data: {
              userId,
              slug: input.slug,
              name: input.name,
              description: input.description || null,
              modelType: input.type,
            },
            select: { id: true, userId: true, modelType: true },
          });
          await addOwnMembers(tx, pool, input.members ?? []);
          await applyRouting(tx, pool.id, input.routing);
          await applyAdvanced(tx, pool.id, input.advanced);
          await applySidecars(tx, pool, input.sidecars ?? []);
          await audit(tx, {
            ownerId: userId,
            actor,
            poolId: pool.id,
            action: "pool.create",
            after: { slug: input.slug, type: input.type, note: input.note ?? null },
          });
          return pool.id;
        },
        async (tx) =>
          modelTargetFences(tx, {
            runtimeModelIds: await referencedModelIds(tx, userId, input.members ?? []),
          }),
      );
    } catch (error) {
      rethrowSlugTaken(error);
    }
    return ownedPoolView(context, poolId);
  }),

  update: contractProcedure(c.update).handler(async ({ input, context }) => {
    const userId = userIdOf(context);
    const actor = callerActor(context.auth, userId);
    const pool = await prisma.pool.findFirst({
      where: { id: input.poolId, userId },
      select: { id: true, userId: true, modelType: true, slug: true },
    });
    if (!pool) throw notFound("That pool does not exist.");
    const { rules, ...advancedPatch } = input.advanced ?? {};
    // Removing a contributed member writes the contributor's graph too (owner fence).
    const removed = input.members?.remove?.length
      ? await prisma.poolMember.findMany({
          where: { id: { in: input.members.remove }, poolId: pool.id },
          select: { RuntimeModel: { select: { userId: true } } },
        })
      : [];
    const owners = new Set([
      userId,
      ...removed.flatMap((member) => (member.RuntimeModel ? [member.RuntimeModel.userId] : [])),
    ]);
    try {
      await graphWrite(
        // A slug may rename a name in every can-use holder's namespace: their fences too.
        // Whether it changes is decided under the fences (a rename may have landed since).
        async (tx) => {
          if (input.slug === undefined) return owners;
          const holders = await canUseHolders(tx, [pool.id]);
          for (const share of holders) owners.add(share.granteeUserId);
          return owners;
        },
        async (tx) => {
          const current =
            input.slug === undefined
              ? null
              : await tx.pool.findFirst({
                  where: { id: pool.id, userId },
                  select: { slug: true },
                });
          if (input.slug !== undefined && !current) throw notFound("That pool does not exist.");
          const newSlug = current && current.slug !== input.slug ? input.slug : undefined;
          if (newSlug)
            await claimPoolCallableId(
              tx,
              { ownerUserId: userId, poolId: pool.id },
              newSlug,
              owners,
            );
          const fields = {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(newSlug !== undefined ? { slug: newSlug } : {}),
            ...(input.description !== undefined ? { description: input.description || null } : {}),
          };
          if (Object.keys(fields).length > 0)
            await tx.pool.update({ where: { id: pool.id }, data: fields });
          if (input.members?.remove?.length)
            await tx.poolMember.deleteMany({
              where: { id: { in: input.members.remove }, poolId: pool.id },
            });
          await addOwnMembers(tx, pool, input.members?.add ?? []);
          for (const set of input.members?.set ?? []) {
            const updated = await tx.poolMember.updateMany({
              where: { id: set.memberId, poolId: pool.id },
              data: {
                ...(set.weight !== undefined ? { weight: set.weight } : {}),
                ...(set.state !== undefined ? { state: set.state } : {}),
              },
            });
            if (updated.count === 0) throw notFound("That member is not in this pool.");
          }
          if (input.cloudMembers) await replaceCloudMembers(tx, pool, input.cloudMembers);
          await applyRouting(tx, pool.id, input.routing);
          if (input.cloud?.embeddingContract !== undefined) {
            const embeddingContract =
              input.cloud.embeddingContract === null
                ? Prisma.DbNull
                : (input.cloud.embeddingContract as Prisma.InputJsonValue);
            await tx.poolFallback.upsert({
              where: { poolId: pool.id },
              create: { poolId: pool.id, embeddingContract },
              update: { embeddingContract },
            });
          }
          if (input.advanced) await applyAdvanced(tx, pool.id, advancedPatch);
          if (rules) await replaceRules(tx, pool.id, rules);
          await applySidecars(tx, pool, input.sidecars ?? []);
          const { poolId: _poolId, ...after } = input;
          await audit(tx, {
            ownerId: userId,
            actor,
            poolId: pool.id,
            action: "pool.update",
            after,
          });
        },
        // Members, routing and advanced limits change the admission views of the pool's
        // targets, and of the targets of the models and provider models being added.
        async (tx) => [
          ...(await poolTargetFences(tx, pool.id)),
          ...(await modelTargetFences(tx, {
            runtimeModelIds: await referencedModelIds(tx, userId, input.members?.add ?? []),
            providerModelIds: await ownProviderModelIds(
              tx,
              userId,
              (input.cloudMembers ?? []).map((member) => member.providerModelId),
            ),
          })),
        ],
      );
    } catch (error) {
      rethrowSlugTaken(error);
    }
    if (rules || input.members?.remove?.length)
      await invalidatePoolRouting(context.services, [pool.id]);
    return ownedPoolView(context, pool.id);
  }),

  delete: contractProcedure(c.delete).handler(async ({ input, context }) => {
    const userId = userIdOf(context);
    const actor = callerActor(context.auth, userId);
    const pool = await prisma.pool.findFirst({
      where: { id: input.poolId, userId },
      select: { id: true, slug: true },
    });
    if (!pool) throw notFound("That pool does not exist.");
    // Shares, contributed members, key entries and other owners' sidecars go with it.
    await graphDelete({ userId, poolIds: [pool.id] }, async (tx) => {
      await tx.pool.deleteMany({ where: { id: pool.id, userId } });
      await audit(tx, {
        ownerId: userId,
        actor,
        poolId: pool.id,
        action: "pool.delete",
        after: { slug: pool.slug },
      });
    });
    return { ok: true as const };
  }),

  cloud: {
    setMode: contractProcedure(c.cloud.setMode).handler(async ({ input, context }) =>
      humanSetter(
        context,
        input.poolId,
        "pool.fallback.mode",
        (tx) =>
          tx.poolFallback.upsert({
            where: { poolId: input.poolId },
            create: { poolId: input.poolId, mode: input.mode },
            update: { mode: input.mode },
          }),
        { mode: input.mode },
      ),
    ),
    setPaidWarmProtection: contractProcedure(c.cloud.setPaidWarmProtection).handler(
      async ({ input, context }) =>
        humanSetter(
          context,
          input.poolId,
          "pool.fallback.paid_warm_protection",
          (tx) =>
            tx.poolFallback.upsert({
              where: { poolId: input.poolId },
              create: { poolId: input.poolId, paidWarmProtection: input.enabled },
              update: { paidWarmProtection: input.enabled },
            }),
          { enabled: input.enabled },
        ),
    ),
    setOwnKeyEquivalent: contractProcedure(c.cloud.setOwnKeyEquivalent).handler(
      async ({ input, context }) => {
        if (
          input.model !== null &&
          (input.model.trim() === "" || input.model.trim() !== input.model)
        )
          throw new ORPCError("BAD_REQUEST", {
            message: "Give the model id without surrounding spaces.",
          });
        return setOwnKeyEquivalent(context, input.poolId, input.model);
      },
    ),
  },

  routing: {
    setOwnHardwareOnly: contractProcedure(c.routing.setOwnHardwareOnly).handler(
      async ({ input, context }) =>
        humanSetter(
          context,
          input.poolId,
          "pool.routing.own_hardware_only",
          (tx) =>
            tx.poolRouting.upsert({
              where: { poolId: input.poolId },
              create: { poolId: input.poolId, ownHardwareOnly: input.enabled },
              update: { ownHardwareOnly: input.enabled },
            }),
          { enabled: input.enabled },
        ),
    ),
  },

  members: {
    addContributed: contractProcedure(c.members.addContributed).handler(
      async ({ input, context }) => {
        const userId = userIdOf(context);
        const share = await prisma.share.findFirst({
          where: { poolId: input.poolId, granteeUserId: userId },
          select: {
            id: true,
            canContribute: true,
            ownerUserId: true,
            Pool: { select: { modelType: true, Routing: { select: { ownHardwareOnly: true } } } },
          },
        });
        if (!share) throw notFound("That pool is not shared with you.");
        if (!share.canContribute)
          throw refuseAbout(
            "contribute_not_allowed",
            input.poolId,
            "This share does not allow contributing.",
          );
        if (share.Pool.Routing?.ownHardwareOnly)
          throw refuseAbout(
            "own_hardware_only",
            input.poolId,
            "The owner routes this pool to their own hardware only.",
          );
        const model = await prisma.runtimeModel.findFirst({
          where: { id: input.runtimeModelId, userId },
          select: { id: true, type: true, retired: true },
        });
        if (!model)
          throw refuseAbout(
            "not_your_runtime",
            input.runtimeModelId,
            "You can contribute only your own served models.",
          );
        assertType(share.Pool.modelType, model.type, model.id);
        if (model.retired)
          throw new ORPCError("BAD_REQUEST", {
            message: "This model is no longer served by its runtime.",
          });
        const actor = callerActor(context.auth, userId);
        let memberId: string;
        try {
          memberId = await graphWrite(
            // A contributed member links the owner's and the contributor's graphs.
            [share.ownerUserId, userId],
            async (tx) => {
              const member = await tx.poolMember.create({
                data: {
                  poolId: input.poolId,
                  kind: "LOCAL",
                  runtimeModelId: model.id,
                  shareId: share.id,
                },
                select: { id: true },
              });
              await audit(tx, {
                ownerId: share.ownerUserId,
                actor,
                poolId: input.poolId,
                action: "pool.member.contribute",
                after: { memberId: member.id, runtimeModelId: model.id, note: input.note ?? null },
              });
              return member.id;
            },
            (tx) => modelTargetFences(tx, { runtimeModelIds: [model.id] }),
          );
        } catch (error) {
          if (isUniqueViolation(error))
            throw new ORPCError("CONFLICT", { message: "This model is already in the pool." });
          throw error;
        }
        const member = await prisma.poolMember.findUniqueOrThrow({
          where: { id: memberId },
          include: MEMBER_INCLUDE,
        });
        return memberView(member);
      },
    ),

    removeContributed: contractProcedure(c.members.removeContributed).handler(
      async ({ input, context }) => {
        const userId = userIdOf(context);
        // The contributor (own members only) or the pool owner.
        const member = await prisma.poolMember.findFirst({
          where: {
            id: input.memberId,
            shareId: { not: null },
            OR: [{ Share: { granteeUserId: userId } }, { Pool: { userId } }],
          },
          select: { id: true, poolId: true, Pool: { select: { userId: true } } },
        });
        if (!member) throw notFound("That contributed member does not exist.");
        const actor = callerActor(context.auth, userId);
        await graphDelete(
          { userId: member.Pool.userId, poolMemberIds: [member.id] },
          async (tx) => {
            await tx.poolMember.delete({ where: { id: member.id } });
            await audit(tx, {
              ownerId: member.Pool.userId,
              actor,
              poolId: member.poolId,
              action: "pool.member.withdraw",
              after: { memberId: member.id, note: input.note ?? null },
            });
          },
        );
        // Rules naming the member went with it.
        await invalidatePoolRouting(context.services, [member.poolId]);
        return { ok: true as const };
      },
    ),
  },

  rules: {
    delete: contractProcedure(c.rules.delete).handler(async ({ input, context }) => {
      const userId = userIdOf(context);
      const rule = await prisma.poolRoutingRule.findFirst({
        where: { id: input.ruleId, Pool: { userId } },
        select: { id: true, poolId: true },
      });
      if (!rule) throw notFound("That rule does not exist.");
      const actor = callerActor(context.auth, userId);
      await graphWrite([userId], async (tx) => {
        await tx.poolRoutingRule.delete({ where: { id: rule.id } });
        await audit(tx, {
          ownerId: userId,
          actor,
          poolId: rule.poolId,
          action: "pool.rule.delete",
          after: { ruleId: rule.id },
        });
      });
      await invalidatePoolRouting(context.services, [rule.poolId]);
      return { ok: true as const };
    }),
  },
};
