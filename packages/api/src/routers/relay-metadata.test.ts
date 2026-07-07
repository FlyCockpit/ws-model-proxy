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
  appSetting: {
    findUnique: MockInstance;
  };
  relayRequest: {
    findMany: MockInstance;
    deleteMany: MockInstance;
  };
};

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
  });

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
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret prompt");
    expect(JSON.stringify(result)).not.toContain("secret answer");
  });

  it("deletes only the current user's relay metadata", async () => {
    const client = createRouterClient(relayMetadataRouter, { context: buildContext() });
    const createdBefore = new Date("2026-02-01T00:00:00.000Z");

    await expect(client.deleteOwn({ ids: ["relay-a", "relay-b"], createdBefore })).resolves.toEqual(
      { deletedCount: 2 },
    );
    expect(db.relayRequest.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: "user-id",
        id: { in: ["relay-a", "relay-b"] },
        createdAt: { lt: createdBefore },
      },
    });
  });

  it("deletes current-user relay metadata by created-at range", async () => {
    const client = createRouterClient(relayMetadataRouter, { context: buildContext() });
    const createdAfter = new Date("2026-01-01T00:00:00.000Z");
    const createdBefore = new Date("2026-02-01T00:00:00.000Z");

    await expect(client.deleteOwn({ createdAfter, createdBefore })).resolves.toEqual({
      deletedCount: 2,
    });
    expect(db.relayRequest.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: "user-id",
        createdAt: { lt: createdBefore, gte: createdAfter },
      },
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

    await expect(
      client.prune({ ownerUserId: "owner-id", createdAfter, createdBefore }),
    ).resolves.toEqual({ deletedCount: 2 });
    expect(db.relayRequest.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: "owner-id",
        createdAt: { lt: createdBefore, gte: createdAfter },
      },
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
