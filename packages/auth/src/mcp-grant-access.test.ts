import { beforeEach, describe, expect, it, vi } from "vitest";

const tx = vi.hoisted(() => ({
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
  session: { findFirst: vi.fn() },
  mcpGrant: { findFirst: vi.fn(), findUnique: vi.fn(), createMany: vi.fn(), updateMany: vi.fn() },
  mcpGrantNode: { deleteMany: vi.fn(), createMany: vi.fn() },
  node: { findMany: vi.fn() },
  auditEvent: { create: vi.fn() },
}));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_URL: "https://proxy.example.com", BETTER_AUTH_SECRET: "test-secret" },
}));
vi.mock("@ws-model-proxy/db", () => ({
  default: { ...tx, $transaction: (run: (client: typeof tx) => Promise<unknown>) => run(tx) },
}));

import prisma from "@ws-model-proxy/db";
import {
  ALL_AGENT_SCOPES,
  accessNarrowed,
  agentScopeFromDb,
  agentScopeToDb,
  oauthScopeCeiling,
} from "./agent-scopes";
import {
  approvedScopes,
  consentAccepts,
  consentAccessOf,
  consentIssuedCode,
} from "./mcp-consent-level";
import {
  type AgentAccessNarrowedEvent,
  onMcpGrantAccessNarrowed,
  readMcpGrantAccess,
  recordConsentedMcpGrantAccess,
  setActiveMcpGrantAccess,
} from "./mcp-grant-access";

const KEY = {
  sessionId: "s1",
  userId: "u1",
  clientId: "https://client.example/meta",
  referenceId: "r".repeat(64),
};
const read = { scopes: ["read"] as const, nodeIds: null };
const full = { scopes: ALL_AGENT_SCOPES, nodeIds: null };
const stored = (access = full) => ({
  id: "g1",
  revokedAt: null,
  scopes: access.scopes.map(agentScopeToDb),
  allNodes: access.nodeIds === null,
  Nodes: [],
});
beforeEach(() => {
  vi.resetAllMocks();
  tx.session.findFirst.mockResolvedValue({ id: "s1" });
  tx.$queryRaw.mockResolvedValue([{ acquired: true }]);
  tx.mcpGrant.updateMany.mockResolvedValue({ count: 1 });
  tx.mcpGrant.createMany.mockResolvedValue({ count: 0 });
  tx.mcpGrant.findUnique.mockResolvedValue(stored());
  tx.mcpGrant.findFirst.mockResolvedValue(stored());
  tx.node.findMany.mockResolvedValue([{ id: "n1" }]);
});
describe("consent access and OAuth ceilings", () => {
  it("requires read, rejects unknown scopes and malformed nodes, defaults to read/all", () => {
    expect(consentAccessOf({ accept: true })).toEqual(read);
    expect(consentAccessOf({ scopes: ["read", "files"], nodeIds: [] })).toEqual({
      scopes: ["read", "files"],
      nodeIds: [],
    });
    for (const scopes of [["files"], ["READ"], ["read", "other"], null, "read"])
      expect(consentAccessOf({ scopes })).toBeNull();
    expect(consentAccessOf({ nodeIds: [1] })).toBeNull();
    expect(consentAccepts({ accept: "true" })).toBe(false);
    expect(approvedScopes({ scope: "mcp:read" }, "scope=mcp%3Awrite")).toEqual(["mcp:read"]);
    expect(approvedScopes({}, "scope=mcp%3Aread+mcp%3Afiles")).toEqual(["mcp:read", "mcp:files"]);
    expect(consentIssuedCode({ redirect: true, url: "https://c.example/cb?code=x" })).toBe(true);
    expect(consentIssuedCode({ redirect: true, url: "https://c.example/cb?code=x&error=x" })).toBe(
      false,
    );
  });
  it("maps stored scopes bijectively and computes literal fine-scope ceilings", () => {
    for (const scope of ALL_AGENT_SCOPES)
      expect(agentScopeFromDb(agentScopeToDb(scope))).toBe(scope);
    expect(oauthScopeCeiling(["mcp:write"])).toEqual(["read"]);
    expect(oauthScopeCeiling(["mcp:read", "mcp:files", "mcp:commands"])).toEqual([
      "read",
      "commands",
      "files",
    ]);
    expect(oauthScopeCeiling(["MCP:WRITE", "mcp:write "])).toEqual(["read"]);
  });
  it("recognizes every form of narrowing", () => {
    expect(accessNarrowed(full, read)).toBe(true);
    expect(accessNarrowed(read, { ...read, nodeIds: [] })).toBe(true);
    expect(accessNarrowed({ ...read, nodeIds: ["a", "b"] }, { ...read, nodeIds: ["b"] })).toBe(
      true,
    );
    expect(accessNarrowed({ ...read, nodeIds: ["a"] }, full)).toBe(false);
  });
});
describe("grant access storage", () => {
  it("refuses browser consent from a session deleted before the owner fence was acquired", async () => {
    tx.$queryRaw.mockImplementationOnce(async () => {
      tx.session.findFirst.mockResolvedValueOnce(null);
      return [{ acquired: true }];
    });
    await expect(recordConsentedMcpGrantAccess({ ...KEY, ...read })).rejects.toMatchObject({
      status: "UNAUTHORIZED",
    });
    expect(tx.mcpGrant.createMany).not.toHaveBeenCalled();
    expect(tx.$queryRaw.mock.calls[0]?.slice(1)).toEqual([["00:owner:u1"], true]);
    expect(tx.session.findFirst).toHaveBeenCalledWith({
      where: { id: "s1", userId: "u1", expiresAt: { gt: expect.any(Date) } },
      select: { id: true },
    });
  });
  it("creates and audits the exact consent generation with its selected nodes", async () => {
    tx.mcpGrant.createMany.mockResolvedValue({ count: 1 });
    const change = await recordConsentedMcpGrantAccess({
      ...KEY,
      scopes: ["read", "files"],
      nodeIds: ["n1"],
    });
    expect(change).toMatchObject({
      before: null,
      narrowed: false,
      after: { scopes: ["read", "files"], nodeIds: ["n1"] },
    });
    expect(tx.mcpGrantNode.createMany).toHaveBeenCalledWith({
      data: [{ grantId: "g1", userId: "u1", nodeId: "n1" }],
    });
    expect(tx.mcpGrant.findUnique.mock.calls[0]?.[0].where).toEqual({
      userId_clientId_referenceId: {
        userId: KEY.userId,
        clientId: KEY.clientId,
        referenceId: KEY.referenceId,
      },
    });
    expect(tx.auditEvent.create.mock.calls[0]?.[0].data).toMatchObject({
      actor: "USER",
      after: { scopes: ["read", "files"], nodeIds: ["n1"] },
    });
  });
  it("notifies narrowing only after commit and isolates listener failures", async () => {
    const events: AgentAccessNarrowedEvent[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const offFail = onMcpGrantAccessNarrowed(() => {
      throw new Error("offline");
    });
    const off = onMcpGrantAccessNarrowed((event) => {
      events.push(event);
    });
    try {
      const change = await recordConsentedMcpGrantAccess({ ...KEY, ...read });
      expect(change?.narrowed).toBe(true);
      expect(events).toEqual([
        {
          kind: "oauth_grant",
          userId: "u1",
          grantId: "g1",
          agentTokenId: null,
          before: full,
          after: read,
        },
      ]);
      expect(tx.mcpGrant.updateMany.mock.calls[0]?.[0].where).toMatchObject({
        scopes: { equals: ALL_AGENT_SCOPES.map(agentScopeToDb) },
        allNodes: true,
      });
    } finally {
      off();
      offFail();
      errors.mockRestore();
    }
  });
  it("never rewrites a tombstone", async () => {
    tx.mcpGrant.findUnique.mockResolvedValue({ ...stored(), revokedAt: new Date() });
    expect(await recordConsentedMcpGrantAccess({ ...KEY, ...read })).toBeNull();
    expect(tx.mcpGrant.updateMany).not.toHaveBeenCalled();
  });
  it("rejects another owner's node before creating a grant", async () => {
    tx.node.findMany.mockResolvedValue([]);
    await expect(
      recordConsentedMcpGrantAccess({ ...KEY, scopes: ["read"], nodeIds: ["theirs"] }),
    ).rejects.toThrow("do not exist");
    expect(tx.mcpGrant.createMany).not.toHaveBeenCalled();
  });
  it("does not write unchanged access", async () => {
    tx.mcpGrant.findUnique.mockResolvedValue(stored(read));
    tx.mcpGrant.findFirst.mockResolvedValue(stored(read));
    const change = await recordConsentedMcpGrantAccess({ ...KEY, ...read });
    expect(change?.narrowed).toBe(false);
    expect(tx.mcpGrant.updateMany).not.toHaveBeenCalled();
  });
  it("retries a conditional conflict and fails closed on repeated conflicts", async () => {
    tx.mcpGrant.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    expect((await recordConsentedMcpGrantAccess({ ...KEY, ...read }))?.narrowed).toBe(true);
    tx.mcpGrant.updateMany.mockResolvedValue({ count: 0 });
    await expect(recordConsentedMcpGrantAccess({ ...KEY, ...read })).rejects.toThrow(
      "concurrently",
    );
  });
  it("compares the node snapshot, not only scopes", async () => {
    tx.mcpGrant.findFirst.mockResolvedValue({
      ...stored(read),
      allNodes: false,
      Nodes: [{ nodeId: "n1" }],
    });
    expect(
      await setActiveMcpGrantAccess(prisma, {
        grantId: "g1",
        userId: "u1",
        expected: read,
        access: full,
        action: "test",
      }),
    ).toBeNull();
  });
  it("reads effective nodes and ignores stale node rows while allNodes is true", async () => {
    tx.mcpGrant.findFirst.mockResolvedValue({ ...stored(read), Nodes: [{ nodeId: "n1" }] });
    expect(await readMcpGrantAccess(prisma, "g1")).toEqual(read);
    tx.mcpGrant.findFirst.mockResolvedValue({
      ...stored(read),
      allNodes: false,
      Nodes: [{ nodeId: "n1" }],
    });
    expect(await readMcpGrantAccess(prisma, "g1")).toEqual({ scopes: ["read"], nodeIds: ["n1"] });
  });
});
