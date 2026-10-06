/**
 * Relative KV eviction feedback. Effective K is used by the PROTECTED
 * threshold (equity shares stay on the reported K) and by residency
 * placement. A lower K makes a member PROTECTED sooner and redirects NEW
 * sessions, which reduces evictions until evidence stops and the cut recovers
 * linearly. The 50% cap bounds over-reaction; slow (30 minute) recovery and
 * small (5%) steps damp flapping. A single 5% step decays in 3 minutes at
 * `0.5 / 30 min` (not “fully in 30 minutes”).
 *
 * Each session is counted once per row lifetime (bounded set of 16). The
 * first unique miss only arms; a later unique miss steps only when
 * misses/continuations in that window are at least 15%. Alternating two
 * sessions cannot walk K to the floor. Hits are continuations too, so a
 * healthy cache keeps the ratio low. An engine restart or prefix-cache
 * counter drop is not eviction: tips older than the reset are ignored.
 *
 * The miss denominator is the reusable prompt prefix, not prompt+completion
 * (reasoning inflates the old footprint). Endpoint prefix-cache counters
 * include bypass traffic and are not themselves evidence. Reported budgets
 * are positive int32 token counts; malformed budgets fail closed to slot
 * mode. Corrupt cuts are clamped before decay; NaN means the bounded maximum
 * cut. Future/invalid timestamps do not decay.
 */
export const KV_EVICTION_STEP = 0.05;
export const KV_EVICTION_MAX_CUT = 0.5;
export const KV_EVICTION_RECOVERY_MS = 1_800_000;
export const KV_EVICTION_MAX_OBSERVATIONS_PER_FLUSH = 10;
export const KV_EVICTION_SESSION_CAP = 16;
export const KV_EVICTION_MISS_RATIO = 0.15;
export const KV_EVICTION_FLOOR_FRACTION = 1 - KV_EVICTION_MAX_CUT;
export const KV_EVICTION_DECAY_PER_MS = KV_EVICTION_MAX_CUT / KV_EVICTION_RECOVERY_MS;

export type KvEvictionContinuationKind = "hit" | "miss";

export type KvEvictionState = {
  cutFraction: number;
  observedAt: Date;
  expiresAt?: Date;
  sessionIds?: string[];
  missCount?: number;
  continuationCount?: number;
};

/** Writers treat an expired row as absent, matching readers (`expiresAt > now`). */
function liveKvEvictionState(
  state: KvEvictionState | null | undefined,
  now: Date,
): KvEvictionState | null {
  if (!state) return null;
  const expiry = state.expiresAt?.getTime();
  if (expiry !== undefined && (!Number.isFinite(expiry) || expiry <= now.getTime())) return null;
  return state;
}

function boundedCut(cut: number): number {
  return Number.isNaN(cut) ? KV_EVICTION_MAX_CUT : Math.min(KV_EVICTION_MAX_CUT, Math.max(0, cut));
}

/** Distinct session ids, insertion order, at most one flush's worth. */
export function boundedKvEvictionSessions(sessionIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const sessionId of sessionIds) {
    if (!sessionId || sessionId.length > 128 || seen.has(sessionId)) continue;
    seen.add(sessionId);
    out.push(sessionId);
    if (out.length >= KV_EVICTION_MAX_OBSERVATIONS_PER_FLUSH) break;
  }
  return out;
}

/** Admission freeze: ignore stored cuts and use the reported K. */
export function kvEvictionCutsApply(evictionFeedbackEnabled?: boolean): boolean {
  return evictionFeedbackEnabled !== false;
}

export function effectiveKvCut(
  state: KvEvictionState | null | undefined,
  now: Date,
  evictionFeedbackEnabled?: boolean,
): number {
  if (!kvEvictionCutsApply(evictionFeedbackEnabled) || !state) return 0;
  const elapsed = now.getTime() - state.observedAt.getTime();
  return Math.max(
    0,
    boundedCut(state.cutFraction) -
      KV_EVICTION_DECAY_PER_MS * (Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0),
  );
}

function isActiveCut(state: KvEvictionState, now: Date): boolean {
  const liveCut = effectiveKvCut(state, now);
  const elapsed = now.getTime() - state.observedAt.getTime();
  return liveCut > 0 && !(Number.isFinite(elapsed) && elapsed >= KV_EVICTION_RECOVERY_MS);
}

function emptyKvEvictionState(now: Date): KvEvictionState {
  return {
    cutFraction: 0,
    observedAt: now,
    sessionIds: [],
    missCount: 0,
    continuationCount: 0,
  };
}

function sessionSet(state: KvEvictionState | null | undefined): string[] {
  if (state?.sessionIds && state.sessionIds.length > 0) return [...state.sessionIds];
  return [];
}

/** Expired or fully recovered stored cuts start a new row lifetime. */
function liveOrArmedKvEvictionState(
  state: KvEvictionState | null | undefined,
  now: Date,
): KvEvictionState | null {
  const live = liveKvEvictionState(state, now);
  if (!live) return null;
  if (isActiveCut(live, now) || boundedCut(live.cutFraction) === 0) return live;
  return null;
}

export function applyKvEvictionContinuations(
  state: KvEvictionState | null,
  items: readonly { sessionId: string; kind: KvEvictionContinuationKind }[],
  now: Date,
): KvEvictionState {
  const live = liveOrArmedKvEvictionState(state, now);
  let current: KvEvictionState = live
    ? {
        cutFraction: live.cutFraction,
        observedAt: live.observedAt,
        expiresAt: live.expiresAt,
        sessionIds: sessionSet(live),
        missCount: live.missCount ?? 0,
        continuationCount: live.continuationCount ?? 0,
      }
    : emptyKvEvictionState(now);

  let accepted = 0;
  for (const item of items) {
    if (accepted >= KV_EVICTION_MAX_OBSERVATIONS_PER_FLUSH) break;
    const sessionId = item.sessionId;
    if (!sessionId || sessionId.length > 128) continue;
    const known = current.sessionIds ?? [];
    if (known.includes(sessionId) || known.length >= KV_EVICTION_SESSION_CAP) continue;
    accepted += 1;
    known.push(sessionId);
    const continuationCount = (current.continuationCount ?? 0) + 1;
    const missCount = (current.missCount ?? 0) + (item.kind === "miss" ? 1 : 0);
    const ratio = missCount / continuationCount;
    const shouldStep = item.kind === "miss" && missCount >= 2 && ratio >= KV_EVICTION_MISS_RATIO;
    let observedAt = current.observedAt;
    let cutFraction = current.cutFraction;
    if (shouldStep) {
      const liveCut = effectiveKvCut({ ...current, observedAt: current.observedAt }, now);
      const nextCut = isActiveCut(current, now)
        ? liveCut + KV_EVICTION_STEP
        : boundedCut(current.cutFraction) === 0
          ? KV_EVICTION_STEP
          : 0;
      cutFraction = Math.min(KV_EVICTION_MAX_CUT, nextCut);
      const previous = current.observedAt.getTime();
      observedAt = new Date(
        Number.isFinite(previous) ? Math.max(previous, now.getTime()) : now.getTime(),
      );
    }
    current = {
      cutFraction,
      observedAt,
      sessionIds: known,
      missCount,
      continuationCount,
    };
  }
  return current;
}

export function applyKvEvictionObservations(
  state: KvEvictionState | null,
  sessionIds: readonly string[],
  now: Date,
): KvEvictionState {
  return applyKvEvictionContinuations(
    state,
    boundedKvEvictionSessions(sessionIds).map((sessionId) => ({ sessionId, kind: "miss" })),
    now,
  );
}

/**
 * Token-mode reported K: vLLM/SGLang (and generic) positive int32 budgets.
 * llama.cpp is slot mode. Shared by protection, placement, and capacity cards.
 */
export function protectionKvBudgetTokens(
  engineKind: string | null | undefined,
  kvBudgetTokens: number | null | undefined,
): number | null {
  if (engineKind === "LLAMA_CPP") return null;
  return kvBudgetTokens !== null &&
    kvBudgetTokens !== undefined &&
    Number.isInteger(kvBudgetTokens) &&
    kvBudgetTokens > 0 &&
    kvBudgetTokens <= 2_147_483_647
    ? kvBudgetTokens
    : null;
}

export function effectiveKvBudgetTokens(
  reported: number | null | undefined,
  state: KvEvictionState | null | undefined,
  now: Date,
  evictionFeedbackEnabled?: boolean,
): number | null {
  if (reported == null || !Number.isInteger(reported) || reported <= 0 || reported > 2_147_483_647)
    return null;
  if (!kvEvictionCutsApply(evictionFeedbackEnabled)) return reported;
  const cut = effectiveKvCut(state, now);
  return Math.min(
    reported,
    Math.max(Math.ceil(reported * KV_EVICTION_FLOOR_FRACTION), Math.floor(reported * (1 - cut))),
  );
}
