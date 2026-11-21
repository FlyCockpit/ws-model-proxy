import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  queuedNodeCommand: { updateMany: vi.fn(async () => ({ count: 1 })) },
  claimReleaseRequest: { updateMany: vi.fn(async () => ({ count: 1 })) },
}));
vi.mock("@ws-model-proxy/db", () => ({ default: db }));
const files = vi.hoisted(() => ({
  cancelFileOpsForToken: vi.fn(),
  cancelFileOpsForNarrowedCredential: vi.fn(),
}));
vi.mock("./relay/node-file-ops.js", () => files);

const { endAgentWork, endNarrowedAgentWork, handleAgentAccessNarrowed, handleAccessRevoked } =
  await import("./access-revocation.js");

function deps() {
  return {
    terminateRealtimeForApiKey: vi.fn(),
    cancelMcpToolCalls: vi.fn(() => 1),
    recheckRealtime: vi.fn(async () => undefined),
    endAgentWork: vi.fn(async () => undefined),
  };
}

describe("handleAccessRevoked", () => {
  it("closes an API key's realtime sessions and nothing else", async () => {
    const d = deps();
    await handleAccessRevoked({ kind: "api_key", userId: "u", apiKeyId: "k1" }, d);
    expect(d.terminateRealtimeForApiKey).toHaveBeenCalledWith("k1");
    expect(d.cancelMcpToolCalls).not.toHaveBeenCalled();
    expect(d.endAgentWork).not.toHaveBeenCalled();
  });

  it("ends an agent token's tool calls and work under both of its ids", async () => {
    const d = deps();
    await handleAccessRevoked(
      { kind: "agent_token", userId: "u", agentTokenId: "t1", grantId: "g1" },
      d,
    );
    expect(d.cancelMcpToolCalls.mock.calls).toEqual([["t1"], ["g1"]]);
    expect(d.endAgentWork).toHaveBeenCalledWith({ userId: "u", credentialIds: ["t1", "g1"] });
    expect(d.terminateRealtimeForApiKey).not.toHaveBeenCalled();
  });

  it("ends an OAuth grant's calls and work; a share rechecks realtime now", async () => {
    const d = deps();
    await handleAccessRevoked(
      { kind: "oauth_grant", userId: "u", grantId: "g2", clientId: "c" },
      d,
    );
    expect(d.cancelMcpToolCalls.mock.calls).toEqual([["g2"]]);
    expect(d.endAgentWork).toHaveBeenCalledWith({ userId: "u", credentialIds: ["g2"] });
    await handleAccessRevoked(
      { kind: "share", ownerUserId: "o", granteeUserId: "g", poolId: "p" },
      d,
    );
    expect(d.recheckRealtime).toHaveBeenCalledWith("g");
  });
});

describe("endAgentWork", () => {
  it("cancels the credentials' file ops before anything awaits", () => {
    files.cancelFileOpsForToken.mockClear();
    void endAgentWork({ userId: "u", credentialIds: ["t1", "g1"] });
    // Synchronously: no file op of a revoked credential outlives the revoke call.
    expect(files.cancelFileOpsForToken.mock.calls).toEqual([["t1"], ["g1"]]);
  });

  it("expires the credentials' queued commands", async () => {
    await endAgentWork({ userId: "u", credentialIds: ["t1", "g1"] });
    expect(db.queuedNodeCommand.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "u",
        state: "QUEUED",
        OR: [{ agentTokenId: { in: ["t1", "g1"] } }, { mcpGrantId: { in: ["t1", "g1"] } }],
      },
      data: expect.objectContaining({
        state: "EXPIRED",
        decidedBy: null,
        outcome: "credential_revoked",
      }),
    });
  });

  it("clears the credentials' pending release requests", async () => {
    await endAgentWork({ userId: "u", credentialIds: ["t1", "g1"] });
    expect(db.claimReleaseRequest.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "u",
        state: "PENDING",
        OR: [{ agentTokenId: { in: ["t1", "g1"] } }, { mcpGrantId: { in: ["t1", "g1"] } }],
      },
      data: expect.objectContaining({ state: "CLEARED", pendingRankId: null }),
    });
  });
});

describe("access narrowing", () => {
  const event = {
    kind: "agent_token" as const,
    userId: "u",
    agentTokenId: "t3",
    grantId: "g3",
    before: { scopes: ["read", "pools", "commands", "files"] as const, nodeIds: null },
    after: { scopes: ["read", "commands", "files"] as const, nodeIds: null },
  };

  it("aborts all MCP calls under both ids even when only pools was removed", async () => {
    const d = deps();
    await handleAgentAccessNarrowed(event, d);
    expect(d.cancelMcpToolCalls.mock.calls).toEqual([["t3"], ["g3"]]);
    expect(d.endAgentWork).toHaveBeenCalledWith(event);
  });

  it("does not expire queued commands when only pools is removed", async () => {
    db.queuedNodeCommand.updateMany.mockClear();
    files.cancelFileOpsForNarrowedCredential.mockClear();
    await endNarrowedAgentWork(event);
    expect(db.queuedNodeCommand.updateMany).not.toHaveBeenCalled();
    expect(files.cancelFileOpsForNarrowedCredential.mock.calls).toEqual([
      ["t3", event.after],
      ["g3", event.after],
    ]);
  });

  it("expires only queues on nodes outside the new list", async () => {
    await endNarrowedAgentWork({ ...event, after: { ...event.after, nodeIds: ["keep"] } });
    expect(db.queuedNodeCommand.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          nodeId: { notIn: ["keep"] },
          userId: "u",
        }),
        data: expect.objectContaining({ outcome: "credential_lowered" }),
      }),
    );
  });

  it("expires all its queued commands when commands scope is removed", async () => {
    await endNarrowedAgentWork({ ...event, after: { scopes: ["read", "files"], nodeIds: null } });
    expect(db.queuedNodeCommand.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          userId: "u",
          state: "QUEUED",
          OR: [{ agentTokenId: { in: ["t3", "g3"] } }, { mcpGrantId: { in: ["t3", "g3"] } }],
        },
      }),
    );
  });
});
