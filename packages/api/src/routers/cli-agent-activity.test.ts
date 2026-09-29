import { createRouterClient, ORPCError } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { Context } from "../context";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_SECRET: "test-better-auth-secret" },
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { default: prisma } = await import("@ws-model-proxy/db");
const { cliAgentActivityRouter } = await import("./cli-agent-activity");

const findMany = (prisma as unknown as { cliAgentActionEvent: { findMany: MockInstance } })
  .cliAgentActionEvent.findMany;

function context(userId: string): Context {
  return {
    session: {
      user: { id: userId, email: "o@example.com", name: "O", role: "user" },
      session: { id: "s", userId, token: "t", expiresAt: new Date(Date.now() + 60_000) },
    } as unknown as Session,
  } as Context;
}

function row(index: number) {
  return {
    id: `id${String(index).padStart(3, "0")}`,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 100 - index)),
    cliDeviceId: "device-1",
    mcpTokenId: "token-1",
    kind: "command",
    path: "hmac-sha256:x pwd",
    etagBefore: null,
    etagAfter: null,
    bytes: index === 0 ? 5n : null,
    outcome: "completed",
    reason: "exit:0",
    startedAt: new Date(0),
    finishedAt: new Date(0),
  };
}

describe("cliAgentActivity.list", () => {
  beforeEach(() => {
    findMany.mockReset();
  });

  it("requires a session", async () => {
    const client = createRouterClient(cliAgentActivityRouter, { context: { session: null } });
    await expect(client.list({})).rejects.toBeInstanceOf(ORPCError);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("scopes to the session user, and to the device only as a further filter", async () => {
    findMany.mockResolvedValue([]);
    const client = createRouterClient(cliAgentActivityRouter, { context: context("user-a") });
    await client.list({ cliDeviceId: "device-of-someone-else" });
    expect(findMany.mock.calls[0]?.[0]).toMatchObject({
      where: { userId: "user-a", cliDeviceId: "device-of-someone-else" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
    });
    await client.list({});
    expect(findMany.mock.calls[1]?.[0].where).toEqual({ userId: "user-a" });
  });

  it("pages with an opaque keyset cursor and a bounded size", async () => {
    findMany.mockResolvedValue([row(0), row(1), row(2)]);
    const client = createRouterClient(cliAgentActivityRouter, { context: context("user-a") });
    const first = await client.list({ limit: 2 });
    expect(first.events.map((event) => event.id)).toEqual(["id000", "id001"]);
    expect(first.events[0]?.bytes).toBe(5);
    expect(first.nextCursor).toBe(`${row(1).createdAt.getTime()}.id001`);

    findMany.mockResolvedValue([row(2)]);
    const second = await client.list({ limit: 2, cursor: first.nextCursor ?? "" });
    expect(second.nextCursor).toBeNull();
    expect(findMany.mock.calls[1]?.[0].where).toEqual({
      userId: "user-a",
      OR: [
        { createdAt: { lt: row(1).createdAt } },
        { createdAt: row(1).createdAt, id: { lt: "id001" } },
      ],
    });
  });

  it("rejects a malformed cursor and an out-of-range limit before reading", async () => {
    const client = createRouterClient(cliAgentActivityRouter, { context: context("user-a") });
    for (const cursor of ["x", "1.a b", "-1.id", `${"9".repeat(20)}.id`, "1.id;drop"])
      await expect(client.list({ cursor })).rejects.toMatchObject({ code: expect.any(String) });
    await expect(client.list({ limit: 101 })).rejects.toBeInstanceOf(ORPCError);
    await expect(client.list({ limit: 0 })).rejects.toBeInstanceOf(ORPCError);
    expect(findMany).not.toHaveBeenCalled();
  });
});
