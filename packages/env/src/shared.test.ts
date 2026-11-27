import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
describe("DATABASE_POOL_MAX", () => {
  it.each(["0", "1", "2", "3.5", "invalid"])("rejects %s", async (value) => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost/unit");
    vi.stubEnv("DATABASE_POOL_MAX", value);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(import("./shared")).rejects.toThrow();
    vi.restoreAllMocks();
  });
  it.each([
    ["3", 3],
    ["17", 17],
    ["", 10],
  ])("uses %s as %i", async (value, expected) => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost/unit");
    vi.stubEnv("DATABASE_POOL_MAX", value);
    expect((await import("./shared")).env.DATABASE_POOL_MAX).toBe(expected);
  });
});
