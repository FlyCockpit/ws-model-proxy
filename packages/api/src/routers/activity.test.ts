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
import { activityRouter } from "./activity";

const db = prisma as unknown as ReturnType<typeof mockDeep<PrismaClient>>;
const session = {
  user: { id: "owner", email: "o@example.test", name: "O", role: "user", emailVerified: true },
  session: { id: "s", userId: "owner", expiresAt: new Date(Date.now() + 60_000) },
} as unknown as Session;
const PERSON: CallerAuth = {
  kind: "cookie_session",
  userId: "owner",
  sessionId: "s",
  csrfVerified: true,
};
const AGENT: CallerAuth = {
  kind: "agent_token",
  userId: "owner",
  agentTokenId: "t",
  level: "FULL",
};

function client(auth: CallerAuth = PERSON) {
  return createRouterClient(activityRouter, { context: { session, auth } satisfies Context });
}

const t0 = new Date("2026-10-06T12:00:00Z");
const request = {
  id: "r2",
  userId: "owner",
  createdAt: t0,
  source: "API_KEY" as const,
  status: "SUCCEEDED" as const,
  poolId: "pool1",
  external: true,
  operation: "chat",
  route: "cloud",
  selectedInstanceId: null,
  selectedVersionId: null,
  selectedNodeId: null,
  selectedProviderModelId: "pm1",
  queueWaitMs: 5,
  startedAt: t0,
  firstClientByteAt: new Date(t0.getTime() + 250),
  durationMs: 900,
  promptTokens: 10,
  completionTokens: 20,
  cacheReadTokens: null,
  usageEstimated: false,
  compat: null,
  rejection: null,
  errorClass: null,
  upstreamErrorExcerpt: "messages must be a list",
  httpStatusCode: 200,
  attemptCount: 1,
  resourceOwnerUserId: "owner",
};

beforeEach(() => mockReset(db));

describe("request log", () => {
  it("lists the caller's requests and requests to the caller's resources, prompt-free", async () => {
    db.relayRequest.findMany.mockResolvedValue([request, { ...request, id: "r1" }] as never);
    db.pool.findMany.mockResolvedValue([
      { id: "pool1", slug: "chat", User: { slug: "owner" } },
    ] as never);
    const page = await client().requests.list({ limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      callableId: "owner/chat:external",
      route: "cloud",
      ttftMs: 250,
      attempts: 1,
      upstreamError: "messages must be a list",
    });
    expect(page.nextCursor).not.toBeNull();
    const where = db.relayRequest.findMany.mock.calls[0]?.[0]?.where;
    expect(JSON.stringify(where)).toContain('"resourceOwnerUserId":"owner"');
    const next = await client().requests.list({ limit: 1, cursor: page.nextCursor ?? undefined });
    expect(next.items).toHaveLength(1);
    expect(JSON.stringify(db.relayRequest.findMany.mock.calls[1]?.[0]?.where)).toContain('"lt"');
    // A share holder's request to my pool: its runtime error stays with that requester.
    db.relayRequest.findMany.mockResolvedValueOnce([{ ...request, userId: "grantee" }] as never);
    const theirs = await client().requests.list({ limit: 1 });
    expect(theirs.items[0]?.upstreamError).toBeNull();
  });

  it("hides where another owner's pool ran my request, and keeps placement filters to mine", async () => {
    db.relayRequest.findMany.mockResolvedValue([
      {
        ...request,
        resourceOwnerUserId: "someone-else",
        selectedNodeId: "their-node",
        selectedProviderModelId: "their-model",
      },
    ] as never);
    db.pool.findMany.mockResolvedValue([] as never);
    const page = await client().requests.list({ limit: 10 });
    expect(page.items[0]).toMatchObject({
      nodeId: null,
      providerModelId: null,
      route: null,
      upstreamError: null,
    });
    await client().requests.list({ limit: 10, nodeId: "their-node" });
    expect(JSON.stringify(db.relayRequest.findMany.mock.calls[1]?.[0]?.where)).not.toContain(
      '"userId":"owner"',
    );
  });

  it("refuses a forged cursor", async () => {
    await expect(client().requests.list({ limit: 10, cursor: "bm9wZQ" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });

  it("deletes only the caller's finished requests, and only for a person", async () => {
    await expect(client(AGENT).requests.delete({ ids: ["r1"] })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    db.relayRequest.findMany.mockResolvedValue([{ id: "r1" }] as never);
    db.$transaction.mockImplementation(async (work: unknown) =>
      (work as (tx: typeof db) => Promise<unknown>)(db),
    );
    db.$executeRaw.mockResolvedValue(1);
    await expect(client().requests.delete({ ids: ["r1"] })).resolves.toEqual({ deleted: 1 });
    // Only the caller's own finished rows are picked...
    expect(db.relayRequest.findMany.mock.calls.at(-1)?.[0]?.where).toMatchObject({
      userId: "owner",
      status: { not: "PENDING" },
      OR: [{ resourceOwnerUserId: "owner" }, { resourceOwnerUserId: null }],
    });
    // ...and deleted without waiting (SKIP LOCKED, terminal statuses re-checked).
    const strings = (db.$executeRaw.mock.calls[0]?.[0] ?? []) as unknown as string[];
    const sql = strings.join("?");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(db.relayRequest.deleteMany).not.toHaveBeenCalled();
  });
});

describe("command log", () => {
  it("shows program, state (incl. interrupted by a trust lower) and the agent's name", async () => {
    db.nodeCommand.findMany.mockResolvedValue([
      {
        id: "AAAAAAAAAAAAAAAAAAAAAA",
        createdAt: t0,
        nodeId: "node1",
        actor: "AGENT",
        agentTokenId: "tok1",
        subject: "hmac-sha256:abc nvidia-smi",
        state: "INTERRUPTED",
        exitCode: null,
        startedAt: t0,
        endsBy: new Date(t0.getTime() + 60_000),
        finishedAt: new Date(t0.getTime() + 5_000),
        Node: { slug: "box" },
      },
    ] as never);
    db.agentToken.findMany.mockResolvedValue([{ id: "tok1", name: "claude" }] as never);
    const page = await client().commands.list({ limit: 50 });
    expect(page.items[0]).toMatchObject({
      nodeSlug: "box",
      program: "nvidia-smi",
      state: "INTERRUPTED",
      agentTokenName: "claude",
    });
    expect(JSON.stringify(page)).not.toContain("hmac-sha256");
    expect(db.agentToken.findMany.mock.calls[0]?.[0]?.where).toMatchObject({ userId: "owner" });
  });

  it("names an OAuth agent by its client (rows that name the grant)", async () => {
    db.nodeCommand.findMany.mockResolvedValue([
      {
        id: "BBBBBBBBBBBBBBBBBBBBBB",
        createdAt: t0,
        nodeId: "node1",
        actor: "AGENT",
        agentTokenId: null,
        mcpGrantId: "grant1",
        subject: "hmac-sha256:abc ls",
        state: "SUCCEEDED",
        exitCode: 0,
        startedAt: t0,
        endsBy: new Date(t0.getTime() + 60_000),
        finishedAt: new Date(t0.getTime() + 5_000),
        Node: { slug: "box" },
      },
    ] as never);
    db.mcpGrant.findMany.mockResolvedValue([{ id: "grant1", clientId: "cli-x" }] as never);
    db.oauthClient.findMany.mockResolvedValue([{ clientId: "cli-x", name: "Codex" }] as never);
    const page = await client().commands.list({ limit: 50 });
    expect(page.items[0]).toMatchObject({ agentTokenId: null, agentTokenName: "Codex" });
    expect(db.mcpGrant.findMany.mock.calls[0]?.[0]?.where).toMatchObject({ userId: "owner" });
  });

  it("is a session procedure: no agent tokens", async () => {
    await expect(client(AGENT).commands.list({ limit: 5 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("needs you", () => {
  it("counts the caller's waiting queued commands", async () => {
    db.runtimeInstance.findMany.mockResolvedValue([]);
    db.queuedNodeCommand.count.mockResolvedValue(3);
    await expect(client().needsYou.list()).resolves.toEqual({ items: [], queuedCommands: 3 });
    expect(db.queuedNodeCommand.count.mock.calls[0]?.[0]?.where).toMatchObject({
      userId: "owner",
      state: "QUEUED",
    });
  });

  it("counts the caller's instance needs and queued commands for the nav badge", async () => {
    db.runtimeInstance.count.mockResolvedValue(2);
    db.queuedNodeCommand.count.mockResolvedValue(3);
    await expect(client().needsYou.count()).resolves.toEqual({ count: 5 });
    expect(db.runtimeInstance.count.mock.calls[0]?.[0]?.where).toEqual({
      userId: "owner",
      needsOperator: { not: null },
    });
    expect(db.queuedNodeCommand.count.mock.calls[0]?.[0]?.where).toMatchObject({
      userId: "owner",
      state: "QUEUED",
    });
  });

  it("is a session procedure: no agent tokens", async () => {
    await expect(client(AGENT).needsYou.count()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
