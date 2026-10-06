import prisma, { type Prisma } from "@ws-model-proxy/db";
import { isDbShutdownFenceArmed } from "@ws-model-proxy/db/shutdown-fence";
import {
  REALTIME_TRANSCRIPTION_OPERATION,
  transitionRelayRequestTerminal,
} from "../usage-rollup.js";
import { REALTIME_PCM_BYTES_PER_SECOND } from "./events.js";
import type {
  RealtimeCandidate,
  RealtimeCloseCode,
  RealtimeItemOutcome,
  RealtimeSessionOutcome,
} from "./transcription-session.js";

/**
 * Accounting for live transcription sessions (design §8, chunk 7): one
 * `RelayRequest` row per session that opened, in the same table, rollups and
 * retention as HTTP requests, so the request history, the usage API and the
 * dashboard metrics show it like any other request.
 *
 * - Created PENDING when the session opens (`opened` hook), with the
 *   requester, source and token (none for Chat Test, as its HTTP rows), pool
 *   or direct model, member and execution target.
 * - Finalized through THE terminal transition (`transitionRelayRequestTerminal`:
 *   PENDING -> terminal plus its rollup increment, exactly once) when the
 *   session ends (`ended` hook): the wall time measured in the hooks, the PCM
 *   bytes forwarded (the session total from `ended`: failed items report 0)
 *   and `audioInputMs` from them, transcript bytes, and the engine's token
 *   counts when it reported any.
 * - Sessions that never opened write nothing (no member served them).
 *
 * Writes never block or end a session: they run detached, every failure is
 * logged by class only, and nothing is written once the database shutdown
 * fence is armed. Shutdown awaits the writes in flight
 * (`flushRealtimeMetering`) before it arms the fence. A row left PENDING
 * (a crash, a fenced write) is failed by the usage retention reaper.
 * Prompt-free: ids, counts and timings only, never audio or transcripts.
 */

const INT_MAX = 2_147_483_647;
/** 24 kHz s16 mono: 48 bytes per millisecond. */
const PCM_BYTES_PER_MS = REALTIME_PCM_BYTES_PER_SECOND / 1000;

type MeterDb = Pick<typeof prisma, "$transaction"> & {
  relayRequest: Pick<typeof prisma.relayRequest, "create">;
};

/** Writes in flight, awaited by shutdown before the database fence arms. */
const pendingWrites = new Set<Promise<unknown>>();

function track<T>(write: Promise<T>): Promise<T | null> {
  const settled = write.then(
    (value) => value,
    (error: unknown) => {
      console.error(
        "[realtime] usage write failed",
        error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
      );
      return null;
    },
  );
  pendingWrites.add(settled);
  void settled.finally(() => pendingWrites.delete(settled));
  return settled;
}

/** Shutdown: waits for the usage writes already started (they never reject). */
export async function flushRealtimeMetering(): Promise<void> {
  await Promise.allSettled([...pendingWrites]);
}

export function audioInputMsFromBytes(bytes: number): number {
  return Math.min(INT_MAX, Math.round(Math.max(0, bytes) / PCM_BYTES_PER_MS));
}

function clampInt(value: number): number {
  return Math.min(INT_MAX, Math.max(0, Math.round(value)));
}

/**
 * The request status a session's end maps to. A client that closes its
 * socket is the normal end of a live session; server-side ends map to the
 * HTTP status their error stands for.
 */
export function realtimeTerminal(
  outcome: Pick<RealtimeSessionOutcome, "closeCode" | "errorCode">,
): {
  status: "SUCCEEDED" | "FAILED" | "CANCELED";
  httpStatusCode: number;
  errorClass: string | null;
} {
  const code: RealtimeCloseCode | null = outcome.closeCode;
  const error = outcome.errorCode;
  if (code === null || code === 1000) {
    // Client close, idle timeout, maximum duration: the session served. A
    // SUCCEEDED row carries no error class (as HTTP rows), so normal ends
    // never show up among the admin error classes.
    return { status: "SUCCEEDED", httpStatusCode: 200, errorClass: null };
  }
  if (code === 1001) return { status: "CANCELED", httpStatusCode: 503, errorClass: error };
  if (code === 1008) {
    const httpStatusCode =
      error === "invalid_api_key" || error === "dashboard_session_ended"
        ? 401
        : error === "model_not_found"
          ? 404
          : error === "rate_limited"
            ? 429
            : 403;
    return { status: "FAILED", httpStatusCode, errorClass: error };
  }
  if (code === 1013) return { status: "FAILED", httpStatusCode: 503, errorClass: error };
  return {
    status: "FAILED",
    httpStatusCode: error === "capacity_lease_lost" ? 503 : 502,
    errorClass: error,
  };
}

export class RealtimeSessionMeter {
  private openedAt: Date | null = null;
  private row: Promise<string | null> | null = null;
  private inputTokens = 0;
  private outputTokens = 0;
  private usageKnown = false;
  private transcriptBytes = 0;
  private finalized = false;

  constructor(
    private readonly requester: {
      userId: string;
      /** `API_TOKEN` for `/v1/realtime`; `CHAT_TEST` (no token) as HTTP Chat Test rows. */
      source: "API_TOKEN" | "CHAT_TEST";
      tokenId: string | null;
      tokenLookupPrefix: string | null;
    },
    private readonly db: MeterDb = prisma,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The session opened on `candidate`: its row is created now. */
  opened(candidate: RealtimeCandidate) {
    if (this.row) return;
    const openedAt = this.now();
    this.openedAt = openedAt;
    const route = candidate.route;
    if (!route || isDbShutdownFenceArmed()) return;
    const pool = route.kind === "pool";
    const data: Prisma.RelayRequestUncheckedCreateInput = {
      userId: this.requester.userId,
      source: this.requester.source,
      modelApiTokenId: this.requester.tokenId,
      modelApiTokenLookupPrefix: this.requester.tokenLookupPrefix,
      requestedModelPoolId: pool ? route.poolId : null,
      requestedDiscoveredModelId: pool ? null : route.discoveredModelId,
      requestedExecutionTargetId: pool ? null : route.executionTargetId,
      selectedDiscoveredModelId: route.discoveredModelId,
      selectedExecutionTargetId: route.executionTargetId,
      selectedPoolMemberId: route.poolMemberId,
      selectedPoolMemberTier: pool ? "PRIMARY" : null,
      fallbackRoute: pool ? "local" : null,
      operation: REALTIME_TRANSCRIPTION_OPERATION,
      attemptCount: 1,
      startedAt: openedAt,
      status: "PENDING",
    };
    this.row = track(
      this.db.relayRequest.create({ data, select: { id: true } }).then((row) => row.id),
    );
  }

  /** One item finished: only counts are kept. */
  itemFinished(outcome: RealtimeItemOutcome) {
    this.transcriptBytes += Math.max(0, outcome.transcriptBytes);
    const usage = outcome.engineUsage;
    if (!usage) return;
    if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) this.usageKnown = true;
    this.inputTokens += usage.inputTokens ?? 0;
    this.outputTokens += usage.outputTokens ?? 0;
  }

  /** The session ended: its row is finalized with the session totals. */
  ended(outcome: RealtimeSessionOutcome) {
    if (this.finalized || !this.row || !this.openedAt) return;
    this.finalized = true;
    // Timestamped here, in the hook, not when the write gets to run.
    const completedAt = this.now();
    const openedAt = this.openedAt;
    const terminal = realtimeTerminal(outcome);
    const usageKnown = this.usageKnown;
    const promptTokens = clampInt(this.inputTokens);
    const completionTokens = clampInt(this.outputTokens);
    const data = {
      status: terminal.status,
      completedAt,
      durationMs: clampInt(completedAt.getTime() - openedAt.getTime()),
      httpStatusCode: terminal.httpStatusCode,
      errorClass: terminal.errorClass,
      requestBytes: BigInt(Math.max(0, outcome.sentAudioBytes)),
      responseBytes: BigInt(this.transcriptBytes),
      audioInputMs: audioInputMsFromBytes(outcome.sentAudioBytes),
      usageKnown,
      promptTokens: usageKnown ? promptTokens : null,
      completionTokens: usageKnown ? completionTokens : null,
      totalTokens: usageKnown ? clampInt(promptTokens + completionTokens) : null,
    };
    const row = this.row;
    track(
      row.then(async (id) => {
        if (!id || isDbShutdownFenceArmed()) return false;
        return this.db.$transaction((tx) =>
          transitionRelayRequestTerminal(tx, id, data, completedAt),
        );
      }),
    );
  }
}
