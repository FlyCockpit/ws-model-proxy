import { readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep, mockReset } from "vitest-mock-extended";
import type { PrismaClient } from "../../../../../packages/db/prisma/generated/client";

vi.mock("@ws-model-proxy/db", () => ({ default: mockDeep<PrismaClient>() }));
const relay = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  answer: { status: 200, body: "{}" as string | Uint8Array },
}));
vi.mock("../relay-executor.js", () => ({
  startRelayAttempt: vi.fn((input: Record<string, unknown>) => {
    relay.calls.push(input);
    const bytes =
      typeof relay.answer.body === "string"
        ? new TextEncoder().encode(relay.answer.body)
        : relay.answer.body;
    return {
      requestId: "probe",
      started: Promise.resolve({
        status: relay.answer.status,
        headers: new Headers(),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            for (let offset = 0; offset < bytes.byteLength; offset += 65_536)
              controller.enqueue(bytes.subarray(offset, offset + 65_536));
            controller.close();
          },
        }),
      }),
      terminal: Promise.resolve({ ok: true }),
      cancel: vi.fn(),
    };
  }),
}));
const store = vi.hoisted(() => ({
  saveDescribedProfile: vi.fn(async () => undefined),
  markProbedWithoutDescription: vi.fn(async () => undefined),
}));
vi.mock("./profile-store.js", () => store);

const db = (await import("@ws-model-proxy/db")).default as unknown as ReturnType<
  typeof mockDeep<PrismaClient>
>;
const { probeEngineDescription, startRequestProfileProbes } = await import("./probe.js");

const openapi = await readFile(
  new URL("./fixtures/openapi-strict-chat.json", import.meta.url),
  "utf8",
);
const manager = {
  getOnlineNodeIds: () => ["node-1"],
  registerRelayResponseHandlers: vi.fn(),
  sendRelayRequest: vi.fn(),
  cancelRelayRequest: vi.fn(),
  completeRelayRequest: vi.fn(),
};
const target = {
  instanceId: "i-1",
  generation: "g1",
  nodeId: "node-1",
  handle: "i-abc",
  key: { userId: "u", runtimeId: "r", launchHash: "h" },
};

beforeEach(() => {
  mockReset(db);
  vi.clearAllMocks();
  relay.calls = [];
  relay.answer = { status: 200, body: openapi };
});

describe("engine description probe", () => {
  it("asks the engine on its node for GET /openapi.json and stores what it accepts", async () => {
    expect(await probeEngineDescription(manager, target)).toBe("described");
    expect(relay.calls[0]).toMatchObject({
      nodeId: "node-1",
      handle: "i-abc",
      method: "GET",
      path: "/openapi.json",
      family: "generic",
    });
    expect(relay.calls[0]?.body).toBeUndefined();
    expect(store.saveDescribedProfile).toHaveBeenCalledWith(
      target.key,
      expect.objectContaining({
        engineFingerprint: expect.stringMatching(/^Strict Engine 1\.2\.3 sha256:[0-9a-f]{16}$/),
        accepted: expect.objectContaining({ v: 1 }),
      }),
      expect.any(Date),
    );
  });

  it("notes an engine without a description", async () => {
    relay.answer = { status: 404, body: "Not Found" };
    expect(await probeEngineDescription(manager, target)).toBe("undescribed");
    relay.answer = { status: 200, body: "<html>docs</html>" };
    expect(await probeEngineDescription(manager, target)).toBe("undescribed");
    relay.answer = { status: 200, body: JSON.stringify({ openapi: "3.1.0", paths: {} }) };
    expect(await probeEngineDescription(manager, target)).toBe("undescribed");
    expect(store.markProbedWithoutDescription).toHaveBeenCalledTimes(3);
    expect(store.saveDescribedProfile).not.toHaveBeenCalled();
  });

  it("stores nothing for a refused, failing or oversized answer", async () => {
    relay.answer = { status: 502, body: "{}" };
    expect(await probeEngineDescription(manager, target)).toBe("failed");
    relay.answer = { status: 200, body: new Uint8Array(4 * 1024 * 1024 + 10) };
    expect(await probeEngineDescription(manager, target)).toBe("failed");
    expect(store.markProbedWithoutDescription).not.toHaveBeenCalled();
    expect(store.saveDescribedProfile).not.toHaveBeenCalled();
  });

  it("probes each READY incarnation on an online node once", async () => {
    vi.useFakeTimers();
    const row = (id: string, nodeId: string, generation: string) => ({
      id,
      userId: "u",
      runtimeId: "r",
      handle: `i-${id}`,
      cacheGeneration: generation,
      Version: { launchHash: "h" },
      Runtime: { kind: "STARTABLE", nodeId: null },
      Ranks: [{ nodeId }],
    });
    db.runtimeInstance.findMany.mockResolvedValue([
      row("a", "node-1", "g1"),
      row("b", "node-offline", "g1"),
    ] as never);
    const stop = startRequestProfileProbes(manager);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(relay.calls.map((call) => call.handle)).toEqual(["i-a"]);
    db.runtimeInstance.findMany.mockResolvedValue([row("a", "node-1", "g2")] as never);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(relay.calls.map((call) => call.handle)).toEqual(["i-a", "i-a"]);
    await stop();
    vi.useRealTimers();
  });
});
