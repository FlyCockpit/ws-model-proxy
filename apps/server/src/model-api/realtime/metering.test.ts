import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
const fence = vi.hoisted(() => ({ armed: false }));
vi.mock("@ws-model-proxy/db/shutdown-fence", () => ({
  isDbShutdownFenceArmed: () => fence.armed,
}));

const { audioInputMsFromBytes, flushRealtimeMetering, RealtimeSessionMeter, realtimeTerminal } =
  await import("./metering.js");
type Candidate = Parameters<InstanceType<typeof RealtimeSessionMeter>["opened"]>[0];

function candidate(kind: "pool" | "direct" = "pool"): Candidate {
  return {
    cliDeviceId: "cli",
    endpointSlug: "inst-aaaaaaaaaaaaaaaa",
    upstreamModel: "whisper",
    capabilities: null,
    deploymentManaged: true,
    memberId: kind === "pool" ? "m1" : null,
    route: {
      kind,
      poolId: kind === "pool" ? "pool-1" : null,
      poolMemberId: kind === "pool" ? "m1" : null,
      discoveredModelId: "dm-1",
      endpointId: "ep-1",
      executionTargetId: "et-1",
      capacityId: "cap-1",
      ownerUserId: "owner",
      engineOwnerUserId: "owner",
      accessGrantId: null,
      contributionId: null,
    },
  };
}

function fakeDb() {
  const updates: unknown[] = [];
  const db = {
    relayRequest: {
      create: vi.fn(async (_input: unknown) => ({ id: "rr-1" })),
    },
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) =>
      run({
        relayRequest: {
          update: vi.fn(async (input: { data: unknown }) => {
            updates.push(input.data);
            return { id: "rr-1" };
          }),
        },
        $executeRaw: vi.fn(async () => 1),
      }),
    ),
  };
  return { db, updates };
}

function clock(...times: string[]) {
  const queue = times.map((time) => new Date(time));
  return () => queue.shift() ?? new Date(0);
}

const requester = {
  userId: "user-1",
  source: "API_TOKEN" as const,
  tokenId: "token-1",
  tokenLookupPrefix: "wsmp_model_abc",
};
const item = {
  itemSeq: 0,
  itemId: "item_x",
  status: "completed" as const,
  audioBytes: 48_000,
  audioSeconds: 1,
  transcriptBytes: 12,
};

beforeEach(() => {
  fence.armed = false;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("live transcription usage rows", () => {
  it("creates the row at open with the request's identities", async () => {
    const { db } = fakeDb();
    const meter = new RealtimeSessionMeter(
      requester,
      db as never,
      clock("2026-10-05T10:00:00.000Z"),
    );
    meter.opened(candidate());
    await flushRealtimeMetering();
    expect(db.relayRequest.create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        source: "API_TOKEN",
        modelApiTokenId: "token-1",
        modelApiTokenLookupPrefix: "wsmp_model_abc",
        requestedModelPoolId: "pool-1",
        requestedDiscoveredModelId: null,
        requestedExecutionTargetId: null,
        selectedDiscoveredModelId: "dm-1",
        selectedExecutionTargetId: "et-1",
        selectedPoolMemberId: "m1",
        selectedPoolMemberTier: "PRIMARY",
        fallbackRoute: "local",
        operation: "audio.realtime_transcription",
        attemptCount: 1,
        startedAt: new Date("2026-10-05T10:00:00.000Z"),
        status: "PENDING",
      },
      select: { id: true },
    });
  });

  it("writes a Chat Test session as a CHAT_TEST row with no token, like HTTP Chat Test", async () => {
    const { db } = fakeDb();
    new RealtimeSessionMeter(
      { userId: "user-1", source: "CHAT_TEST", tokenId: null, tokenLookupPrefix: null },
      db as never,
    ).opened(candidate());
    await flushRealtimeMetering();
    expect(db.relayRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "user-1",
          source: "CHAT_TEST",
          modelApiTokenId: null,
          modelApiTokenLookupPrefix: null,
        }),
      }),
    );
  });

  it("names a direct model as the requested target", async () => {
    const { db } = fakeDb();
    new RealtimeSessionMeter(requester, db as never).opened(candidate("direct"));
    await flushRealtimeMetering();
    expect(db.relayRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requestedModelPoolId: null,
          requestedDiscoveredModelId: "dm-1",
          requestedExecutionTargetId: "et-1",
          fallbackRoute: null,
          selectedPoolMemberTier: null,
        }),
      }),
    );
  });

  it("finalizes with the session totals, the hook-time duration and engine tokens", async () => {
    const { db, updates } = fakeDb();
    const meter = new RealtimeSessionMeter(
      requester,
      db as never,
      clock("2026-10-05T10:00:00.000Z", "2026-10-05T10:01:30.250Z"),
    );
    meter.opened(candidate());
    meter.itemFinished({ ...item, engineUsage: { inputTokens: 10, outputTokens: 3 } });
    meter.itemFinished({ ...item, engineUsage: { outputTokens: 2 } });
    // A failed item reports no audio; the session total from `ended` counts it.
    meter.itemFinished({
      ...item,
      status: "failed",
      audioBytes: 0,
      audioSeconds: 0,
      code: "engine_error",
      transcriptBytes: 0,
    });
    meter.ended({
      candidate: candidate(),
      closeCode: null,
      errorCode: null,
      sentAudioBytes: 240_000,
    });
    meter.ended({ candidate: candidate(), closeCode: 1011, errorCode: "x", sentAudioBytes: 1 });
    await flushRealtimeMetering();
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(updates).toEqual([
      {
        status: "SUCCEEDED",
        completedAt: new Date("2026-10-05T10:01:30.250Z"),
        durationMs: 90_250,
        httpStatusCode: 200,
        errorClass: null,
        requestBytes: 240_000n,
        responseBytes: 24n,
        audioInputMs: 5_000,
        usageKnown: true,
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      },
    ]);
  });

  it("records unknown usage as null tokens", async () => {
    const { db, updates } = fakeDb();
    const meter = new RealtimeSessionMeter(requester, db as never);
    meter.opened(candidate());
    meter.itemFinished(item);
    meter.ended({
      candidate: candidate(),
      closeCode: 1011,
      errorCode: "upstream_disconnected",
      sentAudioBytes: 96,
    });
    await flushRealtimeMetering();
    expect(updates[0]).toMatchObject({
      status: "FAILED",
      httpStatusCode: 502,
      errorClass: "upstream_disconnected",
      usageKnown: false,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      audioInputMs: 2,
    });
  });

  it("writes nothing for a session that never opened, or once the shutdown fence is armed", async () => {
    const { db } = fakeDb();
    const never = new RealtimeSessionMeter(requester, db as never);
    never.ended({ candidate: null, closeCode: 1013, errorCode: "server_busy", sentAudioBytes: 0 });
    fence.armed = true;
    const fenced = new RealtimeSessionMeter(requester, db as never);
    fenced.opened(candidate());
    fenced.ended({ candidate: candidate(), closeCode: null, errorCode: null, sentAudioBytes: 10 });
    await flushRealtimeMetering();
    expect(db.relayRequest.create).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("skips the finalization when the fence arms after the row was created", async () => {
    const { db } = fakeDb();
    const meter = new RealtimeSessionMeter(requester, db as never);
    meter.opened(candidate());
    await flushRealtimeMetering();
    fence.armed = true;
    meter.ended({ candidate: candidate(), closeCode: null, errorCode: null, sentAudioBytes: 10 });
    await flushRealtimeMetering();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("never throws into the session: failed writes are logged by class only", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { db } = fakeDb();
    db.relayRequest.create.mockRejectedValueOnce(new TypeError("PRIVATE details"));
    const meter = new RealtimeSessionMeter(requester, db as never);
    expect(() => meter.opened(candidate())).not.toThrow();
    expect(() =>
      meter.ended({ candidate: candidate(), closeCode: null, errorCode: null, sentAudioBytes: 10 }),
    ).not.toThrow();
    await flushRealtimeMetering();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith("[realtime] usage write failed", "TypeError");
    expect(JSON.stringify(errors.mock.calls)).not.toContain("PRIVATE");

    const second = fakeDb();
    second.db.$transaction.mockRejectedValueOnce(new Error("lock timeout"));
    const failing = new RealtimeSessionMeter(requester, second.db as never);
    failing.opened(candidate());
    failing.ended({ candidate: candidate(), closeCode: null, errorCode: null, sentAudioBytes: 10 });
    await expect(flushRealtimeMetering()).resolves.toBeUndefined();
  });

  it("maps every session end to a request status", () => {
    const cases: [number | null, string | null, string, number][] = [
      [null, null, "SUCCEEDED", 200],
      [1000, "idle_timeout", "SUCCEEDED", 200],
      [1000, "session_expired", "SUCCEEDED", 200],
      [1001, "server_shutting_down", "CANCELED", 503],
      [1008, "invalid_api_key", "FAILED", 401],
      [1008, "dashboard_session_ended", "FAILED", 401],
      [1008, "model_not_found", "FAILED", 404],
      [1008, "rate_limited", "FAILED", 429],
      [1011, "capacity_lease_lost", "FAILED", 503],
      [1011, "model_unavailable", "FAILED", 502],
      [1013, "audio_backlog", "FAILED", 503],
    ];
    for (const [closeCode, errorCode, status, httpStatusCode] of cases) {
      expect(realtimeTerminal({ closeCode: closeCode as never, errorCode })).toEqual({
        status,
        httpStatusCode,
        // A normal end (idle, expired, client close) carries no error class.
        errorClass: status === "SUCCEEDED" ? null : errorCode,
      });
    }
    expect(audioInputMsFromBytes(48)).toBe(1);
    expect(audioInputMsFromBytes(47)).toBe(1);
    expect(audioInputMsFromBytes(23)).toBe(0);
    expect(audioInputMsFromBytes(-5)).toBe(0);
  });
});
