import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { loadPoolCatalogProfile } = await import("./catalog-pool-profile");
const { default: prisma } = await import("@ws-model-proxy/db");
const db = prisma as unknown as { modelPool: { findFirst: MockInstance } };

const discovered = (surface: Record<string, unknown>) => ({
  capabilityOverrideMode: "OVERRIDE",
  capabilityOverrideMetadata: {
    version: 4,
    protocol: "openai-compatible",
    surfaces: {
      openaiChatCompletions: {
        source: "declared",
        confidence: "exact",
        operations: ["create"],
        ...surface,
      },
    },
  },
  capabilityOverrides: [],
  Endpoint: { capabilityMetadata: null, defaultCapabilities: [] },
});

describe("loadPoolCatalogProfile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null for a pool the caller cannot see (owner or grantee only)", async () => {
    db.modelPool.findFirst.mockResolvedValue(null);
    await expect(loadPoolCatalogProfile("u", "p")).resolves.toBeNull();
    expect(db.modelPool.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "p", OR: [{ userId: "u" }, { PoolGrants: { some: { granteeUserId: "u" } } }] },
      }),
    );
  });

  it("unions primary features and caps the widest window by the pool ceiling", async () => {
    db.modelPool.findFirst.mockResolvedValue({
      capacityContextCeiling: 100_000,
      PoolMembers: [
        {
          DiscoveredModel: discovered({ inputImages: true, maxContextTokens: 32_000 }),
          ExecutionTarget: null,
        },
        {
          DiscoveredModel: null,
          ExecutionTarget: {
            DiscoveredModel: discovered({ tools: true, reasoning: true }),
            ProviderModel: null,
            InferenceCapacity: { physicalMaxContext: 262_144 },
          },
        },
      ],
    });
    await expect(loadPoolCatalogProfile("u", "p")).resolves.toEqual({
      contextCeiling: 100_000,
      tools: true,
      imageInput: true,
      reasoning: true,
    });
    expect(db.modelPool.findFirst.mock.calls[0]?.[0].select.PoolMembers.where).toEqual({
      tier: "PRIMARY",
    });
  });

  it("has no ceiling and no features for an empty pool without a ceiling", async () => {
    db.modelPool.findFirst.mockResolvedValue({ capacityContextCeiling: null, PoolMembers: [] });
    await expect(loadPoolCatalogProfile("u", "p")).resolves.toEqual({
      contextCeiling: null,
      tools: false,
      imageInput: false,
      reasoning: false,
    });
  });
});
