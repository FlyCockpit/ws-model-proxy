/**
 * The engine description probe against the real relay executor (probe.test.ts mocks it). The
 * probe once sent a GET with no body, which the executor refuses: it threw after arming its
 * timeout, and 10 s later that timeout rejected an attempt nobody held, crashing the server.
 */
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActiveRelayResponseHandlers } from "../../relay/session-manager.js";

vi.mock("@ws-model-proxy/db", () => ({ default: {} }));
const store = vi.hoisted(() => ({
  saveDescribedProfile: vi.fn(async () => undefined),
  markProbedWithoutDescription: vi.fn(async () => undefined),
}));
vi.mock("./profile-store.js", () => store);

const { probeEngineDescription } = await import("./probe.js");

const openapi = await readFile(
  new URL("./fixtures/openapi-strict-chat.json", import.meta.url),
  "utf8",
);
const target = {
  instanceId: "i-1",
  generation: "g1",
  nodeId: "node-1",
  handle: "i-abc",
  key: { userId: "u", runtimeId: "r", launchHash: "h" },
};

function relayManager() {
  let handlers: ActiveRelayResponseHandlers | undefined;
  const manager = {
    getOnlineNodeIds: () => ["node-1"],
    registerRelayResponseHandlers: vi.fn((input: { handlers: ActiveRelayResponseHandlers }) => {
      handlers = input.handlers;
    }),
    sendRelayRequest: vi.fn(),
    cancelRelayRequest: vi.fn(),
    completeRelayRequest: vi.fn(),
  };
  return {
    manager,
    handlers: () => {
      if (!handlers) throw new Error("relay handlers were not registered");
      return handlers;
    },
  };
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeEach(() => {
  vi.clearAllMocks();
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});

afterEach(() => {
  vi.useRealTimers();
  process.off("unhandledRejection", onUnhandled);
});

async function drainTurns() {
  for (let turn = 0; turn < 3; turn += 1) await new Promise((r) => setImmediate(r));
}

describe("engine description probe through the relay executor", () => {
  it("dispatches a bodiless GET and stores the description", async () => {
    const { manager, handlers } = relayManager();
    const outcome = probeEngineDescription(manager, target);
    expect(manager.sendRelayRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET", path: "/openapi.json", bodyChunks: [] }),
    );
    const requestId = manager.sendRelayRequest.mock.calls[0]?.[0].requestId;
    handlers().onHeaders({ type: "relay.response.headers", requestId, status: 200, headers: [] });
    handlers().onBody(new TextEncoder().encode(openapi), {
      type: "relay.response.body",
      requestId,
      chunkId: "0",
    });
    handlers().onComplete({ type: "relay.complete", requestId });
    expect(await outcome).toBe("described");
    expect(store.saveDescribedProfile).toHaveBeenCalledOnce();
  });

  it("fails an engine that never answers once, without leaving a timer or a rejection behind", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { manager } = relayManager();
    const outcome = probeEngineDescription(manager, target);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(10_000);
    expect(await outcome).toBe("failed");
    await drainTurns();
    expect(unhandled).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    // One cancel: the probe's own cancel after the settled timeout sends nothing more.
    expect(manager.cancelRelayRequest).toHaveBeenCalledOnce();
    expect(manager.cancelRelayRequest).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "node-1", reason: "timeout" }),
    );
    expect(manager.completeRelayRequest).toHaveBeenCalledOnce();
    expect(store.markProbedWithoutDescription).not.toHaveBeenCalled();
  });
});
