import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapacityLeaseOwner } from "./lease-owner.js";
import {
  CapacityRequestScope,
  capacityRequestScopeMiddleware,
  withCapacityRequestScope,
} from "./request-scope.js";
import { holdCapacityLeaseForResponse } from "./response-lease.js";

const lease = {
  leaseId: "lease",
  attemptId: "attempt",
  capacityId: "capacity",
  executionTargetId: "target",
  fencingToken: 1n,
  expiresAt: new Date(Date.now() + 30_000),
};

function store() {
  return {
    heartbeat: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(true),
  };
}

afterEach(() => vi.restoreAllMocks());

// F2-CAP-6: a route that forgets to release (or hand off) its owner must not
// keep the slot heartbeating until process shutdown.
describe("capacity request scope", () => {
  it("releases an owner the route forgot once the response ends, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const leaseStore = store();
    let owner: CapacityLeaseOwner | undefined;
    const app = new Hono();
    app.use("*", capacityRequestScopeMiddleware);
    app.post("/forgets", async () => {
      owner = new CapacityLeaseOwner(leaseStore, lease, undefined, 0);
      return new Response("served");
    });

    const response = await app.request("/forgets", { method: "POST" });
    // Still alive while the body is in flight: the scope ends with the response.
    expect(owner?.signal.aborted).toBe(false);
    await expect(response.text()).resolves.toBe("served");
    await vi.waitFor(() => expect(leaseStore.release).toHaveBeenCalledOnce());
    expect(owner?.signal.reason).toMatchObject({
      name: "CapacityLeaseLostError",
      kind: "request_scope_closed",
    });
    expect(warn).toHaveBeenCalledWith(
      "[capacity] lease owner outlived its request scope; releasing",
      { owners: 1 },
    );
  });

  it("releases a forgotten owner when the handler throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const leaseStore = store();
    const app = new Hono();
    app.use("*", capacityRequestScopeMiddleware);
    app.post("/throws", async () => {
      new CapacityLeaseOwner(leaseStore, lease, undefined, 0);
      throw new Error("route bug");
    });
    const response = await app.request("/throws", { method: "POST" });
    expect(response.status).toBe(500);
    await response.text();
    await vi.waitFor(() => expect(leaseStore.release).toHaveBeenCalledOnce());
  });

  it("leaves a correctly handed-off owner alone until the body ends", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const leaseStore = store();
    let owner: CapacityLeaseOwner | undefined;
    const app = new Hono();
    app.use("*", capacityRequestScopeMiddleware);
    app.post("/streams", async () => {
      owner = new CapacityLeaseOwner(leaseStore, lease, undefined, 0);
      return holdCapacityLeaseForResponse({
        // Read-ahead through the hold and the scope wrapper buffers up to two
        // chunks; the third keeps EOF unread until the client drains the body.
        response: new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const part of ["str", "eam", "ed"])
                controller.enqueue(new TextEncoder().encode(part));
              controller.close();
            },
          }),
        ),
        store: leaseStore,
        lease,
        owner,
      });
    });
    const response = await app.request("/streams", { method: "POST" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(leaseStore.release).not.toHaveBeenCalled();
    await expect(response.text()).resolves.toBe("streamed");
    expect(leaseStore.release).toHaveBeenCalledOnce();
    // Released by its own hand-off (reason: normal release), never by the scope.
    expect(owner?.signal.reason).not.toMatchObject({ name: "CapacityLeaseLostError" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("releases a forgotten owner when the response body read rejects", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const leaseStore = store();
    let owner: CapacityLeaseOwner | undefined;
    const app = new Hono();
    app.use("*", capacityRequestScopeMiddleware);
    app.post("/errored", async () => {
      owner = new CapacityLeaseOwner(leaseStore, lease, undefined, 0);
      return new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            throw new Error("body read failed");
          },
        }),
      );
    });
    const response = await app.request("/errored", { method: "POST" });
    await expect(response.text()).rejects.toThrow("body read failed");
    await vi.waitFor(() => expect(leaseStore.release).toHaveBeenCalledOnce());
    expect(owner?.signal.reason).toMatchObject({
      name: "CapacityLeaseLostError",
      kind: "request_scope_closed",
    });
  });

  it("releases on body cancel as well as EOF", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const leaseStore = store();
    const app = new Hono();
    app.use("*", capacityRequestScopeMiddleware);
    app.post("/cancelled", async () => {
      new CapacityLeaseOwner(leaseStore, lease, undefined, 0);
      // One chunk is buffered and nothing else ever arrives, so no pull is
      // pending when the client cancels: only the cancel path can close.
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
        }),
      );
    });
    const response = await app.request("/cancelled", { method: "POST" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(leaseStore.release).not.toHaveBeenCalled();
    await response.body?.cancel();
    expect(leaseStore.release).toHaveBeenCalledOnce();
  });

  it("releases an owner created after its scope closed immediately", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const leaseStore = store();
    const scope = new CapacityRequestScope();
    await scope.close();
    const owner = new CapacityLeaseOwner(leaseStore, lease, undefined, 0);
    scope.register(owner);
    expect(owner.signal.aborted).toBe(true);
    await owner.release();
    expect(leaseStore.release).toHaveBeenCalledOnce();
  });

  it("closes a non-HTTP scope when its work returns", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const leaseStore = store();
    const owner = await withCapacityRequestScope(
      async () => new CapacityLeaseOwner(leaseStore, lease, undefined, 0),
    );
    expect(owner.signal.aborted).toBe(true);
    await owner.release();
    expect(leaseStore.release).toHaveBeenCalledOnce();
  });

  it("does not register owners created outside any scope", () => {
    const leaseStore = store();
    const owner = new CapacityLeaseOwner(leaseStore, lease, undefined, 0);
    expect(owner.signal.aborted).toBe(false);
    void owner.release();
  });
});
