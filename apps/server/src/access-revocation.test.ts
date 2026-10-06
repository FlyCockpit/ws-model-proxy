import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  queuedNodeCommand: { updateMany: vi.fn(async () => ({ count: 1 })) },
  nodeCommand: { findMany: vi.fn(async () => [{ id: "cmd-1", nodeId: "node-1" }]) },
}));
vi.mock("@ws-model-proxy/db", () => ({ default: db }));

const { endAgentWork, handleAccessRevoked } = await import("./access-revocation.js");

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
  it("expires queued commands and cancels running ones of the credentials", async () => {
    const cancel = vi.fn(async () => undefined);
    await endAgentWork({ userId: "u", credentialIds: ["t1", "g1"] }, cancel);
    const byCredential = [
      { agentTokenId: { in: ["t1", "g1"] } },
      { mcpGrantId: { in: ["t1", "g1"] } },
    ];
    expect(db.queuedNodeCommand.updateMany).toHaveBeenCalledWith({
      where: { userId: "u", state: "QUEUED", OR: byCredential },
      data: expect.objectContaining({
        state: "EXPIRED",
        decidedBy: null,
        outcome: "credential_revoked",
      }),
    });
    expect(db.nodeCommand.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "u", state: "RUNNING", OR: byCredential } }),
    );
    expect(cancel).toHaveBeenCalledWith({ userId: "u", nodeId: "node-1", commandId: "cmd-1" });
  });
});

describe("endAgentWork without a node operator", () => {
  it("only expires the queued commands", async () => {
    db.nodeCommand.findMany.mockClear();
    await endAgentWork({ userId: "u", credentialIds: ["t1"] });
    expect(db.queuedNodeCommand.updateMany).toHaveBeenCalled();
    expect(db.nodeCommand.findMany).not.toHaveBeenCalled();
  });
});
