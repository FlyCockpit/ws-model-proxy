import { createRouterClient, ORPCError } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context";
import { relayMetadataRouter } from "./relay-metadata";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { default: prisma } = await import("@ws-model-proxy/db");

const db = prisma as unknown as {
  $transaction: MockInstance;
  $queryRaw: MockInstance;
  $executeRaw: MockInstance;
  appSetting: {
    findUnique: MockInstance;
  };
  relayRequest: {
    findMany: MockInstance;
    deleteMany: MockInstance;
  };
};

/** The two relay rows a delete batch picks, then the locks and delete it issues. */
function expectOrderedRelayDelete(where: Record<string, unknown>) {
  expect(db.relayRequest.findMany).toHaveBeenCalledWith({
    where,
    select: { id: true },
    orderBy: { id: "asc" },
    take: 500,
  });
  expect(db.relayRequest.deleteMany).not.toHaveBeenCalled();
  // Capacity lock order: the referencing admission_request rows are taken
  // first with SKIP LOCKED, then the relay rows, also SKIP LOCKED: the delete
  // never waits on a row an in-flight admission holds.
  const [lockStrings, lockIds] = db.$queryRaw.mock.calls[0] as [TemplateStringsArray, unknown[]];
  expect(lockStrings.join("?")).toContain("FROM admission_request");
  expect(lockStrings.join("?")).toContain("FOR NO KEY UPDATE SKIP LOCKED");
  expect(lockStrings.join("?")).toContain('"relayRequestId" = ANY(');
  expect(lockIds).toEqual(["relay-a", "relay-b"]);
  const [deleteStrings, deleteIds] = db.$executeRaw.mock.calls[0] as [
    TemplateStringsArray,
    unknown[],
  ];
  expect(deleteStrings.join("?")).toContain("DELETE FROM relay_request");
  expect(deleteStrings.join("?")).toContain("FOR UPDATE SKIP LOCKED");
  expect(deleteStrings.join("?")).toContain("status IN ('SUCCEEDED', 'FAILED', 'CANCELED')");
  expect(deleteIds).toEqual(["relay-a", "relay-b"]);
}

function buildContext(
  sessionOverride?: Partial<{
    user: Partial<Session["user"]>;
    session: Partial<Session["session"]>;
  }> | null,
): Context {
  if (sessionOverride === null) return { session: null };

  return {
    session: {
      user: {
        id: "user-id",
        email: "user@example.com",
        name: "User",
        emailVerified: true,
        role: "user",
        twoFactorEnabled: false,
        image: null,
        banned: false,
        banReason: null,
        banExpires: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        ...sessionOverride?.user,
      },
      session: {
        id: "session-id",
        userId: sessionOverride?.user?.id ?? "user-id",
        token: "session-token",
        expiresAt: new Date("2026-01-02T00:00:00.000Z"),
        ipAddress: "127.0.0.1",
        userAgent: "vitest",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        ...sessionOverride?.session,
      },
    } as Session,
  };
}

describe("relayMetadataRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.appSetting.findUnique.mockResolvedValue(null);
    db.relayRequest.findMany.mockResolvedValue([]);
    db.relayRequest.deleteMany.mockResolvedValue({ count: 2 });
    db.$transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => run(db));
    db.$queryRaw.mockResolvedValue([]);
    db.$executeRaw.mockResolvedValue(2);
  });

  const pickTwoRelayRows = () =>
    db.relayRequest.findMany.mockResolvedValueOnce([{ id: "relay-a" }, { id: "relay-b" }]);

  it("lists only metadata-safe relay fields for the current user", async () => {
    db.relayRequest.findMany.mockResolvedValue([
      {
        id: "relay-a",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:01:00.000Z"),
        modelApiTokenId: "token-id",
        modelApiTokenLookupPrefix: "wsmp_model_abcd",
        requestedDiscoveredModelId: "model-id",
        requestedModelPoolId: null,
        selectedDiscoveredModelId: "model-id",
        requestedExecutionTargetId: "target-id",
        selectedExecutionTargetId: "target-id",
        status: "SUCCEEDED",
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        completedAt: new Date("2026-01-01T00:00:02.000Z"),
        durationMs: 2000,
        promptTokens: 3,
        completionTokens: 5,
        totalTokens: 8,
        httpStatusCode: 200,
        upstreamStatusCode: 200,
        errorClass: null,
        operation: "audio.transcriptions",
        requestBytes: 3_000_000_000n,
        responseBytes: 42n,
        attemptCount: 2,
        auxiliaryAttemptCount: 1,
        auxiliaryRequestBytes: 12n,
        auxiliaryResponseBytes: 34n,
        requestedSurface: "ANTHROPIC_MESSAGES",
        selectedNativeSurface: "OPENAI_CHAT_COMPLETIONS",
        adapterMode: "ADAPTED",
        adapterVersion: "1.0.0",
        selectedPoolMemberId: "member-id",
        selectedPoolMemberTier: "PRIMARY",
        localAttemptId: "attempt-id",
        firstClientByteAt: new Date("2026-01-01T00:00:01.000Z"),
        streamCommitted: true,
        admissionAttemptId: "admission-attempt-id",
        admissionFencingToken: 7n,
        admissionWaitDurationMs: 12,
        admissionTerminalState: "ADMITTED",
        contextTokenCount: 8,
        contextCountMethod: "TOKEN_ESTIMATE",
        contextCountConfidence: "CONSERVATIVE",
        contextCountExact: false,
        contextSafetyMargin: 1.2,
        admissionLeaseId: "lease-id",
        admissionCapacityId: "capacity-id",
        admissionReservationClass: 2,
        admissionBorrowed: false,
        publicEgress: false,
        publicOverflowReason: null,
        providerAttemptId: null,
        providerFencingToken: null,
        ExecutionEvents: [
          {
            id: "event-id",
            createdAt: new Date("2026-01-01T00:00:00.500Z"),
            attemptId: "attempt-id",
            eventType: "ATTEMPT_STARTED",
            attemptKind: "EXECUTION",
            requestedSurface: "ANTHROPIC_MESSAGES",
            nativeSurface: "OPENAI_CHAT_COMPLETIONS",
            adapterMode: "ADAPTED",
            adapterVersion: "1.0.0",
            poolId: "pool-id",
            poolMemberId: "member-id",
            executionTargetId: "target-id",
            memberTier: "PRIMARY",
            contextCountMethod: "TOKEN_ESTIMATE",
            contextCountConfidence: "CONSERVATIVE",
            contextTokens: 8,
            admissionAttemptId: "admission-attempt-id",
            admissionLeaseId: "lease-id",
            admissionFencingToken: 7n,
            waitDurationMs: 12,
            streamCommitted: false,
            terminalState: null,
            httpStatusCode: null,
            upstreamStatusCode: null,
            errorClass: null,
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
            usageSource: null,
          },
        ],
        requestBody: "secret prompt",
        responseBody: "secret answer",
      },
    ]);

    const client = createRouterClient(relayMetadataRouter, { context: buildContext() });
    const result = await client.listOwn({ limit: 10 });

    expect(result).toEqual([
      {
        id: "relay-a",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:01:00.000Z"),
        modelApiTokenId: "token-id",
        modelApiTokenLookupPrefix: "wsmp_model_abcd",
        requestedDiscoveredModelId: "model-id",
        requestedModelPoolId: null,
        selectedDiscoveredModelId: "model-id",
        requestedExecutionTargetId: "target-id",
        selectedExecutionTargetId: "target-id",
        status: "SUCCEEDED",
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        completedAt: new Date("2026-01-01T00:00:02.000Z"),
        durationMs: 2000,
        promptTokens: 3,
        completionTokens: 5,
        totalTokens: 8,
        httpStatusCode: 200,
        upstreamStatusCode: 200,
        errorClass: null,
        operation: "audio.transcriptions",
        requestBytes: 3_000_000_000,
        responseBytes: 42,
        attemptCount: 2,
        auxiliaryAttemptCount: 1,
        auxiliaryRequestBytes: 12,
        auxiliaryResponseBytes: 34,
        requestedSurface: "ANTHROPIC_MESSAGES",
        selectedNativeSurface: "OPENAI_CHAT_COMPLETIONS",
        adapterMode: "ADAPTED",
        adapterVersion: "1.0.0",
        selectedPoolMemberId: "member-id",
        selectedPoolMemberTier: "PRIMARY",
        localAttemptId: "attempt-id",
        firstClientByteAt: new Date("2026-01-01T00:00:01.000Z"),
        streamCommitted: true,
        admissionAttemptId: "admission-attempt-id",
        admissionFencingToken: "7",
        admissionWaitDurationMs: 12,
        admissionTerminalState: "ADMITTED",
        contextTokenCount: 8,
        contextCountMethod: "TOKEN_ESTIMATE",
        contextCountConfidence: "CONSERVATIVE",
        contextCountExact: false,
        contextSafetyMargin: 1.2,
        admissionLeaseId: "lease-id",
        admissionCapacityId: "capacity-id",
        admissionReservationClass: 2,
        admissionBorrowed: false,
        publicEgress: false,
        publicOverflowReason: null,
        providerAttemptId: null,
        providerFencingToken: null,
        executionEvents: [
          {
            id: "event-id",
            createdAt: new Date("2026-01-01T00:00:00.500Z"),
            attemptId: "attempt-id",
            eventType: "ATTEMPT_STARTED",
            attemptKind: "EXECUTION",
            requestedSurface: "ANTHROPIC_MESSAGES",
            nativeSurface: "OPENAI_CHAT_COMPLETIONS",
            adapterMode: "ADAPTED",
            adapterVersion: "1.0.0",
            poolId: "pool-id",
            poolMemberId: "member-id",
            executionTargetId: "target-id",
            memberTier: "PRIMARY",
            contextCountMethod: "TOKEN_ESTIMATE",
            contextCountConfidence: "CONSERVATIVE",
            contextTokens: 8,
            admissionAttemptId: "admission-attempt-id",
            admissionLeaseId: "lease-id",
            admissionFencingToken: "7",
            waitDurationMs: 12,
            streamCommitted: false,
            terminalState: null,
            httpStatusCode: null,
            upstreamStatusCode: null,
            errorClass: null,
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
            usageSource: null,
          },
        ],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret prompt");
    expect(JSON.stringify(result)).not.toContain("secret answer");
  });

  it("deletes only the current user's relay metadata", async () => {
    const client = createRouterClient(relayMetadataRouter, { context: buildContext() });
    const createdBefore = new Date("2026-02-01T00:00:00.000Z");

    pickTwoRelayRows();
    await expect(client.deleteOwn({ ids: ["relay-a", "relay-b"], createdBefore })).resolves.toEqual(
      { deletedCount: 2 },
    );
    expectOrderedRelayDelete({
      userId: "user-id",
      status: { in: ["SUCCEEDED", "FAILED", "CANCELED"] },
      id: { in: ["relay-a", "relay-b"] },
      createdAt: { lt: createdBefore },
    });
  });

  it("skips a relay row whose admission row an in-flight admission holds", async () => {
    const client = createRouterClient(relayMetadataRouter, { context: buildContext() });
    pickTwoRelayRows();
    // relay-a has two referencing admission rows; SKIP LOCKED got only one.
    db.$queryRaw
      .mockResolvedValueOnce([{ relayRequestId: "relay-a" }])
      .mockResolvedValueOnce([{ relayRequestId: "relay-a", total: 2n }]);
    db.$executeRaw.mockResolvedValueOnce(1);

    await expect(client.deleteOwn({ ids: ["relay-a", "relay-b"] })).resolves.toEqual({
      deletedCount: 1,
    });
    const [, deleteIds] = db.$executeRaw.mock.calls[0] as [unknown, unknown[]];
    expect(deleteIds).toEqual(["relay-b"]);
  });

  it("deletes current-user relay metadata by created-at range", async () => {
    const client = createRouterClient(relayMetadataRouter, { context: buildContext() });
    const createdAfter = new Date("2026-01-01T00:00:00.000Z");
    const createdBefore = new Date("2026-02-01T00:00:00.000Z");

    pickTwoRelayRows();
    await expect(client.deleteOwn({ createdAfter, createdBefore })).resolves.toEqual({
      deletedCount: 2,
    });
    expectOrderedRelayDelete({
      userId: "user-id",
      status: { in: ["SUCCEEDED", "FAILED", "CANCELED"] },
      createdAt: { lt: createdBefore, gte: createdAfter },
    });
  });

  it("requires auth for owner deletion", async () => {
    const client = createRouterClient(relayMetadataRouter, { context: buildContext(null) });

    await expect(client.deleteOwn({ ids: ["relay-a"] })).rejects.toSatisfy((error: ORPCError) => {
      expect(error).toBeInstanceOf(ORPCError);
      expect(error.code).toBe("UNAUTHORIZED");
      return true;
    });
  });

  it("allows admins to prune globally by owner and date range", async () => {
    const client = createRouterClient(relayMetadataRouter, {
      context: buildContext({ user: { role: "admin" } }),
    });
    const createdAfter = new Date("2026-01-01T00:00:00.000Z");
    const createdBefore = new Date("2026-02-01T00:00:00.000Z");

    pickTwoRelayRows();
    await expect(
      client.prune({ ownerUserId: "owner-id", createdAfter, createdBefore }),
    ).resolves.toEqual({ deletedCount: 2 });
    expectOrderedRelayDelete({
      status: { in: ["SUCCEEDED", "FAILED", "CANCELED"] },
      userId: "owner-id",
      createdAt: { lt: createdBefore, gte: createdAfter },
    });
  });

  it("blocks non-admin global pruning", async () => {
    const client = createRouterClient(relayMetadataRouter, { context: buildContext() });

    await expect(client.prune({ ownerUserId: "owner-id" })).rejects.toSatisfy(
      (error: ORPCError) => {
        expect(error).toBeInstanceOf(ORPCError);
        expect(error.code).toBe("FORBIDDEN");
        return true;
      },
    );
  });
});
