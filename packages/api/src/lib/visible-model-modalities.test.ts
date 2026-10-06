import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { default: prisma } = await import("@ws-model-proxy/db");
const { visibleModelRealtimeTranscription } = await import("./visible-model-modalities");
const { realtimeTranscriptionAdvertised } = await import("./openai-compatible-capabilities");

const db = prisma as unknown as {
  discoveredModel: { findMany: ReturnType<typeof vi.fn> };
  poolMember: { findMany: ReturnType<typeof vi.fn> };
};

const LIVE = {
  version: 2,
  protocol: "openai-compatible",
  audio: {
    transcriptions: { supported: true, realtime: { supported: true, adapter: "segmented" } },
  },
};
const FILE_ONLY = {
  version: 2,
  protocol: "openai-compatible",
  audio: { transcriptions: { supported: true } },
};

function model(capabilityMetadata: unknown, override?: unknown) {
  return {
    capabilityOverrideMode: override ? "OVERRIDE" : "INHERIT",
    capabilityOverrideMetadata: override ?? null,
    Endpoint: { capabilityMetadata },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("live transcription hint for visible models", () => {
  it("reads only audio.transcriptions.realtime with supported: true", () => {
    expect(realtimeTranscriptionAdvertised(LIVE as never)).toBe(true);
    expect(realtimeTranscriptionAdvertised(FILE_ONLY as never)).toBe(false);
    expect(
      realtimeTranscriptionAdvertised({
        version: 2,
        protocol: "openai-compatible",
        audio: { translations: LIVE.audio.transcriptions },
      } as never),
    ).toBe(false);
    expect(realtimeTranscriptionAdvertised(null)).toBe(false);
  });

  it("marks live direct models and pools with any live member, honoring overrides", async () => {
    db.discoveredModel.findMany.mockResolvedValue([
      { id: "live", ...model(LIVE) },
      { id: "file", ...model(FILE_ONLY) },
      { id: "overridden", ...model(LIVE, FILE_ONLY) },
    ]);
    db.poolMember.findMany.mockResolvedValue([
      {
        poolId: "pool-live",
        ExecutionTarget: { DiscoveredModel: model(LIVE) },
        DiscoveredModel: null,
      },
      { poolId: "pool-live", ExecutionTarget: null, DiscoveredModel: model(FILE_ONLY) },
      { poolId: "pool-file", ExecutionTarget: null, DiscoveredModel: model(FILE_ONLY) },
    ]);
    const result = await visibleModelRealtimeTranscription({
      directModels: [{ id: "live" }, { id: "file" }, { id: "overridden" }],
      modelPools: [{ id: "pool-live" }, { id: "pool-file" }],
    } as never);
    expect([...result.directIds]).toEqual(["live"]);
    expect([...result.poolIds]).toEqual(["pool-live"]);
    expect(db.poolMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { poolId: { in: ["pool-live", "pool-file"] }, tier: "PRIMARY" },
      }),
    );
  });

  it("queries nothing when nothing is visible", async () => {
    const result = await visibleModelRealtimeTranscription({ directModels: [], modelPools: [] });
    expect(result.directIds.size + result.poolIds.size).toBe(0);
    expect(db.discoveredModel.findMany).not.toHaveBeenCalled();
  });
});
