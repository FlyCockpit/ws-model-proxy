import { describe, expect, it, vi } from "vitest";

const updateMany = vi.fn(async () => ({ count: 1 }));
vi.mock("@ws-model-proxy/db", () => ({ default: { node: { updateMany } } }));

const { createNodeRelayServices, SecretWriteError } = await import("./node-services.js");
const { composeNodeFrameHandlers } = await import("./node-frame-handlers.js");

import type { ServerToNodeControlFrame } from "./frames.js";
import type { NodeSessionRef, SendGuard } from "./session-manager.js";

const ref = (nodeId = "node-1"): NodeSessionRef => ({
  nodeId,
  userId: "user-1",
  slug: "desk",
  connectionGeneration: 3,
  trust: "full",
});

function relay(deliver = true) {
  const sent: ServerToNodeControlFrame[] = [];
  const session: { userId: string; connectionGeneration: number; trust: "full" | "relay" } = {
    userId: "user-1",
    connectionGeneration: 3,
    trust: "full",
  };
  return {
    sent,
    session,
    port: {
      sendToNode: vi.fn((_nodeId: string, frame: ServerToNodeControlFrame, guard?: SendGuard) => {
        if (guard?.requireFullTrust && session.trust !== "full") return false;
        if (guard?.userId !== undefined && guard.userId !== session.userId) return false;
        if (
          guard?.connectionGeneration !== undefined &&
          guard.connectionGeneration !== session.connectionGeneration
        )
          return false;
        sent.push(frame);
        return deliver;
      }),
      nodeSession: vi.fn(() => ({ ...session })),
      requestTrustLower: vi.fn(() => true),
      closeSessionsForNodes: vi.fn(async () => undefined),
    },
  };
}

function idOf(frame: ServerToNodeControlFrame | undefined): string {
  if (!frame || !("id" in frame) || typeof frame.id !== "string") throw new Error("no id");
  return frame.id;
}

describe("node relay services", () => {
  it("sends secret.set, resolves on the matching secret.result and never keeps the value", async () => {
    const r = relay();
    const { services, handlers } = createNodeRelayServices(r.port);
    const write = services.writeSecrets?.({
      nodeId: "node-1",
      userId: "user-1",
      set: [{ name: "HF_TOKEN", value: "s3cret" }],
      delete: [],
    });
    await vi.waitFor(() => expect(r.sent).toHaveLength(1));
    const frame = r.sent[0];
    expect(frame).toMatchObject({ type: "secret.set", name: "HF_TOKEN", value: "s3cret" });
    const id = idOf(frame);
    // Another node, or another name, cannot answer it.
    await handlers["secret.result"]?.(ref("node-2"), {
      type: "secret.result",
      id,
      name: "HF_TOKEN",
      status: "set",
    });
    await handlers["secret.result"]?.(ref(), {
      type: "secret.result",
      id,
      name: "OTHER",
      status: "set",
    });
    await handlers["secret.result"]?.(ref(), {
      type: "secret.result",
      id,
      name: "HF_TOKEN",
      status: "set",
      updatedAt: "2026-10-06T10:00:00.000Z",
    });
    const results = await write;
    expect(results).toEqual([
      { name: "HF_TOKEN", status: "set", updatedAt: "2026-10-06T10:00:00.000Z" },
    ]);
    expect(JSON.stringify(results)).not.toContain("s3cret");
  });

  it("sends deletes and passes refusals through", async () => {
    const r = relay();
    const { services, handlers } = createNodeRelayServices(r.port);
    const write = services.writeSecrets?.({
      nodeId: "node-1",
      userId: "user-1",
      set: [],
      delete: ["OLD"],
    });
    await vi.waitFor(() => expect(r.sent).toHaveLength(1));
    expect(r.sent[0]).toMatchObject({ type: "secret.delete", name: "OLD" });
    await handlers["secret.result"]?.(ref(), {
      type: "secret.result",
      id: idOf(r.sent[0]),
      name: "OLD",
      status: "refused",
      reason: "trust_relay",
    });
    expect(await write).toEqual([{ name: "OLD", status: "refused", reason: "trust_relay" }]);
  });

  it("fails a write that was not delivered, timed out or lost its session", async () => {
    const undelivered = createNodeRelayServices(relay(false).port);
    await expect(
      undelivered.services.writeSecrets?.({
        nodeId: "node-1",
        userId: "user-1",
        set: [{ name: "A", value: "v" }],
        delete: [],
      }),
    ).rejects.toBeInstanceOf(SecretWriteError);

    const slow = createNodeRelayServices(relay().port, {}, { secretTimeoutMs: 5 });
    await expect(
      slow.services.writeSecrets?.({ nodeId: "node-1", userId: "user-1", set: [], delete: ["A"] }),
    ).rejects.toMatchObject({ code: "no_answer" });

    const r = relay();
    const dropped = createNodeRelayServices(r.port);
    const write = dropped.services.writeSecrets?.({
      nodeId: "node-1",
      userId: "user-1",
      set: [],
      delete: ["A"],
    });
    await vi.waitFor(() => expect(r.sent).toHaveLength(1));
    dropped.handlers.nodeDisconnected?.(ref());
    await expect(write).rejects.toMatchObject({ code: "disconnected" });
  });

  it("never sends a secret to a node of another owner (defence in depth)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const r = relay();
      r.session.userId = "user-2";
      const { services } = createNodeRelayServices(r.port);
      for (const input of [
        { set: [{ name: "A", value: "s3cret" }], delete: [] },
        { set: [], delete: ["A"] },
      ]) {
        await expect(
          services.writeSecrets?.({ nodeId: "node-1", userId: "user-1", ...input }),
        ).rejects.toMatchObject({ code: "not_delivered" });
      }
      expect(r.sent).toHaveLength(0);
      expect(r.port.sendToNode).not.toHaveBeenCalled();
      // The class only: no id, name or value in the log.
      expect(warn.mock.calls).toEqual([
        ["[relay] refused a send to a node of another owner", "secret"],
        ["[relay] refused a send to a node of another owner", "secret"],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("pins every secret frame to the secret's owner", async () => {
    const r = relay();
    const { services, handlers } = createNodeRelayServices(r.port);
    const write = services.writeSecrets?.({
      nodeId: "node-1",
      userId: "user-1",
      set: [],
      delete: ["A"],
    });
    await vi.waitFor(() => expect(r.sent).toHaveLength(1));
    expect(r.port.sendToNode).toHaveBeenCalledWith(
      "node-1",
      expect.objectContaining({ type: "secret.delete" }),
      expect.objectContaining({ userId: "user-1", requireFullTrust: true }),
    );
    await handlers["secret.result"]?.(ref(), {
      type: "secret.result",
      id: idOf(r.sent[0]),
      name: "A",
      status: "deleted",
    });
    expect(await write).toEqual([{ name: "A", status: "deleted" }]);
  });

  it("never sends a secret to a session that is no longer at Full control", async () => {
    const r = relay();
    r.session.trust = "relay";
    const { services } = createNodeRelayServices(r.port);
    expect(
      await services.writeSecrets?.({
        nodeId: "node-1",
        userId: "user-1",
        set: [{ name: "A", value: "v" }],
        delete: [],
      }),
    ).toEqual([{ name: "A", status: "refused", reason: "trust_relay" }]);
    expect(r.sent).toHaveLength(0);
  });

  it("ignores an earlier session's answer and disconnect", async () => {
    const r = relay();
    const { services, handlers } = createNodeRelayServices(r.port);
    const write = services.writeSecrets?.({
      nodeId: "node-1",
      userId: "user-1",
      set: [],
      delete: ["A"],
    });
    await vi.waitFor(() => expect(r.sent).toHaveLength(1));
    const id = idOf(r.sent[0]);
    const old = { ...ref(), connectionGeneration: 2 };
    handlers.nodeDisconnected?.(old);
    await handlers["secret.result"]?.(old, {
      type: "secret.result",
      id,
      name: "A",
      status: "deleted",
    });
    await handlers["secret.result"]?.(ref(), {
      type: "secret.result",
      id,
      name: "A",
      status: "not_found",
    });
    expect(await write).toEqual([{ name: "A", status: "not_found" }]);
  });

  it("rescans, lowers trust and disconnects through the relay", async () => {
    const r = relay();
    const { services } = createNodeRelayServices(r.port);
    await services.rescan?.("node-1");
    expect(r.sent[0]).toMatchObject({ type: "runtime.detect" });
    await services.lowerTrust?.("node-1");
    expect(r.port.requestTrustLower).toHaveBeenCalledWith("node-1", expect.any(Date));
    await services.disconnect?.("node-1", "node_deleted");
    expect(r.port.closeSessionsForNodes).toHaveBeenCalledWith(["node-1"]);
  });

  it("stores detected servers for the current connection only", async () => {
    const { handlers } = createNodeRelayServices(relay().port);
    const servers = [
      {
        baseUrl: "http://127.0.0.1:8000/v1",
        engine: "vllm" as const,
        api: "openai" as const,
        models: ["m"],
      },
    ];
    await handlers["runtime.detected"]?.(ref(), {
      type: "runtime.detected",
      scannedAt: "2099-01-01T00:00:00.000Z",
      servers,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "node-1", connectionGeneration: 3 },
      data: { detectedServers: servers, detectedServersAt: expect.any(Date) },
    });
  });
});

describe("composeNodeFrameHandlers", () => {
  it("runs every part in order and keeps going after a failure", async () => {
    const calls: string[] = [];
    const handlers = composeNodeFrameHandlers(
      {
        nodeReady: async () => {
          calls.push("a");
          throw new Error("boom");
        },
      },
      { nodeReady: () => void calls.push("b") },
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await handlers.nodeReady?.(ref());
    expect(calls).toEqual(["a", "b"]);
    expect(error).toHaveBeenCalledWith("[relay] node frame handler failed", "nodeReady", "Error");
    error.mockRestore();
  });

  it("refuses two parts answering the same node question", () => {
    const sync = async () => "none" as const;
    expect(() =>
      composeNodeFrameHandlers({ definitionSync: sync }, { definitionSync: sync }),
    ).toThrow(/definitionSync/);
  });
});
