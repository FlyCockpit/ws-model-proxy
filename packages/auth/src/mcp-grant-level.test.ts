import { beforeEach, describe, expect, it, vi } from "vitest";

const tx = vi.hoisted(() => ({
  mcpGrant: { findUnique: vi.fn(), createMany: vi.fn(), updateMany: vi.fn() },
  auditEvent: { create: vi.fn() },
}));
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://proxy.example.com",
    CORS_ORIGIN: undefined,
    BETTER_AUTH_SECRET: "test-secret",
  },
}));
vi.mock("@ws-model-proxy/db", () => ({
  default: {
    ...tx,
    $transaction: (run: (client: typeof tx) => Promise<unknown>) => run(tx),
  },
}));

import {
  approvedScopes,
  consentAccepts,
  consentIssuedCode,
  consentLevelOf,
} from "./mcp-consent-level";
import {
  type McpGrantLevelLoweredEvent,
  onMcpGrantLevelLowered,
  recordConsentedMcpGrantLevel,
} from "./mcp-grant-level";

const KEY = { userId: "u1", clientId: "https://client.example/meta", referenceId: "r".repeat(64) };

beforeEach(() => {
  for (const fn of [
    tx.mcpGrant.findUnique,
    tx.mcpGrant.createMany,
    tx.mcpGrant.updateMany,
    tx.auditEvent.create,
  ])
    fn.mockReset();
  tx.mcpGrant.updateMany.mockResolvedValue({ count: 1 });
  tx.mcpGrant.createMany.mockResolvedValue({ count: 0 });
});

describe("consent body parsing (the person's choice only)", () => {
  it("defaults to Read-only and accepts exactly READ or FULL", () => {
    expect(consentLevelOf({ accept: true })).toBe("READ");
    expect(consentLevelOf({ accept: true, level: "FULL" })).toBe("FULL");
    expect(consentLevelOf({ accept: true, level: "READ" })).toBe("READ");
    expect(consentLevelOf({ accept: true, level: "full" })).toBeNull();
    expect(consentLevelOf({ accept: true, level: ["FULL"] })).toBeNull();
    expect(consentLevelOf({ accept: true, level: null })).toBeNull();
    expect(consentLevelOf(null)).toBe("READ");
  });

  it("treats only accept === true as an approval", () => {
    expect(consentAccepts({ accept: true })).toBe(true);
    expect(consentAccepts({ accept: "true" })).toBe(false);
    expect(consentAccepts({})).toBe(false);
  });

  it("reads the approved scopes from a narrowed body scope, else the signed query", () => {
    expect(approvedScopes({ scope: "mcp:read" }, "scope=mcp%3Aread+mcp%3Awrite")).toEqual([
      "mcp:read",
    ]);
    expect(approvedScopes({}, "scope=mcp%3Aread+mcp%3Awrite")).toEqual(["mcp:read", "mcp:write"]);
    expect(approvedScopes({}, null)).toEqual([]);
  });

  it("recognizes only a redirect carrying a code", () => {
    expect(consentIssuedCode({ redirect: true, url: "https://c.example/cb?code=x" })).toBe(true);
    expect(consentIssuedCode({ redirect: true, url: "myapp://cb?code=x&state=s" })).toBe(true);
    expect(
      consentIssuedCode({ redirect: true, url: "https://c.example/cb?error=access_denied" }),
    ).toBe(false);
    expect(consentIssuedCode({ redirect: true, url: "/en-US/mcp-login?x=1" })).toBe(false);
    expect(
      consentIssuedCode({ redirect: true, url: "https://c.example/cb?code=static&error=x" }),
    ).toBe(false);
    expect(consentIssuedCode({ redirect: false, url: "https://c.example/cb?code=x" })).toBe(false);
    expect(consentIssuedCode(new Error("x"))).toBe(false);
  });
});

describe("recordConsentedMcpGrantLevel", () => {
  it("creates the absent grant at the chosen level and audits the person's choice", async () => {
    tx.mcpGrant.createMany.mockResolvedValue({ count: 1 });
    tx.mcpGrant.findUnique.mockResolvedValue({ id: "g1", level: "FULL", revokedAt: null });
    const change = await recordConsentedMcpGrantLevel({ ...KEY, level: "FULL" });
    expect(change).toEqual({ grantId: "g1", before: null, after: "FULL", lowered: false });
    expect(tx.mcpGrant.createMany.mock.calls[0]?.[0]).toEqual({
      data: [{ ...KEY, level: "FULL" }],
      skipDuplicates: true,
    });
    expect(tx.mcpGrant.findUnique.mock.calls[0]?.[0]?.where).toEqual({
      userId_clientId_referenceId: KEY,
    });
    expect(tx.auditEvent.create.mock.calls[0]?.[0]?.data).toMatchObject({
      userId: "u1",
      actor: "USER",
      actorUserId: "u1",
      action: "mcp_grant.consent",
      resourceType: "mcp_grant",
      resourceId: "g1",
      after: { level: "FULL" },
    });
  });

  it("re-approval at Read-only lowers a Full grant and reports it after the commit", async () => {
    const events: McpGrantLevelLoweredEvent[] = [];
    const off = onMcpGrantLevelLowered((event) => {
      events.push(event);
    });
    try {
      tx.mcpGrant.findUnique.mockResolvedValue({ id: "g1", level: "FULL", revokedAt: null });
      const change = await recordConsentedMcpGrantLevel({ ...KEY, level: "READ" });
      expect(change?.lowered).toBe(true);
      expect(tx.mcpGrant.updateMany.mock.calls[0]?.[0]).toEqual({
        where: { id: "g1", userId: "u1", revokedAt: null, level: "FULL" },
        data: { level: "READ" },
      });
      expect(events).toEqual([{ userId: "u1", grantId: "g1" }]);
    } finally {
      off();
    }
  });

  it("leaves a tombstoned generation alone (code exchange rejects it)", async () => {
    tx.mcpGrant.findUnique.mockResolvedValue({ id: "g1", level: "FULL", revokedAt: new Date() });
    expect(await recordConsentedMcpGrantLevel({ ...KEY, level: "READ" })).toBeNull();
    expect(tx.mcpGrant.updateMany).not.toHaveBeenCalled();
    expect(tx.auditEvent.create).not.toHaveBeenCalled();
  });

  it("writes nothing when the re-approval keeps the level", async () => {
    tx.mcpGrant.findUnique.mockResolvedValue({ id: "g1", level: "READ", revokedAt: null });
    const change = await recordConsentedMcpGrantLevel({ ...KEY, level: "READ" });
    expect(change).toEqual({ grantId: "g1", before: "READ", after: "READ", lowered: false });
    expect(tx.mcpGrant.updateMany).not.toHaveBeenCalled();
    expect(tx.auditEvent.create).not.toHaveBeenCalled();
  });

  it("retries on a concurrent level change instead of dropping the person's choice", async () => {
    tx.mcpGrant.findUnique
      .mockResolvedValueOnce({ id: "g1", level: "READ", revokedAt: null })
      .mockResolvedValueOnce({ id: "g1", level: "READ", revokedAt: null });
    tx.mcpGrant.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    const change = await recordConsentedMcpGrantLevel({ ...KEY, level: "FULL" });
    expect(change).toEqual({ grantId: "g1", before: "READ", after: "FULL", lowered: false });
    expect(tx.mcpGrant.updateMany).toHaveBeenCalledTimes(2);
  });

  it("throws (so the code is withheld) when the change keeps conflicting", async () => {
    tx.mcpGrant.findUnique.mockResolvedValue({ id: "g1", level: "READ", revokedAt: null });
    tx.mcpGrant.updateMany.mockResolvedValue({ count: 0 });
    await expect(recordConsentedMcpGrantLevel({ ...KEY, level: "FULL" })).rejects.toThrow();
    expect(tx.auditEvent.create).not.toHaveBeenCalled();
  });
});
