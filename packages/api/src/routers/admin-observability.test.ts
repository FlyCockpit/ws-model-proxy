import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123" },
}));
vi.mock("@ws-model-proxy/db", () => ({ default: mockDeep<PrismaClient>() }));
vi.mock("@ws-model-proxy/auth", () => ({ auth: { api: {} } }));
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: vi.fn(async () => false),
}));

import prisma from "@ws-model-proxy/db";
import type { Context } from "../context";
import type { CallerAuth } from "../contracts/auth-context";
import { adminObservabilityRouter } from "./admin-observability";

const db = prisma as unknown as ReturnType<typeof mockDeep<PrismaClient>>;

function client(role: string, auth?: CallerAuth) {
  const session = {
    user: { id: "admin", email: "a@example.test", name: "A", role, emailVerified: true },
    session: { id: "s", userId: "admin", expiresAt: new Date(Date.now() + 60_000) },
  } as unknown as Session;
  const context: Context = {
    session,
    auth: auth ?? { kind: "cookie_session", userId: "admin", sessionId: "s", csrfVerified: true },
  };
  return createRouterClient(adminObservabilityRouter, { context });
}

const owner = { id: "u1", email: "u1@example.test", name: "U One", slug: "u-one" };

beforeEach(() => {
  mockReset(db);
});

describe("admin observability", () => {
  it("is for admins only (and never for an agent)", async () => {
    for (const call of [
      (c: ReturnType<typeof client>) => c.nodes({}),
      (c: ReturnType<typeof client>) => c.runtimes({}),
      (c: ReturnType<typeof client>) => c.pools({}),
      (c: ReturnType<typeof client>) => c.relay({}),
    ]) {
      await expect(call(client("user"))).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        call(
          client("admin", {
            kind: "agent_token",
            userId: "admin",
            agentTokenId: "t",
            level: "FULL",
          }),
        ),
      ).rejects.toBeTruthy();
    }
    expect(db.node.findMany).not.toHaveBeenCalled();
    expect(db.relayRequest.findMany).not.toHaveBeenCalled();
  });

  it("pages every node with its owner, effective trust and running instances", async () => {
    db.node.findMany.mockResolvedValue([
      {
        id: "n1",
        slug: "desk",
        connection: "ONLINE",
        trust: "FULL",
        trustChangedAt: null,
        trustLowerRequestedAt: null,
        cliVersion: "0.4.0",
        lastHeartbeatAt: new Date("2026-10-07T10:00:00.000Z"),
        User: owner,
        _count: { Ranks: 2 },
      },
    ] as never);
    db.node.count.mockResolvedValue(31);
    const result = await client("admin").nodes({ page: 2, pageSize: 10, ownerQuery: "one" });
    expect(result).toEqual({
      items: [
        {
          id: "n1",
          slug: "desk",
          owner,
          connection: "ONLINE",
          trust: "FULL",
          version: "0.4.0",
          lastHeartbeatAt: "2026-10-07T10:00:00.000Z",
          runningInstances: 2,
        },
      ],
      total: 31,
      page: 2,
      pageSize: 10,
    });
    expect(db.node.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 10,
        take: 10,
        where: {
          User: {
            OR: [
              { email: { contains: "one", mode: "insensitive" } },
              { name: { contains: "one", mode: "insensitive" } },
              { slug: { contains: "one", mode: "insensitive" } },
            ],
          },
        },
      }),
    );
  });

  it("lists runtimes with their live instances and pools with callable ids", async () => {
    db.runtime.findMany.mockResolvedValue([
      {
        id: "r1",
        slug: "qwen",
        kind: "STARTABLE",
        User: owner,
        CurrentVersion: null,
        Instances: [{ id: "i1", phase: "READY" }],
      },
    ] as never);
    db.runtime.count.mockResolvedValue(1);
    const runtimes = await client("admin").runtimes({});
    expect(runtimes.items[0]).toMatchObject({
      modelType: null,
      instances: [{ id: "i1", phase: "READY" }],
    });

    db.pool.findMany.mockResolvedValue([
      {
        id: "p1",
        slug: "chat",
        modelType: "LLM",
        User: owner,
        _count: { Members: 3, Shares: 1 },
      },
    ] as never);
    db.pool.count.mockResolvedValue(1);
    const pools = await client("admin").pools({});
    expect(pools.items).toEqual([
      { id: "p1", callableId: "u-one/chat", owner, modelType: "LLM", members: 3, shares: 1 },
    ]);
  });

  it("answers the request log by matched owners, prompt-free", async () => {
    db.user.findMany.mockResolvedValueOnce([]);
    expect(await client("admin").relay({ ownerQuery: "nobody" })).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 25,
    });
    expect(db.relayRequest.findMany).not.toHaveBeenCalled();

    db.user.findMany.mockResolvedValueOnce([{ id: "u1" }] as never);
    db.user.findMany.mockResolvedValueOnce([owner] as never);
    db.relayRequest.findMany.mockResolvedValue([
      {
        id: "q1",
        createdAt: new Date("2026-10-07T11:00:00.000Z"),
        userId: "u1",
        status: "FAILED",
        poolId: "p1",
        external: true,
        durationMs: 950,
        errorClass: "upstream_5xx",
      },
    ] as never);
    db.relayRequest.count.mockResolvedValue(1);
    db.pool.findMany.mockResolvedValue([
      { id: "p1", slug: "chat", User: { slug: "u-one" } },
    ] as never);
    const result = await client("admin").relay({ ownerQuery: "one" });
    expect(result.items).toEqual([
      {
        id: "q1",
        createdAt: "2026-10-07T11:00:00.000Z",
        owner,
        status: "FAILED",
        callableId: "u-one/chat:external",
        durationMs: 950,
        errorClass: "upstream_5xx",
      },
    ]);
    expect(db.relayRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: { in: ["u1"] } } }),
    );
  });
});
