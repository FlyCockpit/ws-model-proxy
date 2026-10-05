import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { RealtimeSessionRegistry } = await import("./registry.js");
const { CapacityLeaseLostError } = await import("../capacity/lease-loss.js");

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
    const registry = new RealtimeSessionRegistry(async ({ tokenId }) => {
      const reason = verdicts.get(tokenId);
      return reason ? { ok: false, reason } : { ok: true };
    });
    const sessions = Object.fromEntries([...verdicts.keys()].map((id) => [id, fakeSession()]));
    for (const [id, session] of Object.entries(sessions)) registry.add(session, id);
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
    const registration = registry.add(fakeSession(), "t");
    registration?.resolved({ kind: "direct", target: { id: "dm" } as never }, "owner/asr");
    registration?.opened(candidate, null);
    await registry.recheckSessions();
    expect(recheck).toHaveBeenCalledWith({
      tokenId: "t",
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
    registry.add(session, "t");
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
    const registration = registry.add(session, "t");
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
    registry.add(lost, "a")?.opened(candidate, { release() {}, signal: lostController.signal });
    registry
      .add(released, "b")
      ?.opened(candidate, { release() {}, signal: releasedController.signal });
    releasedController.abort(new DOMException("Aborted", "AbortError"));
    lostController.abort(new CapacityLeaseLostError("heartbeat_timeout"));
    expect(lost.terminate).toHaveBeenCalledWith(
      1011,
      expect.objectContaining({ code: "capacity_lease_lost" }),
    );
    expect(released.terminate).not.toHaveBeenCalled();
  });

  it("closeAll ends every session with 1001 and refuses later ones", () => {
    const registry = new RealtimeSessionRegistry(async () => ({ ok: true }));
    const session = fakeSession();
    registry.add(session, "t");
    registry.closeAll();
    expect(session.terminate).toHaveBeenCalledWith(
      1001,
      expect.objectContaining({ code: "server_shutting_down" }),
    );
    expect(registry.add(fakeSession(), "t")).toBeNull();
    expect(registry.closing).toBe(true);
    expect(registry.size).toBe(0);
  });
});
