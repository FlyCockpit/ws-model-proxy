import prisma, { Prisma } from "@ws-model-proxy/db";

/**
 * Saturation S-C: warm-session protection (redirect-only).
 *
 * A new session should not evict another user's recently used, expensive
 * prompt cache when another member (or, for `:external`, an external route)
 * can take it. No inference engine reports the age of individual KV entries,
 * so "warm" is estimated from the proxy's own routing records
 * (`CacheAffinityRecord`): counts, digests and timestamps only, never prompt
 * content. Traffic that bypasses the proxy is invisible, which is accepted.
 *
 * Protection only reorders or redirects. It never makes a request wait: when
 * nothing else can serve, the request is admitted on the protected member
 * whose protected set is oldest (then cheapest) and the engine's LRU evicts
 * as it would anyway.
 */

/** Token mode keeps this fraction of the KV budget as headroom. */
export const PROTECTION_KV_HEADROOM = 0.1;
/**
 * Upper bound on warm sessions read per user per member KV pool per request
 * (newest first). The window (default 5 min) and the size floor (default 8k
 * tokens) keep the real count far below it; the bound only caps a pathological
 * table. It is per (capacity, user, override value) because the sessions
 * protected within one budget bucket are a newest-first prefix of that bucket:
 * keeping each bucket's newest N leaves every bucket's prefix (up to N), the
 * user's largest share and the active-user count exact, and one busy user or
 * pool can never crowd another's sessions out of the read (a silently
 * truncated protection set would leave the pool looking unprotected).
 */
export const WARM_SESSION_QUERY_LIMIT = 2_000;

/**
 * llama.cpp restores evicted slot prompts from host RAM (`--cache-ram`), so
 * evicting a warm session there is cheap: protection is slot-based (its KV
 * budget is never used) and uses this fraction of the pool's window.
 */
export const LLAMA_CPP_WINDOW_FACTOR = 0.5;

/** Prisma `EngineKind` values (what `InferenceCapacity.engineKind` stores). */
export type ProtectionEngineKind =
  | "GENERIC"
  | "LLAMA_CPP"
  | "VLLM"
  | "SGLANG"
  | "OLLAMA"
  | "LM_STUDIO";

/**
 * The KV budget token mode may use: the reported one (vLLM, SGLang), never
 * llama.cpp's (slot-based), and none when unknown or not positive.
 */
export function protectionKvBudgetTokens(
  engineKind: ProtectionEngineKind | null | undefined,
  kvBudgetTokens: number | null | undefined,
): number | null {
  if (engineKind === "LLAMA_CPP") return null;
  return kvBudgetTokens !== null && kvBudgetTokens !== undefined && kvBudgetTokens > 0
    ? kvBudgetTokens
    : null;
}

/** The window one member's warm sessions are protected for (seconds, at least 1). */
export function protectionWindowSecondsFor(
  windowSeconds: number,
  engineKind: ProtectionEngineKind | null | undefined,
): number {
  return engineKind === "LLAMA_CPP"
    ? Math.max(1, Math.floor(windowSeconds * LLAMA_CPP_WINDOW_FACTOR))
    : windowSeconds;
}

export type ProtectionShareMode = "EQUAL_SHARE" | "FIRST_COME" | "FIXED_PERCENT";

export type WarmProtectionPolicy = {
  enabled: boolean;
  windowSeconds: number;
  minTokens: number;
  share: ProtectionShareMode;
  /** FIXED_PERCENT only (1..100). */
  fixedPercent: number | null;
};

/**
 * One warm session on a member KV pool: the footprint of the latest request
 * of one conversation on one execution target (every record one
 * `rememberAffinity` call writes shares its `lastUsedAt`).
 */
export type WarmSession = {
  userId: string;
  /** Milliseconds since the session was last used. */
  ageMs: number;
  /** Estimated prompt size of the session's latest request. */
  tokens: number;
  /** Owner or grant override: null = pool share mode, 0 = unprotected, 1..100 = percent. */
  overridePercent: number | null;
};

export type CapacityLoad = {
  /** Concurrency cap C (engine slots); null = unknown or unlimited. */
  slots: number | null;
  /** Active leases a. */
  active: number;
  /** KV budget K in tokens; null = unknown, which selects slot mode. */
  kvBudgetTokens: number | null;
};

export type MemberProtectionState = "FULL" | "PROTECTED" | "FREE";

export type ProtectionVerdict = {
  state: MemberProtectionState;
  /** Protected sessions on the member's KV pool (after the equity caps). */
  protectedSessions: number;
  /** W_protected: sum of the protected sessions' tokens. */
  protectedTokens: number;
  /** Age of the most recently used protected session; null when none. */
  newestProtectedAgeMs: number | null;
};

function eligible(session: WarmSession, policy: WarmProtectionPolicy) {
  return (
    session.ageMs <= policy.windowSeconds * 1000 &&
    session.tokens >= policy.minTokens &&
    session.overridePercent !== 0
  );
}

/**
 * The sessions of one member KV pool that are shielded from new sessions.
 *
 * Eligible sessions were used within the window, are at least `minTokens`,
 * and belong to a user who is not `UNPROTECTED`. An "active user" has at least
 * one eligible session; users with only small or idle sessions do not dilute
 * the others' shares. Each active user may keep, newest first:
 * - an owner/grant override percent (1..100) of the pool, per override value
 *   (each session carries its own pool's override; the user's total stays
 *   within the largest of their shares), else
 * - EQUAL_SHARE: max(1 session, pool / active users);
 * - FIXED_PERCENT: the pool's fixed percent;
 * - FIRST_COME: everything.
 * "Pool" is the KV budget in tokens (token mode) or the slot count (slot
 * mode). Over the share, the user's oldest sessions lose protection first.
 */
export function protectedWarmSessions(
  sessions: readonly WarmSession[],
  load: CapacityLoad,
  policy: WarmProtectionPolicy,
): WarmSession[] {
  if (!policy.enabled) return [];
  const byUser = new Map<string, WarmSession[]>();
  for (const session of sessions) {
    if (!eligible(session, policy)) continue;
    const own = byUser.get(session.userId) ?? [];
    own.push(session);
    byUser.set(session.userId, own);
  }
  const activeUsers = byUser.size;
  const tokenMode = load.kvBudgetTokens !== null && load.kvBudgetTokens > 0;
  const protectedSessions: WarmSession[] = [];
  const fractionFor = (override: number | null) =>
    override !== null
      ? override / 100
      : policy.share === "FIRST_COME"
        ? Number.POSITIVE_INFINITY
        : policy.share === "FIXED_PERCENT" && policy.fixedPercent !== null
          ? policy.fixedPercent / 100
          : 1 / activeUsers;
  // "Always at least one session" ("max(1 slot, K / active users)").
  const fits = (scope: { count: number; tokens: number }, fraction: number, tokens: number) => {
    if (scope.count === 0 || !Number.isFinite(fraction)) return true;
    if (tokenMode) return scope.tokens + tokens <= load.kvBudgetTokens! * fraction;
    return load.slots !== null && load.slots > 0
      ? scope.count < Math.max(1, Math.floor(load.slots * fraction))
      : true;
  };
  for (const own of byUser.values()) {
    own.sort((left, right) => left.ageMs - right.ageMs || right.tokens - left.tokens);
    // A session's override comes from its own pool (grant or owner percent), so
    // each override value is its own budget bucket: one pool's setting never
    // widens or narrows another pool's sessions. Across buckets the user stays
    // within the largest bucket's share, so buckets never multiply entitlement.
    const buckets = new Map<number | null, { count: number; tokens: number; closed: boolean }>();
    const user = { count: 0, tokens: 0, closed: false };
    const userFraction = Math.max(
      ...own.map(({ overridePercent }) => fractionFor(overridePercent)),
    );
    for (const session of own) {
      const bucket = buckets.get(session.overridePercent) ?? {
        count: 0,
        tokens: 0,
        closed: false,
      };
      buckets.set(session.overridePercent, bucket);
      if (user.closed || bucket.closed) continue;
      if (!fits(user, userFraction, session.tokens)) {
        user.closed = true;
        continue;
      }
      if (!fits(bucket, fractionFor(session.overridePercent), session.tokens)) {
        bucket.closed = true;
        continue;
      }
      for (const scope of [user, bucket]) {
        scope.count += 1;
        scope.tokens += session.tokens;
      }
      protectedSessions.push(session);
    }
  }
  return protectedSessions;
}

/**
 * State of one member for this request:
 * - FULL: a >= C;
 * - PROTECTED (only without an affinity hit on this member): not full, but
 *   admitting would displace protected sessions. Token mode (K known):
 *   W_protected + r > K x (1 - headroom). Slot mode: every idle slot (C - a)
 *   holds a protected session (distinct protected sessions, capped at C);
 * - FREE: otherwise, including an unknown C and K (nothing to reason about).
 */
export function memberProtectionVerdict({
  load,
  protectedSessions,
  requestTokens,
  affine,
}: {
  load: CapacityLoad;
  protectedSessions: readonly WarmSession[];
  requestTokens: number;
  affine: boolean;
}): ProtectionVerdict {
  const protectedTokens = protectedSessions.reduce((sum, session) => sum + session.tokens, 0);
  const newestProtectedAgeMs = protectedSessions.length
    ? Math.min(...protectedSessions.map(({ ageMs }) => ageMs))
    : null;
  const verdict = (state: MemberProtectionState): ProtectionVerdict => ({
    state,
    protectedSessions: protectedSessions.length,
    protectedTokens,
    newestProtectedAgeMs,
  });
  if (load.slots !== null && load.active >= load.slots) return verdict("FULL");
  // A continuation (affinity hit) is never redirected by protection.
  if (affine || protectedSessions.length === 0) return verdict("FREE");
  if (load.kvBudgetTokens !== null && load.kvBudgetTokens > 0)
    return verdict(
      protectedTokens + Math.max(0, requestTokens) >
        load.kvBudgetTokens * (1 - PROTECTION_KV_HEADROOM)
        ? "PROTECTED"
        : "FREE",
    );
  if (load.slots !== null && load.slots > 0) {
    const idle = load.slots - load.active;
    return verdict(Math.min(protectedSessions.length, load.slots) >= idle ? "PROTECTED" : "FREE");
  }
  return verdict("FREE");
}

/**
 * Admission order among PROTECTED members: the one whose protected set is
 * oldest (its most recent use is furthest back) first, then the cheapest
 * (fewest protected tokens). The engine's LRU evicts there, as it would anyway.
 */
export function compareProtectedMembers(left: ProtectionVerdict, right: ProtectionVerdict) {
  return (
    (right.newestProtectedAgeMs ?? 0) - (left.newestProtectedAgeMs ?? 0) ||
    left.protectedTokens - right.protectedTokens
  );
}

export type ProtectionRouteCandidate = { poolMemberId: string; affine: boolean };

export type ProtectionRouting = {
  /**
   * Full route order: every non-PROTECTED member in its original (affinity)
   * order, then PROTECTED members oldest/cheapest first. Used by every
   * admission round that may serve from a PROTECTED member.
   */
  order: string[];
  /**
   * Members of the first local admission. With an external plan and another
   * member that can serve (FREE, or the cache holder), PROTECTED members are
   * left out of it; without a plan it equals `order` (protection never
   * blocks).
   */
  initial: string[];
  /**
   * Decision step 4: an `:external` caller with a live external plan and only
   * PROTECTED (or PROTECTED + FULL) members goes external now with
   * `LOCAL_SATURATED_PROTECTED`. When that attempt does not dispatch, the
   * request is admitted over `order` with the full local budget.
   */
  externalFirst: boolean;
};

/**
 * Decision procedure after compatibility filtering and affinity ranking
 * (UNAVAILABLE members never get here):
 * 1-3. a FREE member or the cache holder exists: route there; PROTECTED
 *      members come last, and with an external plan they are left out of the
 *      first admission;
 * 4.   only PROTECTED, or PROTECTED + FULL: `:external` with a plan goes
 *      external now; otherwise admit on the oldest/cheapest PROTECTED member
 *      (it has an idle slot, so admission grants it at once, never queueing
 *      behind FULL members);
 * 5.   all FULL: queue as before (no PROTECTED member exists).
 */
export function protectionRouting({
  candidates,
  verdicts,
  externalPlan,
}: {
  candidates: readonly ProtectionRouteCandidate[];
  verdicts: ReadonlyMap<string, ProtectionVerdict>;
  externalPlan: boolean;
}): ProtectionRouting {
  const isProtected = (candidate: ProtectionRouteCandidate) =>
    !candidate.affine && verdicts.get(candidate.poolMemberId)?.state === "PROTECTED";
  const protectedMembers = candidates
    .filter(isProtected)
    .sort((left, right) =>
      compareProtectedMembers(verdicts.get(left.poolMemberId)!, verdicts.get(right.poolMemberId)!),
    );
  const others = candidates.filter((candidate) => !isProtected(candidate));
  const order = [...others, ...protectedMembers].map(({ poolMemberId }) => poolMemberId);
  if (protectedMembers.length === 0 || !externalPlan)
    return { order, initial: order, externalFirst: false };
  const canServeElsewhere = others.some(
    (candidate) =>
      candidate.affine || (verdicts.get(candidate.poolMemberId)?.state ?? "FREE") === "FREE",
  );
  if (canServeElsewhere)
    return {
      order,
      initial: others.map(({ poolMemberId }) => poolMemberId),
      externalFirst: false,
    };
  return { order, initial: order, externalFirst: true };
}

/** Inputs read from the database for one request. */
export type WarmProtectionSnapshot = {
  activeByCapacity: ReadonlyMap<string, number>;
  sessionsByCapacity: ReadonlyMap<string, readonly WarmSession[]>;
};

export interface WarmProtectionSource {
  load(input: {
    ownerId: string;
    capacityIds: readonly string[];
    policy: WarmProtectionPolicy;
  }): Promise<WarmProtectionSnapshot>;
}

type WarmSessionRow = {
  capacityId: string;
  userId: string;
  lastUsedAt: Date;
  tokens: number;
  overridePercent: number | null;
};

/**
 * Reads the warm set of the given member KV pools with one bounded,
 * non-locking query (indexed by `[executionTargetId, lastUsedAt]`). A session
 * is the set of records one request wrote on one target: they share tenant,
 * pool, target, binding and `lastUsedAt`. Its size is the largest
 * `estimatedTokens` among them (every record carries the whole prompt
 * estimate). Records from every pool of the owner count, since they share the
 * physical KV pool; each session's override comes from its own pool (the
 * tenant's grant, or the pool's owner percent when the tenant is the owner).
 *
 * Affinity records are written and expired on the application clock
 * (`lastUsedAt`, `expiresAt`), so the window is evaluated on the same clock.
 * It is a routing preference, not an admission deadline.
 */
export async function loadWarmSessions({
  ownerId,
  capacityIds,
  policy,
  now = new Date(),
  limitPerUser = WARM_SESSION_QUERY_LIMIT,
}: {
  ownerId: string;
  capacityIds: readonly string[];
  policy: Pick<WarmProtectionPolicy, "windowSeconds" | "minTokens">;
  now?: Date;
  limitPerUser?: number;
}): Promise<Map<string, WarmSession[]>> {
  const sessions = new Map<string, WarmSession[]>();
  if (capacityIds.length === 0) return sessions;
  const since = new Date(now.getTime() - policy.windowSeconds * 1000);
  const rows = await prisma.$queryRaw<WarmSessionRow[]>(Prisma.sql`
    WITH candidate AS (
      SELECT r.*, t."inferenceCapacityId" AS "capacityId"
        FROM cache_affinity_record r
        JOIN execution_target t ON t.id = r."executionTargetId"
       WHERE r."userId" = ${ownerId}
         AND t."userId" = ${ownerId}
         AND t."inferenceCapacityId" IN (${Prisma.join([...capacityIds])})
         AND r."lastUsedAt" >= ${since}
         AND r."expiresAt" > ${now}
         -- Every record of one request carries the request's whole estimate, so a
         -- record below the floor never changes a session's size or eligibility.
         AND r."estimatedTokens" >= ${policy.minTokens}
    ),
    session AS (
      -- An explicit conversation is one session: its (single, refreshed)
      -- conversation record, whatever else shares its timestamp.
      SELECT c."capacityId", c."tenantUserId", c."poolId", c."userId",
             c."lastUsedAt", c."estimatedTokens" AS tokens
        FROM candidate c
       WHERE c."conversationDigest" IS NOT NULL AND c."prefixDigest" IS NULL
      UNION ALL
      -- Prefix-only traffic: the prefix records one request wrote share
      -- tenant, pool, target, binding and lastUsedAt. A group that a
      -- conversation record of the same instant already covers is not repeated.
      SELECT c."capacityId", c."tenantUserId", c."poolId", c."userId",
             c."lastUsedAt", MAX(c."estimatedTokens") AS tokens
        FROM candidate c
       WHERE c."prefixDigest" IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM candidate v
            WHERE v."conversationDigest" IS NOT NULL AND v."prefixDigest" IS NULL
              AND v."tenantUserId" = c."tenantUserId" AND v."poolId" = c."poolId"
              AND v."executionTargetId" = c."executionTargetId"
              AND v."bindingDigest" = c."bindingDigest"
              AND v."lastUsedAt" = c."lastUsedAt")
       GROUP BY c."capacityId", c."tenantUserId", c."userId", c."poolId",
                c."executionTargetId", c."bindingDigest", c."lastUsedAt"
    ),
    scoped AS (
      SELECT s."capacityId", s."tenantUserId" AS "userId", s."lastUsedAt",
             s.tokens::int AS tokens,
             CASE WHEN s."tenantUserId" = s."userId"
                  THEN p."ownerProtectionPercent"
                  ELSE g."protectionOverridePercent" END AS "overridePercent"
        FROM session s
        JOIN model_pool p ON p.id = s."poolId"
        LEFT JOIN pool_grant g ON g."poolId" = s."poolId" AND g."granteeUserId" = s."tenantUserId"
       WHERE s.tokens >= ${policy.minTokens}
    ),
    ranked AS (
      SELECT scoped.*,
             ROW_NUMBER() OVER (
               PARTITION BY "capacityId", "userId", "overridePercent"
               ORDER BY "lastUsedAt" DESC, tokens DESC
             ) AS "rank"
        FROM scoped
       -- UNPROTECTED sessions are never shielded and never count: they must
       -- not use up the read bound either.
       WHERE "overridePercent" IS DISTINCT FROM 0
    )
    SELECT "capacityId", "userId", "lastUsedAt", tokens, "overridePercent"
      FROM ranked
     WHERE "rank" <= ${limitPerUser}
     ORDER BY "lastUsedAt" DESC
  `);
  for (const row of rows) {
    const list = sessions.get(row.capacityId) ?? [];
    list.push({
      userId: row.userId,
      ageMs: Math.max(0, now.getTime() - row.lastUsedAt.getTime()),
      tokens: Number(row.tokens),
      overridePercent: row.overridePercent === null ? null : Number(row.overridePercent),
    });
    sessions.set(row.capacityId, list);
  }
  return sessions;
}

/** Production source: active leases and warm sessions, plain reads only. */
export const warmProtectionSource: WarmProtectionSource = {
  async load({ ownerId, capacityIds, policy }) {
    const now = new Date();
    const [active, sessionsByCapacity] = await Promise.all([
      prisma.capacityLease.groupBy({
        by: ["capacityId"],
        where: { capacityId: { in: [...capacityIds] }, state: "ACTIVE", expiresAt: { gt: now } },
        _count: { _all: true },
      }),
      loadWarmSessions({ ownerId, capacityIds, policy, now }),
    ]);
    return {
      activeByCapacity: new Map(active.map((row) => [row.capacityId, row._count._all])),
      sessionsByCapacity,
    };
  },
};

export type ProtectionMemberInput = {
  poolMemberId: string;
  capacityId: string;
  /** Concurrency cap of the member's KV pool (`hardConcurrencyLimit`). */
  slots: number | null;
  /**
   * The capacity's reported KV budget in tokens (engine facts, protocol 2.7).
   * Null selects slot mode; llama.cpp is always slot mode.
   */
  kvBudgetTokens: number | null;
  /** The capacity's engine (null = unreported): llama.cpp gets a smaller window. */
  engineKind?: ProtectionEngineKind | null;
  affine: boolean;
  /** This request's prompt estimate r for the member. */
  requestTokens: number;
};

/** Verdict per pool member, from one snapshot of the members' KV pools. */
export async function assessWarmProtection({
  ownerId,
  policy,
  members,
  source,
}: {
  ownerId: string;
  policy: WarmProtectionPolicy;
  members: readonly ProtectionMemberInput[];
  source: WarmProtectionSource;
}): Promise<Map<string, ProtectionVerdict>> {
  const verdicts = new Map<string, ProtectionVerdict>();
  if (!policy.enabled || members.length === 0) return verdicts;
  const capacityIds = [...new Set(members.map(({ capacityId }) => capacityId))];
  const snapshot = await source.load({ ownerId, capacityIds, policy });
  for (const member of members) {
    const load: CapacityLoad = {
      slots: member.slots,
      active: snapshot.activeByCapacity.get(member.capacityId) ?? 0,
      kvBudgetTokens: protectionKvBudgetTokens(member.engineKind, member.kvBudgetTokens),
    };
    const protectedSessions = protectedWarmSessions(
      snapshot.sessionsByCapacity.get(member.capacityId) ?? [],
      load,
      // The query reads the pool's window; a member's engine may shorten it.
      {
        ...policy,
        windowSeconds: protectionWindowSecondsFor(policy.windowSeconds, member.engineKind),
      },
    );
    verdicts.set(
      member.poolMemberId,
      memberProtectionVerdict({
        load,
        protectedSessions,
        requestTokens: member.requestTokens,
        affine: member.affine,
      }),
    );
  }
  return verdicts;
}
