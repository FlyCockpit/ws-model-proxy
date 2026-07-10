import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("@ws-model-proxy/db", () => ({
  default: { appSetting: { findUnique: dbMocks.findUnique } },
  prisma: { appSetting: { findUnique: dbMocks.findUnique } },
}));

const { invalidateForceTwoFactorPolicyCache, isForceTwoFactorRequired } = await import(
  "./force-two-factor-policy"
);

describe("force-two-factor policy cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invalidateForceTwoFactorPolicyCache();
  });

  it("caches the setting during the bounded freshness window", async () => {
    dbMocks.findUnique.mockResolvedValue({ value: "true" });

    await expect(isForceTwoFactorRequired()).resolves.toBe(true);
    await expect(isForceTwoFactorRequired()).resolves.toBe(true);

    expect(dbMocks.findUnique).toHaveBeenCalledOnce();
    expect(dbMocks.findUnique).toHaveBeenCalledWith({
      where: { key: "force2fa" },
      select: { value: true },
    });
  });

  it("refetches immediately after explicit invalidation", async () => {
    dbMocks.findUnique.mockResolvedValueOnce({ value: "false" });
    await expect(isForceTwoFactorRequired()).resolves.toBe(false);

    invalidateForceTwoFactorPolicyCache();
    dbMocks.findUnique.mockResolvedValueOnce({ value: "true" });

    await expect(isForceTwoFactorRequired()).resolves.toBe(true);
    expect(dbMocks.findUnique).toHaveBeenCalledTimes(2);
  });

  it("does not let an invalidated in-flight lookup repopulate stale cache state", async () => {
    let resolveFirst!: (value: { value: string }) => void;
    const first = new Promise<{ value: string }>((resolve) => {
      resolveFirst = resolve;
    });
    dbMocks.findUnique.mockReturnValueOnce(first);

    const staleLookup = isForceTwoFactorRequired();
    invalidateForceTwoFactorPolicyCache();
    dbMocks.findUnique.mockResolvedValueOnce({ value: "true" });
    await expect(isForceTwoFactorRequired()).resolves.toBe(true);

    resolveFirst({ value: "false" });
    await expect(staleLookup).resolves.toBe(false);
    await expect(isForceTwoFactorRequired()).resolves.toBe(true);
    expect(dbMocks.findUnique).toHaveBeenCalledTimes(2);
  });
});
