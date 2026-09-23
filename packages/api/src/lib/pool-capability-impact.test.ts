import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return {
    default: mockDeep(),
    Prisma: { TransactionIsolationLevel: { Serializable: "Serializable" } },
  };
});

const { default: prisma } = await import("@ws-model-proxy/db");
const { capabilityEditImpactedPools } = await import("./pool-capability-impact");

describe("capabilityEditImpactedPools failure reporting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty advisory without throwing and logs the underlying error", async () => {
    const error = new Error("advisory db failure");
    vi.mocked(prisma.modelPool.findMany).mockRejectedValue(error);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(
        capabilityEditImpactedPools(prisma, { userId: "owner", poolIds: ["pool-a"] }),
      ).resolves.toEqual([]);
      expect(consoleError).toHaveBeenCalledOnce();
      expect(consoleError.mock.calls[0]?.[0]).toContain("pool-capability-impact");
      expect(consoleError.mock.calls[0]?.[1]).toBe(error);
    } finally {
      consoleError.mockRestore();
    }
  });
});
