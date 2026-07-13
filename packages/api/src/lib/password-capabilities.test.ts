import type { MockInstance } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { default: prisma } = await import("@ws-model-proxy/db");
const { canUserChangePassword } = await import("./password-capabilities");

const db = prisma as unknown as {
  account: {
    findFirst: MockInstance;
  };
};

describe("canUserChangePassword", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false for force-SSO deployments without reading accounts", async () => {
    await expect(canUserChangePassword({ userId: "u1", forceSso: true })).resolves.toBe(false);

    expect(db.account.findFirst).not.toHaveBeenCalled();
  });

  it("returns true when a credential account has a password", async () => {
    db.account.findFirst.mockResolvedValue({ id: "account-id" });

    await expect(canUserChangePassword({ userId: "u1", forceSso: false })).resolves.toBe(true);

    expect(db.account.findFirst).toHaveBeenCalledWith({
      where: {
        userId: "u1",
        providerId: "credential",
        password: { not: null },
      },
      select: { id: true },
    });
  });

  it("returns false for SSO-only accounts", async () => {
    db.account.findFirst.mockResolvedValue(null);

    await expect(canUserChangePassword({ userId: "u1", forceSso: false })).resolves.toBe(false);
  });
});
