/**
 * Relative KV eviction feedback. A lower K redirects NEW sessions, reducing
 * evictions until evidence stops and the cut recovers linearly. A 50% cap bounds
 * over-reaction; slow (30 minute) recovery and small (5%) steps prevent flapping.
 * No gain depends on the previous effective K: observations count sessions, so
 * the loop cannot run away. Hits leave state untouched and simply allow decay.
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

export type KvEvictionState = { cutFraction: number; observedAt: Date };

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
  const previous = state?.observedAt.getTime();
  return {
    cutFraction: Math.min(
      KV_EVICTION_MAX_CUT,
      effectiveKvCut(state, now) + boundedKvEvictionCount(count) * KV_EVICTION_STEP,
    ),
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
