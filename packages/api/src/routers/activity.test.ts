import { createRouterClient } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../db/prisma/generated/client";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123" },
}));
vi.mock("@ws-model-proxy/db", async () => ({
  default: mockDeep<PrismaClient>(),
  Prisma: await import("../../../db/prisma/generated/internal/prismaNamespace"),
}));
vi.mock("@ws-model-proxy/auth", () => ({ auth: { api: {} } }));
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: vi.fn(async () => false),
}));

import prisma from "@ws-model-proxy/db";
import type { Context } from "../context";
import type { CallerAuth } from "../contracts/auth-context";
import { hiddenInstancesWhere } from "../lib/agent-hidden-nodes";
import { servedSinceWhere } from "../lib/agent-hidden-serving";
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
  access: {
    scopes: ["read", "pools", "runtimes", "nodes:manage", "commands", "files", "models:test"],
    nodeIds: null,
  },
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

beforeEach(() => {
  mockReset(db);
  db.runtimeInstance.findMany.mockResolvedValue([]);
});

describe("agent request row projections", () => {
  for (const kind of ["agent_token", "oauth_access_token"] as const) {
    for (const nodeIds of [["allowed"], [], null])
      it(`${kind}: preserves other-node and unplaced rows with ${JSON.stringify(nodeIds)}`, async () => {
        const access = { scopes: ["read"] as const, nodeIds };
        const auth: CallerAuth =
          kind === "agent_token"
            ? { kind, userId: "owner", agentTokenId: "t", access }
            : { kind, userId: "owner", grantId: "g", access };
        db.node.findMany.mockResolvedValue([{ id: "allowed" }, { id: "hidden" }] as never);
        // These are rows the database keeps under the node exclusion predicate: an own
        // resource on another user's node, another owner's pool, and an unplaced request.
        db.relayRequest.findMany.mockResolvedValue([
          { ...request, id: "own-shared", selectedNodeId: "foreign", selectedInstanceId: "i1" },
          { ...request, id: "other-pool", resourceOwnerUserId: "other", selectedNodeId: "foreign" },
          { ...request, id: "unplaced", selectedNodeId: null },
        ] as never);
        db.pool.findMany.mockResolvedValue([]);
        const page = await client(auth).requests.list({ limit: 10 });
        expect(page.items.map((row) => row.id)).toEqual(["own-shared", "other-pool", "unplaced"]);
        expect(page.items[0]).toMatchObject({
          nodeId: "foreign",
          instanceId: "i1",
          upstreamError: request.upstreamErrorExcerpt,
        });
        expect(page.items[1]).toMatchObject({
          nodeId: null,
          instanceId: null,
          route: null,
          upstreamError: null,
        });
        expect(page.items[2]?.nodeId).toBeNull();
        expect(page.nextCursor).toBeNull();
      });
    for (const [nodeIds, filtered] of [
      [["allowed"], true],
      [null, false],
    ] as const)
      it(`${kind}: ${JSON.stringify(nodeIds)} leaves out requests a mixed instance served on an allowed node`, async () => {
        const access = { scopes: ["read"] as const, nodeIds };
        const auth: CallerAuth =
          kind === "agent_token"
            ? { kind, userId: "owner", agentTokenId: "t", access }
            : { kind, userId: "owner", grantId: "g", access };
        db.node.findMany.mockResolvedValue([{ id: "allowed" }, { id: "hidden" }] as never);
        // inst-mixed's head is on the allowed node; another rank is on the hidden one.
        db.runtimeInstance.findMany.mockResolvedValue([{ id: "inst-mixed" }] as never);
        const oldest = new Date("2026-11-01T00:00:00.000Z");
        db.relayRequest.findFirst.mockResolvedValue({ createdAt: oldest } as never);
        db.relayRequest.findMany.mockResolvedValue([]);
        db.pool.findMany.mockResolvedValue([]);
        await client(auth).requests.list({ limit: 10 });
        const where = db.relayRequest.findMany.mock.calls[0]?.[0]?.where as {
          AND: unknown[];
        };
        const mixed = {
          OR: [{ selectedInstanceId: null }, { selectedInstanceId: { notIn: ["inst-mixed"] } }],
        };
        const node = { OR: [{ selectedNodeId: null }, { selectedNodeId: { notIn: ["hidden"] } }] };
        if (filtered) {
          expect(where.AND).toContainEqual(mixed);
          expect(where.AND).toContainEqual(node);
          // Only instances that may have served the oldest row the same filters can return.
          expect(db.relayRequest.findFirst.mock.calls[0]?.[0]).toMatchObject({
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          });
          expect(db.runtimeInstance.findMany).toHaveBeenCalledExactlyOnceWith({
            where: { AND: [hiddenInstancesWhere(["hidden"]), servedSinceWhere(oldest)] },
            select: { id: true },
          });
        } else {
          expect(JSON.stringify(where)).not.toContain("inst-mixed");
          expect(db.relayRequest.findFirst).not.toHaveBeenCalled();
          expect(db.runtimeInstance.findMany).not.toHaveBeenCalled();
        }
      });
    it(`${kind}: with no candidate row, looks up no instance and still filters hidden nodes`, async () => {
      const access = { scopes: ["read"] as const, nodeIds: ["allowed"] };
      const auth: CallerAuth =
        kind === "agent_token"
          ? { kind, userId: "owner", agentTokenId: "t", access }
          : { kind, userId: "owner", grantId: "g", access };
      db.node.findMany.mockResolvedValue([{ id: "allowed" }, { id: "hidden" }] as never);
      db.relayRequest.findFirst.mockResolvedValue(null);
      db.relayRequest.findMany.mockResolvedValue([]);
      await client(auth).requests.list({ limit: 10 });
      expect(db.runtimeInstance.findMany).not.toHaveBeenCalled();
      const where = db.relayRequest.findMany.mock.calls[0]?.[0]?.where as { AND: unknown[] };
      expect(where.AND).toContainEqual({
        OR: [{ selectedNodeId: null }, { selectedNodeId: { notIn: ["hidden"] } }],
      });
    });
    it(`${kind}: preserves placement fields for an allowed own-node filter`, async () => {
      const access = { scopes: ["read"] as const, nodeIds: ["allowed"] };
      const auth: CallerAuth =
        kind === "agent_token"
          ? { kind, userId: "owner", agentTokenId: "t", access }
          : { kind, userId: "owner", grantId: "g", access };
      db.node.findMany.mockResolvedValue([{ id: "allowed" }] as never);
      db.relayRequest.findMany.mockResolvedValue([
        {
          ...request,
          selectedNodeId: "allowed",
          selectedInstanceId: "i1",
          selectedVersionId: "v1",
        },
      ] as never);
      db.pool.findMany.mockResolvedValue([]);
      const page = await client(auth).requests.list({ nodeId: "allowed" });
      expect(page.items[0]).toMatchObject({
        nodeId: "allowed",
        instanceId: "i1",
        versionId: "v1",
        route: "cloud",
      });
    });
  }
});

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
    db.claimReleaseRequest.findMany.mockResolvedValue([]);
    await expect(client().needsYou.list()).resolves.toEqual({
      items: [],
      queuedCommands: 3,
      releaseRequests: [],
    });
    expect(db.queuedNodeCommand.count.mock.calls[0]?.[0]?.where).toMatchObject({
      userId: "owner",
      state: "QUEUED",
    });
  });

  it("lists agents' pending release requests with their runtime and node", async () => {
    db.runtimeInstance.findMany.mockResolvedValue([]);
    db.queuedNodeCommand.count.mockResolvedValue(0);
    const createdAt = new Date("2026-10-09T10:00:00Z");
    db.claimReleaseRequest.findMany.mockResolvedValue([
      {
        id: "req1",
        createdAt,
        Rank: {
          rank: 1,
          nodeId: "node2",
          Instance: { id: "inst1", runtimeId: "rt1", Runtime: { name: "Qwen" } },
        },
      },
    ] as never);
    await expect(client().needsYou.list()).resolves.toMatchObject({
      releaseRequests: [
        {
          requestId: "req1",
          instanceId: "inst1",
          runtimeId: "rt1",
          runtimeName: "Qwen",
          nodeId: "node2",
          nodeNumber: 2,
          since: createdAt.toISOString(),
        },
      ],
    });
    // Only the caller's, still pending, not expired, and only while the claim is marked stopped.
    expect(db.claimReleaseRequest.findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      userId: "owner",
      state: "PENDING",
      Rank: { claim: "HELD_UNKNOWN" },
    });
  });

  it("counts the caller's instance needs, queued commands and release requests for the nav badge", async () => {
    db.runtimeInstance.count.mockResolvedValue(2);
    db.queuedNodeCommand.count.mockResolvedValue(3);
    db.claimReleaseRequest.count.mockResolvedValue(1);
    await expect(client().needsYou.count()).resolves.toEqual({ count: 6 });
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
