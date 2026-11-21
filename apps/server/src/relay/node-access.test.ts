import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const policy = vi.hoisted(() => ({ env: { WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY: true as boolean } }));
vi.mock("@ws-model-proxy/env/server", () => ({ env: policy.env }));

const live = vi.hoisted(() => ({ getLiveNodeState: vi.fn() }));
vi.mock("./session-manager.js", () => ({ relaySessionManager: live }));

const { default: prisma } = await import("@ws-model-proxy/db");
const {
  judgeNodeAgentAccess,
  openNodeAgentAccessCountForTests,
  readNodeAgentAccess,
  resetNodeAgentAccessForTests,
  revokeOpenNodeAgentAccess,
  narrowOpenNodeAgentAccess,
  revokeOpenNodeAgentAccessForUser,
} = await import("./node-access.js");

const db = prisma as unknown as {
  node: { findUnique: MockInstance };
  agentToken: { findFirst: MockInstance };
  mcpGrant: { findFirst: MockInstance; findUnique: MockInstance };
  user: { findUnique: MockInstance };
};

const input = { userId: "user-1", tokenId: "tok-1", expiresAt: null, nodeId: "node-1" };

function liveState(overrides: Record<string, unknown> = {}) {
  return {
    nodeId: "node-1",
    userId: "user-1",
    trust: "full",
    features: { files: { roots: ["/home/me"], asRoot: false, source: "configured" } },
    ...overrides,
  };
}

describe("node agent access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetNodeAgentAccessForTests();
    db.node.findUnique.mockResolvedValue({
      id: "node-1",
      userId: "user-1",
      slug: "box",
      trust: "FULL",
      trustLowerRequestedAt: null,
      rejectedProtocolVersion: null,
    });
    db.agentToken.findFirst.mockResolvedValue({
      name: "agent",
      expiresAt: null,
      grantId: "grant-1",
    });
    db.mcpGrant.findFirst.mockResolvedValue({
      scopes: ["READ", "COMMANDS", "FILES"],
      allNodes: true,
      Nodes: [],
    });
    db.user.findUnique.mockResolvedValue({
      banned: false,
      banExpires: null,
      deletionRequestedAt: null,
    });
    live.getLiveNodeState.mockReturnValue(liveState());
  });

  async function verdict(capability: "command" | "file_read" | "file_write" = "file_read") {
    return judgeNodeAgentAccess(await readNodeAgentAccess(input, capability), capability);
  }

  it("admits a scoped token on a Full-control node with file roots", async () => {
    await expect(verdict()).resolves.toMatchObject({ ok: true, fileRoots: ["/home/me"] });
    expect(db.agentToken.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "tok-1",
          userId: "user-1",
          grant: { revokedAt: null, userId: "user-1" },
          revokedAt: null,
        }),
      }),
    );
    expect(openNodeAgentAccessCountForTests()).toBe(0);
  });

  it("excludes no-expiry tokens from the live-token read only while no-expiry tokens are off", async () => {
    await verdict();
    expect(db.agentToken.findFirst.mock.calls.at(-1)?.[0]?.where?.OR).toEqual([
      { expiresAt: null },
      { expiresAt: { gt: expect.any(Date) } },
    ]);
    try {
      policy.env.WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY = false;
      await verdict();
      expect(db.agentToken.findFirst.mock.calls.at(-1)?.[0]?.where?.OR).toEqual([
        { expiresAt: { gt: expect.any(Date) } },
      ]);
    } finally {
      policy.env.WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY = true;
    }
  });

  it("re-judges the policy in the synchronous verdict: a flip during the owner read refuses", async () => {
    try {
      db.user.findUnique.mockImplementationOnce(async () => {
        policy.env.WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY = false;
        return { banned: false, banExpires: null, deletionRequestedAt: null };
      });
      await expect(verdict()).resolves.toEqual({ ok: false, error: "token_inactive" });
      // A dated token is not affected by the flag.
      db.agentToken.findFirst.mockResolvedValueOnce({
        name: "agent",
        expiresAt: new Date(Date.now() + 86_400_000),
        grantId: "grant-1",
      });
      await expect(verdict()).resolves.toMatchObject({ ok: true });
      // OAuth grants are never agent tokens.
      expect(
        judgeNodeAgentAccess(
          await readNodeAgentAccess({ ...input, credentialKind: "oauth_grant" }, "file_read"),
          "file_read",
        ),
      ).toMatchObject({ ok: true });
    } finally {
      policy.env.WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY = true;
    }
  });

  it("refuses an inactive token, a foreign node and a blocked owner", async () => {
    db.agentToken.findFirst.mockResolvedValueOnce(null);
    await expect(verdict()).resolves.toEqual({ ok: false, error: "token_inactive" });
    db.node.findUnique.mockResolvedValueOnce({ id: "node-1", userId: "other" });
    await expect(verdict()).resolves.toEqual({ ok: false, error: "unknown_node" });
    db.user.findUnique.mockResolvedValueOnce({
      banned: true,
      banExpires: null,
      deletionRequestedAt: null,
    });
    await expect(verdict()).resolves.toEqual({ ok: false, error: "token_inactive" });
  });

  it.each(["command", "file_read", "file_write"] as const)(
    "refuses %s on another user's node even when reachable through a shared pool",
    async (capability) => {
      db.node.findUnique.mockResolvedValueOnce({ id: "node-1", userId: "pool-owner" });
      await expect(verdict(capability)).resolves.toEqual({ ok: false, error: "unknown_node" });
    },
  );

  it.each(["command", "file_read"] as const)(
    "refuses %s on a node outside its live list",
    async (capability) => {
      db.mcpGrant.findFirst.mockResolvedValueOnce({
        scopes: ["READ", "COMMANDS", "FILES"],
        allNodes: false,
        Nodes: [{ nodeId: "other-node" }],
      });
      await expect(verdict(capability)).resolves.toEqual({ ok: false, error: "unknown_node" });
    },
  );

  it.each(["command", "file_read"] as const)(
    "refuses %s after its required live scope was removed",
    async (capability) => {
      db.mcpGrant.findFirst.mockResolvedValueOnce({ scopes: ["READ"], allNodes: true, Nodes: [] });
      await expect(verdict(capability)).resolves.toEqual({ ok: false, error: "token_inactive" });
    },
  );

  it("narrowing fences only admissions outside the new scope or node set", async () => {
    const reads = await readNodeAgentAccess(input, "file_read");
    narrowOpenNodeAgentAccess(input.tokenId, {
      scopes: ["read", "files"],
      nodeIds: [input.nodeId],
    });
    expect(judgeNodeAgentAccess(reads, "file_read")).toMatchObject({ ok: true });
    const removedNode = await readNodeAgentAccess(input, "file_read");
    narrowOpenNodeAgentAccess(input.tokenId, { scopes: ["read", "files"], nodeIds: [] });
    expect(judgeNodeAgentAccess(removedNode, "file_read")).toEqual({
      ok: false,
      error: "token_inactive",
    });
    const removedScope = await readNodeAgentAccess(input, "command");
    narrowOpenNodeAgentAccess(input.tokenId, { scopes: ["read", "files"], nodeIds: null });
    expect(judgeNodeAgentAccess(removedScope, "command")).toEqual({
      ok: false,
      error: "token_inactive",
    });
  });

  it("refuses Relay only: stored, pending lowering, or live", async () => {
    db.node.findUnique.mockResolvedValueOnce({
      id: "node-1",
      userId: "user-1",
      trust: "RELAY",
      trustLowerRequestedAt: null,
    });
    await expect(verdict("command")).resolves.toEqual({ ok: false, error: "trust_relay" });
    db.node.findUnique.mockResolvedValueOnce({
      id: "node-1",
      userId: "user-1",
      trust: "FULL",
      trustLowerRequestedAt: new Date(),
    });
    await expect(verdict("command")).resolves.toEqual({ ok: false, error: "trust_relay" });
    live.getLiveNodeState.mockReturnValueOnce(liveState({ trust: "relay" }));
    await expect(verdict("command")).resolves.toEqual({ ok: false, error: "trust_relay" });
  });

  it("says offline, or upgrade_wsmp for a node refused for its protocol", async () => {
    live.getLiveNodeState.mockReturnValue(null);
    await expect(verdict()).resolves.toEqual({ ok: false, error: "node_offline" });
    db.node.findUnique.mockResolvedValueOnce({
      id: "node-1",
      userId: "user-1",
      trust: "FULL",
      trustLowerRequestedAt: null,
      rejectedProtocolVersion: "2.9",
    });
    await expect(verdict()).resolves.toEqual({
      ok: false,
      error: "upgrade_wsmp",
      rejectedProtocolVersion: "2.9",
    });
  });

  it("refuses file ops without roots but admits commands", async () => {
    live.getLiveNodeState.mockReturnValue(liveState({ features: { files: { roots: null } } }));
    await expect(verdict("file_write")).resolves.toEqual({ ok: false, error: "no_roots" });
    await expect(verdict("command")).resolves.toMatchObject({ ok: true });
  });

  it("refuses an admission revoked while it was reading", async () => {
    const reads = await readNodeAgentAccess(input);
    revokeOpenNodeAgentAccess("tok-1");
    expect(judgeNodeAgentAccess(reads, "command")).toEqual({ ok: false, error: "token_inactive" });
    const banned = await readNodeAgentAccess(input);
    revokeOpenNodeAgentAccessForUser("user-1");
    expect(judgeNodeAgentAccess(banned, "command")).toEqual({ ok: false, error: "token_inactive" });
  });
});
