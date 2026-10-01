/**
 * Relative KV eviction feedback. The effective K is used ONLY by the PROTECTED
 * threshold (the equity shares stay on the reported K), so a lower K can only
 * make a member PROTECTED sooner and redirect NEW sessions, which reduces
 * evictions until evidence stops and the cut recovers linearly. The 50% cap
 * bounds over-reaction (a burst can reach it); slow (30 minute) recovery and
 * small (5%) steps damp flapping. The first miss on a capacity that is not
 * already cut only arms a pending row; a second miss from a different session
 * lowers K. A later miss from the same session is ignored, including after a
 * live cut. That stops one reasoning-model conversation (Qwen3, DeepSeek-R1,
 * gpt-oss template rewrites) from walking K down. Two sessions still cut. A
 * pending row expires with the 30-minute recovery window (`expiresAt`); a
 * write against an expired row is a new first miss, matching readers that
 * already ignore expiry. No gain depends on the previous effective K, so the
 * loop cannot run away. Hits leave state untouched and let it decay.
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

export type KvEvictionState = {
  cutFraction: number;
  observedAt: Date;
  expiresAt?: Date;
  lastSessionId?: string | null;
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

export function effectiveKvCut(state: KvEvictionState | null | undefined, now: Date): number {
  if (!state) return 0;
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

function applyOneKvEvictionSession(
  state: KvEvictionState | null,
  sessionId: string,
  now: Date,
): KvEvictionState {
  const live = liveKvEvictionState(state, now);
  if (
    live &&
    live.lastSessionId === sessionId &&
    (isActiveCut(live, now) || boundedCut(live.cutFraction) === 0)
  ) {
    return live;
  }
  const previous = live?.observedAt.getTime();
  const liveCut = effectiveKvCut(live, now);
  const nextCut =
    live && isActiveCut(live, now)
      ? liveCut + KV_EVICTION_STEP
      : live && boundedCut(live.cutFraction) === 0
        ? KV_EVICTION_STEP
        : 0;
  return {
    cutFraction: Math.min(KV_EVICTION_MAX_CUT, nextCut),
    observedAt: new Date(
      previous !== undefined && Number.isFinite(previous)
        ? Math.max(previous, now.getTime())
        : now.getTime(),
    ),
    lastSessionId: sessionId,
  };
}

export function applyKvEvictionObservations(
  state: KvEvictionState | null,
  sessionIds: readonly string[],
  now: Date,
): KvEvictionState {
  const sessions = boundedKvEvictionSessions(sessionIds);
  if (sessions.length === 0) {
    const live = liveKvEvictionState(state, now);
    return live
      ? {
          cutFraction: live.cutFraction,
          observedAt: live.observedAt,
          lastSessionId: live.lastSessionId,
        }
      : { cutFraction: 0, observedAt: now };
  }
  let current = liveKvEvictionState(state, now);
  for (const sessionId of sessions) current = applyOneKvEvictionSession(current, sessionId, now);
  return current!;
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
