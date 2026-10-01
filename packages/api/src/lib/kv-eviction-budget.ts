/**
 * Relative KV eviction feedback. The effective K is used ONLY by the PROTECTED
 * threshold (the equity shares stay on the reported K), so a lower K can only
 * make a member PROTECTED sooner and redirect NEW sessions, which reduces
 * evictions until evidence stops and the cut recovers linearly. The 50% cap
 * bounds over-reaction (a burst can reach it); slow (30 minute) recovery and
 * small (5%) steps damp flapping. The first miss on a capacity that is not
 * already cut only arms a pending row; a second miss lowers K. That stops a
 * single chat-template rewrite (Qwen3, DeepSeek-R1, gpt-oss) from cutting a
 * long confirmed session. Two independent misses still cut, including two
 * follow-ups on those templates. A pending row expires with the 30-minute
 * recovery window (`expiresAt`); a write against an expired row is a new first
 * miss, matching readers that already ignore expiry. No gain depends on the
 * previous effective K, so the loop cannot run away. Hits leave state
 * untouched and let it decay.
 *
 * Endpoint prefix-cache counters are cumulative, include bypass traffic, and
 * cannot be attributed to a matched prefix; they are deliberately not evidence.
 * Reported budgets are positive int32 token counts (the engine-facts contract);
 * malformed budgets fail closed to slot mode. Corrupt cuts are clamped before
 * decay; NaN means the bounded maximum cut. Future/invalid timestamps do not
 * decay, bounding clock skew without ever increasing a cut on a read.
 */
export const KV_EVICTION_STEP = 0.05;
export const KV_EVICTION_MAX_CUT = 0.5;
export const KV_EVICTION_RECOVERY_MS = 1_800_000;
export const KV_EVICTION_MAX_OBSERVATIONS_PER_FLUSH = 10;
export const KV_EVICTION_FLOOR_FRACTION = 1 - KV_EVICTION_MAX_CUT;
export const KV_EVICTION_DECAY_PER_MS = KV_EVICTION_MAX_CUT / KV_EVICTION_RECOVERY_MS;

export type KvEvictionState = { cutFraction: number; observedAt: Date; expiresAt?: Date };

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

/** Integer observations, bounded even for non-finite inputs. */
export function boundedKvEvictionCount(count: number): number {
  return Number.isNaN(count)
    ? 0
    : Math.min(KV_EVICTION_MAX_OBSERVATIONS_PER_FLUSH, Math.max(0, Math.floor(count)));
}

export function effectiveKvCut(state: KvEvictionState | null | undefined, now: Date): number {
  if (!state) return 0;
  const elapsed = now.getTime() - state.observedAt.getTime();
  return Math.max(
    0,
    boundedCut(state.cutFraction) -
      KV_EVICTION_DECAY_PER_MS * (Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0),
  );
}

export function applyKvEvictionObservations(
  state: KvEvictionState | null,
  count: number,
  now: Date,
): KvEvictionState {
  const live = liveKvEvictionState(state, now);
  const previous = live?.observedAt.getTime();
  const bounded = boundedKvEvictionCount(count);
  const liveCut = effectiveKvCut(live, now);
  const elapsed = live ? now.getTime() - live.observedAt.getTime() : 0;
  // Integer recovery time, not the decayed float: 0.5 - (0.5/1.8e6)*1.8e6 is not 0.
  const active = liveCut > 0 && !(Number.isFinite(elapsed) && elapsed >= KV_EVICTION_RECOVERY_MS);
  // A stored cut of 0 is a pending first miss. A stored cut that has decayed
  // to 0 is a recovered capacity and must corroborate again. An expired row
  // (pending or cut) is absent and must corroborate from scratch.
  const nextCut = active
    ? liveCut + bounded * KV_EVICTION_STEP
    : live && boundedCut(live.cutFraction) === 0
      ? bounded * KV_EVICTION_STEP
      : Math.max(0, bounded - 1) * KV_EVICTION_STEP;
  return {
    cutFraction: Math.min(KV_EVICTION_MAX_CUT, nextCut),
    observedAt: new Date(
      previous !== undefined && Number.isFinite(previous)
        ? Math.max(previous, now.getTime())
        : now.getTime(),
    ),
  };
}

export function effectiveKvBudgetTokens(
  reported: number | null | undefined,
  state: KvEvictionState | null | undefined,
  now: Date,
): number | null {
  if (reported == null || !Number.isInteger(reported) || reported <= 0 || reported > 2_147_483_647)
    return null;
  const cut = effectiveKvCut(state, now);
  return Math.min(
    reported,
    Math.max(Math.ceil(reported * KV_EVICTION_FLOOR_FRACTION), Math.floor(reported * (1 - cut))),
  );
}
