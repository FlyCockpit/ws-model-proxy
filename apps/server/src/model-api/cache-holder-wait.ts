import type { AffinityDecision } from "./cache-affinity.js";
import { cacheHolderWaitMs, type PrefillSpeedSource } from "./prefill-estimator.js";

/**
 * Saturation S-A: wait for the cache holder.
 *
 * Affinity alone only reorders candidates, so a continuation whose prefix is
 * warm on a busy member A lands on cold member B the moment B frees, even if A
 * frees 200 ms later. The plan below defers every non-holder candidate by the
 * cache-holder wait (`notBefore`, enforced by the capacity store on the
 * database clock), so B is granted only if A is still busy when the window
 * ends. Without a real affinity hit nothing is deferred (today's behaviour).
 */
export type CacheHolderPlan = {
  /** Pool members holding the matched prefix: never deferred. */
  holderMemberIds: ReadonlySet<string>;
  /** Spill-over window in milliseconds (> 0). */
  windowMs: number;
};

type RouteCandidate = { poolMemberId: string; executionTargetId: string | undefined };

/**
 * Pool members with a real affinity hit as good as the best one: the deepest
 * continuation prefix match, or (when no prefix matched) a conversation match.
 */
export function cacheHolderMemberIds(
  decision: AffinityDecision,
  candidates: readonly RouteCandidate[],
): Set<string> {
  const depth = (candidate: RouteCandidate) =>
    candidate.executionTargetId ? (decision.prefixDepths[candidate.executionTargetId] ?? 0) : 0;
  const bestDepth = Math.max(0, ...candidates.map(depth));
  return new Set(
    candidates
      .filter((candidate) =>
        bestDepth > 0
          ? depth(candidate) === bestDepth
          : candidate.executionTargetId !== undefined &&
            decision.conversationMatches[candidate.executionTargetId] === true,
      )
      .map(({ poolMemberId }) => poolMemberId),
  );
}

/**
 * Builds the spill-over plan for one pool request, or null when nothing should
 * be deferred: no affinity decision, no real hit, every candidate is a holder,
 * or the pool turned the wait off (`cacheHolderWaitMs = 0`). The wait is
 * sized from the best-ranked holder (candidates are in route order).
 */
export async function planCacheHolderWait({
  decision,
  candidates,
  poolOverrideMs,
  speedSource,
}: {
  decision: AffinityDecision | null;
  candidates: readonly RouteCandidate[];
  poolOverrideMs: number | null | undefined;
  speedSource: PrefillSpeedSource;
}): Promise<CacheHolderPlan | null> {
  if (!decision || candidates.length < 2 || poolOverrideMs === 0) return null;
  const holderMemberIds = cacheHolderMemberIds(decision, candidates);
  if (holderMemberIds.size === 0 || holderMemberIds.size === candidates.length) return null;
  const primary = candidates.find(({ poolMemberId }) => holderMemberIds.has(poolMemberId));
  const primaryTargetId = primary?.executionTargetId;
  const prefixTokens = primaryTargetId ? decision.prefixTokens?.[primaryTargetId] : undefined;
  let tokensPerSecond: number | undefined;
  if ((poolOverrideMs === null || poolOverrideMs === undefined) && primaryTargetId) {
    try {
      tokensPerSecond = await speedSource.tokensPerSecond(primaryTargetId);
    } catch {
      tokensPerSecond = undefined;
    }
  }
  const windowMs = cacheHolderWaitMs({ poolOverrideMs, prefixTokens, tokensPerSecond });
  return windowMs > 0 ? { holderMemberIds, windowMs } : null;
}

/**
 * Remaining spill-over delay for one candidate of an admission round started
 * `elapsedMs` after the request's first local admission. Holders, rounds
 * without a holder among their candidates, and elapsed windows are not
 * deferred. Retry rounds therefore reuse the original window, never restart it.
 */
export function spillDelayMs(
  plan: CacheHolderPlan | null,
  poolMemberId: string,
  holderInRound: boolean,
  elapsedMs: number,
): number | undefined {
  if (!plan || !holderInRound || plan.holderMemberIds.has(poolMemberId)) return undefined;
  const remaining = Math.ceil(plan.windowMs - Math.max(0, elapsedMs));
  return remaining > 0 ? remaining : undefined;
}

/**
 * Shortened (`:external`) local wait for a round started `elapsedMs` after the
 * first local admission: the ORIGINAL external deadline, first-spill-instant +
 * min(B, E), minus the time already spent past it. A retry round therefore
 * never waits another full E (no N x E total).
 */
export function remainingShortenedWaitBudget(
  shortenedBudgetMs: number,
  spillWindowMs: number,
  elapsedMs: number,
): number {
  return Math.max(0, Math.floor(shortenedBudgetMs - Math.max(0, elapsedMs - spillWindowMs)));
}

/** Telemetry outcome of the served member (extends PREDICTED_MATCH / NO_MATCH / DISABLED). */
export function cacheHolderOutcome(
  plan: CacheHolderPlan | null,
  servedPoolMemberId: string,
): "HOLDER_WAITED" | "HOLDER_SPILLED" | null {
  if (!plan) return null;
  return plan.holderMemberIds.has(servedPoolMemberId) ? "HOLDER_WAITED" : "HOLDER_SPILLED";
}
