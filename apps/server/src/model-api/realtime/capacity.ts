import { randomUUID } from "node:crypto";
import { STT_MAX_SESSION_MS } from "../../relay/stt-relay.js";
import type { CapacityAdmissionRuntime } from "../capacity/runtime.js";
import { NORMAL_PRIORITY_RANK } from "../capacity/types.js";
import type { RealtimeAdmitResult, RealtimeCandidate } from "./transcription-session.js";

/**
 * Capacity admission for live transcription (design §3, D5): one durable
 * lease on the chosen member, like one HTTP request, so live sessions and
 * HTTP share the engine's real capacity. Admission waits at most a few
 * seconds (a live microphone must not queue); a member without a capacity
 * identity is never admitted (no bypass of durable concurrency).
 */
export const REALTIME_ADMISSION_WAIT_MS = 3_000;
/** The lease outlives one relay deadline: a session plus margin. */
export const REALTIME_LEASE_MAX_LIFETIME_MS = STT_MAX_SESSION_MS + 60_000;

export function createRealtimeAdmit(
  runtime: CapacityAdmissionRuntime,
): (candidate: RealtimeCandidate, signal: AbortSignal) => Promise<RealtimeAdmitResult> {
  return async (candidate, signal) => {
    const route = candidate.route;
    if (!route?.instanceId || !route.executionTargetId) return { ok: false };
    const deadlineAt = new Date(Date.now() + REALTIME_ADMISSION_WAIT_MS);
    const result = await runtime.acquire(
      {
        requestId: randomUUID(),
        attemptId: randomUUID(),
        ownerId: route.ownerUserId,
        sourceKind: route.kind === "pool" ? "POOL" : "TEST",
        ...(route.poolId ? { poolId: route.poolId } : {}),
        basePriority: NORMAL_PRIORITY_RANK,
        ...(route.kind === "pool" ? { priorityShareId: route.shareId } : {}),
        connectionOwner: "model-api-realtime",
        deadlineAt,
        candidates: [
          {
            capacityId: route.instanceId,
            executionTargetId: route.executionTargetId,
            ...(route.poolMemberId ? { poolMemberId: route.poolMemberId } : {}),
            candidateOrder: 0,
            deadlineAt,
            waitBudgetMs: REALTIME_ADMISSION_WAIT_MS,
          },
        ],
      },
      signal,
      { maxLeaseLifetimeMs: REALTIME_LEASE_MAX_LIFETIME_MS },
    );
    if (result.state !== "ADMITTED") return { ok: false };
    const handle = result.lease;
    let released = false;
    return {
      ok: true,
      lease: {
        release() {
          if (released) return;
          released = true;
          void runtime.release(handle).catch((error: unknown) => {
            console.error(
              "[realtime] capacity release failed",
              error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
            );
          });
        },
        ...(handle.signal ? { signal: handle.signal } : {}),
      },
    };
  };
}
