import { describe, expect, it, vi } from "vitest";

// The server env validates on import; nothing these tests reach reads it, so
// the strict (empty-env) unit run gets an empty one.
vi.mock("@ws-model-proxy/env/server", () => ({ env: {} }));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { RealtimeSessionRegistry } = await import("./registry.js");
const { CapacityLeaseLostError } = await import("../capacity/lease-loss.js");

function token(tokenId: string) {
  return { kind: "token" as const, tokenId };
}

function fakeSession() {
  return { terminate: vi.fn() };
}

const candidate = {
  cliDeviceId: "cli",
  endpointSlug: "inst-aaaaaaaaaaaaaaaa",
  upstreamModel: "m",
  capabilities: null,
  deploymentManaged: true,
  memberId: "m1",
};

describe("realtime session registry", () => {
  it("rechecks every session, including ones without a model, and maps denials to close codes", async () => {
    const verdicts = new Map<string, "credential" | "model" | "member" | null>([
      ["waiting", "credential"],
      ["model", "model"],
      ["member", "member"],
      ["fine", null],
    ]);
    const registry = new RealtimeSessionRegistry(async ({ credential }) => {
      const reason = verdicts.get(credential.kind === "token" ? credential.tokenId : "");
      return reason ? { ok: false, reason } : { ok: true };
    });
    const sessions = Object.fromEntries([...verdicts.keys()].map((id) => [id, fakeSession()]));
    for (const [id, session] of Object.entries(sessions)) registry.add(session, token(id), "user");
    await registry.recheckSessions();
    expect(sessions.waiting?.terminate).toHaveBeenCalledWith(
      1008,
      expect.objectContaining({ code: "invalid_api_key" }),
    );
    expect(sessions.model?.terminate).toHaveBeenCalledWith(
      1008,
      expect.objectContaining({ code: "model_not_found" }),
    );
    expect(sessions.member?.terminate).toHaveBeenCalledWith(
      1011,
      expect.objectContaining({ code: "model_unavailable" }),
    );
    expect(sessions.fine?.terminate).not.toHaveBeenCalled();
  });

  it("passes the resolved model and opened member to the recheck", async () => {
    const recheck = vi.fn(async () => ({ ok: true as const }));
    const registry = new RealtimeSessionRegistry(recheck);
    const registration = registry.add(fakeSession(), token("t"), "user");
    registration?.resolved({ kind: "direct", target: { id: "dm" } as never }, "owner/asr");
    registration?.opened(candidate, null);
    await registry.recheckSessions();
    expect(recheck).toHaveBeenCalledWith({
      credential: { kind: "token", tokenId: "t" },
      userId: "user",
      model: "owner/asr",
      resolved: { kind: "direct", target: { id: "dm" } },
      candidate,
    });
  });

  it("skips a session for one sweep when the lookup throws", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const registry = new RealtimeSessionRegistry(async () => {
      throw new Error("db down");
    });
    const session = fakeSession();
    registry.add(session, token("t"), "user");
    await registry.recheckSessions();
    expect(session.terminate).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it("does not terminate a session removed while its check ran", async () => {
    let finish: (value: { ok: false; reason: "credential" }) => void = () => {};
    const registry = new RealtimeSessionRegistry(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const session = fakeSession();
    const registration = registry.add(session, token("t"), "user");
    const sweep = registry.recheckSessions();
    registration?.remove();
    finish({ ok: false, reason: "credential" });
    await sweep;
    expect(session.terminate).not.toHaveBeenCalled();
  });

  it("ends a session whose capacity lease is lost, not one released normally", () => {
    const registry = new RealtimeSessionRegistry(async () => ({ ok: true }));
    const lost = fakeSession();
    const released = fakeSession();
    const lostController = new AbortController();
    const releasedController = new AbortController();
    registry
      .add(lost, token("a"), "user")
      ?.opened(candidate, { release() {}, signal: lostController.signal });
    registry
      .add(released, token("b"), "user")
      ?.opened(candidate, { release() {}, signal: releasedController.signal });
    releasedController.abort(new DOMException("Aborted", "AbortError"));
    lostController.abort(new CapacityLeaseLostError("heartbeat_timeout"));
    expect(lost.terminate).toHaveBeenCalledWith(
      1011,
      expect.objectContaining({ code: "capacity_lease_lost" }),
    );
    expect(released.terminate).not.toHaveBeenCalled();
  });

  it("ends a banned or deleted user's sessions, and those their members serve, at once", () => {
    const registry = new RealtimeSessionRegistry(async () => ({ ok: true }));
    const own = fakeSession();
    const served = fakeSession();
    const other = fakeSession();
    registry.add(own, token("t1"), "banned");
    registry.add(served, token("t2"), "someone")?.opened(
      {
        ...candidate,
        route: {
          kind: "pool",
          poolId: "p",
          poolMemberId: "m1",
          discoveredModelId: "dm",
          endpointId: "ep",
          executionTargetId: "et",
          capacityId: "cap",
          ownerUserId: "pool-owner",
          engineOwnerUserId: "banned",
          accessGrantId: "g",
          contributionId: "ic",
        },
      },
      null,
    );
    registry.add(other, token("t3"), "someone");
    registry.terminateForUser("banned");
    expect(own.terminate).toHaveBeenCalledWith(
      1008,
      expect.objectContaining({ code: "invalid_api_key" }),
    );
    expect(served.terminate).toHaveBeenCalledWith(
      1011,
      expect.objectContaining({ code: "model_unavailable" }),
    );
    expect(other.terminate).not.toHaveBeenCalled();
    expect(registry.size).toBe(1);
  });

  it("ends a revoked token's sessions at once", () => {
    const registry = new RealtimeSessionRegistry(async () => ({ ok: true }));
    const revoked = fakeSession();
    const kept = fakeSession();
    registry.add(revoked, token("revoked"), "u");
    registry.add(kept, token("kept"), "u");
    registry.terminateForToken("revoked");
    expect(revoked.terminate).toHaveBeenCalledWith(
      1008,
      expect.objectContaining({ code: "invalid_api_key" }),
    );
    expect(kept.terminate).not.toHaveBeenCalled();
  });

  it("closeAll ends every session with 1001 and refuses later ones", () => {
    const registry = new RealtimeSessionRegistry(async () => ({ ok: true }));
    const session = fakeSession();
    registry.add(session, token("t"), "user");
    registry.closeAll();
    expect(session.terminate).toHaveBeenCalledWith(
      1001,
      expect.objectContaining({ code: "server_shutting_down" }),
    );
    expect(registry.add(fakeSession(), token("t"), "user")).toBeNull();
    expect(registry.closing).toBe(true);
    expect(registry.size).toBe(0);
  });
});
