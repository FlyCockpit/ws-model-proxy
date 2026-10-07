import { runtimeLaunchHash } from "@ws-model-proxy/api/lib/runtime-launch-hash";
import { type RuntimeSpec, runtimeSpecSchema } from "@ws-model-proxy/api/lib/runtime-spec";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlwaysOnInventory } from "../relay/frames.js";

const db = vi.hoisted(() => ({
  runtime: { findMany: vi.fn() },
  profileItem: { count: vi.fn() },
  runtimeInstance: { updateMany: vi.fn() },
}));
const writes = vi.hoisted(() => ({ graphWrite: vi.fn(), graphDelete: vi.fn() }));

vi.mock("@ws-model-proxy/db", () => ({ default: db }));
vi.mock("@ws-model-proxy/api/lib/graph-write", () => ({
  graphWrite: writes.graphWrite,
  graphDelete: writes.graphDelete,
  runtimeCapacityFences: vi.fn(async () => []),
}));

const {
  alwaysOnFacts,
  alwaysOnPhase,
  applyAlwaysOnInventory,
  discoveredModels,
  instanceStoredFacts,
  nodeOriginSpec,
} = await import("./always-on.js");

const spec: RuntimeSpec = runtimeSpecSchema.parse({
  api: "openai",
  engine: "vllm",
  modelType: "llm",
  address: { baseUrl: "http://127.0.0.1:8000/v1" },
});

function entry(overrides: Partial<AlwaysOnInventory> = {}): AlwaysOnInventory {
  return {
    slug: "local-vllm",
    origin: "node",
    launchHash: runtimeLaunchHash(spec),
    spec,
    status: "online",
    models: [{ id: "qwen", capabilities: ["text_generation"] }],
    ...overrides,
  };
}

const ref = {
  nodeId: "node1",
  userId: "user1",
  slug: "spark",
  connectionGeneration: 1,
  trust: "full" as const,
};

describe("always-on inventory helpers", () => {
  it("maps the node's status to the instance phase", () => {
    expect(alwaysOnPhase("online")).toBe("READY");
    expect(alwaysOnPhase("degraded")).toBe("UNHEALTHY");
    expect(alwaysOnPhase("offline")).toBe("UNAVAILABLE");
    expect(alwaysOnPhase("unknown")).toBe("UNAVAILABLE");
  });

  it("takes a node-origin spec only when the server computes the same launch hash", () => {
    const ok = nodeOriginSpec(entry());
    expect(ok).toMatchObject({ ok: true, launchHash: runtimeLaunchHash(spec) });
    expect(nodeOriginSpec(entry({ launchHash: "0".repeat(64) }))).toEqual({
      ok: false,
      reason: "hash_mismatch",
    });
  });

  it("refuses a startable spec in an always-on entry", () => {
    const startable = runtimeSpecSchema.parse({
      launch: {
        management: "process",
        groupSize: 1,
        resources: [{ kind: "none" }],
        labels: [],
        commands: [{ start: "serve", stop: "true", status: "true" }],
        health: { intervalMs: 15_000, failureThreshold: 2, successThreshold: 1 },
      },
    });
    expect(
      nodeOriginSpec(entry({ spec: startable, launchHash: runtimeLaunchHash(startable) })),
    ).toEqual({ ok: false, reason: "not_always_on" });
  });

  it("discovers models only when the spec lists none", () => {
    const models = discoveredModels(
      spec,
      entry({
        models: [
          { id: "a", capabilities: ["text_generation", "vision_input"] },
          { id: "a", capabilities: [] },
          { id: "b", capabilities: [] },
        ],
      }),
    );
    expect(models?.map((model) => model.upstreamModelId)).toEqual(["a", "b"]);
    expect(models?.[0]?.detectedCapabilities).toEqual(["TEXT_GENERATION", "VISION_INPUT"]);
    const listed = runtimeSpecSchema.parse({ ...spec, models: [{ id: "x" }] });
    expect(discoveredModels(listed, entry())).toBeNull();
  });

  it("layers a single model's engine facts over the runtime's", () => {
    const facts = alwaysOnFacts(
      entry({
        engineFacts: {
          slots: { value: 4, source: "probe" },
          maxModelLen: { value: 8192, source: "probe" },
        },
        models: [
          {
            id: "qwen",
            capabilities: [],
            engineFacts: { maxModelLen: { value: 32_768, source: "probe" } },
          },
        ],
      }),
    );
    expect(facts).toMatchObject({ engineSlots: 4, maxModelLen: 32_768 });
    // Several models: only the runtime-level facts describe the instance.
    const many = alwaysOnFacts(
      entry({
        engineFacts: { slots: { value: 2, source: "probe" } },
        models: [
          {
            id: "a",
            capabilities: [],
            engineFacts: { maxModelLen: { value: 1, source: "probe" } },
          },
          { id: "b", capabilities: [] },
        ],
      }),
    );
    expect(many).toMatchObject({ engineSlots: 2, maxModelLen: null });
    expect(alwaysOnFacts(entry())).toBeNull();
  });

  it("reads stored fact columns, dropping unknown signals", () => {
    expect(
      instanceStoredFacts({
        engineSlots: 1,
        observedKvBudgetTokens: null,
        maxModelLen: null,
        countContext: null,
        loadSignals: ["kvUsage", "nonsense"],
      }).loadSignals,
    ).toEqual(["kvUsage"]);
  });
});

describe("applyAlwaysOnInventory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    db.runtime.findMany.mockResolvedValue([]);
    db.profileItem.count.mockResolvedValue(0);
    writes.graphWrite.mockResolvedValue(undefined);
    writes.graphDelete.mockResolvedValue(undefined);
  });

  it("writes nothing for a node-origin entry whose hash does not match", async () => {
    await applyAlwaysOnInventory(ref, [entry({ launchHash: "f".repeat(64) })], new Date());
    expect(writes.graphWrite).not.toHaveBeenCalled();
    // Still reported: it is not removed.
    expect(db.runtime.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ slug: { notIn: ["local-vllm"] }, origin: "NODE" }),
      }),
    );
  });

  it("ignores a server-origin entry for a runtime that is not this node's", async () => {
    // The node's own server-origin always-on runtimes, read once.
    db.runtime.findMany.mockResolvedValueOnce([{ id: "rt-mine" }]);
    await applyAlwaysOnInventory(
      ref,
      [
        {
          slug: "theirs",
          origin: "server",
          runtimeId: "rt-other",
          versionId: "v-other",
          launchHash: "a".repeat(64),
          status: "online",
          models: [],
        },
      ],
      new Date(),
    );
    expect(db.runtime.findMany).toHaveBeenCalledWith({
      where: { userId: "user1", nodeId: "node1", kind: "ALWAYS_ON", origin: "SERVER" },
      select: { id: true },
    });
    expect(writes.graphWrite).not.toHaveBeenCalled();
  });

  it("removes node-origin runtimes the node no longer reports, unless a profile pins them", async () => {
    db.runtime.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: "rt-gone", slug: "gone" },
      { id: "rt-pinned", slug: "pinned" },
    ]);
    db.profileItem.count.mockImplementation(async ({ where }: { where: { runtimeId: string } }) =>
      where.runtimeId === "rt-pinned" ? 1 : 0,
    );
    db.runtimeInstance.updateMany.mockResolvedValue({ count: 1 });
    await applyAlwaysOnInventory(ref, [], new Date());
    expect(writes.graphDelete).toHaveBeenCalledTimes(1);
    expect(writes.graphDelete).toHaveBeenCalledWith(
      { userId: "user1", runtimeIds: ["rt-gone"] },
      expect.any(Function),
    );
    expect(db.runtimeInstance.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ runtimeId: "rt-pinned", userId: "user1" }),
        data: expect.objectContaining({ phase: "UNAVAILABLE", phaseReason: "node_removed" }),
      }),
    );
  });

  it("takes at most the definition cap of node-origin entries", async () => {
    const many = Array.from({ length: 130 }, (_, index) => entry({ slug: `rt-${index}` }));
    await applyAlwaysOnInventory(ref, many, new Date());
    expect(writes.graphWrite).toHaveBeenCalledTimes(128);
  });

  it("applies each slug once and keeps going after a failure", async () => {
    writes.graphWrite.mockRejectedValueOnce(new Error("boom"));
    await applyAlwaysOnInventory(ref, [entry(), entry(), entry({ slug: "second" })], new Date());
    expect(writes.graphWrite).toHaveBeenCalledTimes(2);
  });
});
