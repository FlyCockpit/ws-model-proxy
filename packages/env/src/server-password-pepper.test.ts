import { afterEach, describe, expect, it, vi } from "vitest";

async function load(previous: string | undefined, production = false) {
  vi.stubEnv("NODE_ENV", production ? "production" : "test");
  vi.stubEnv("DATABASE_URL", "postgresql://test@127.0.0.1:5432/test");
  vi.stubEnv("BETTER_AUTH_SECRET", "w7Qp9Lm2Nx4Rv6Tk8Yc3Hu5Jd1Fs0ZaB");
  vi.stubEnv("BETTER_AUTH_SECRET_PREVIOUS", previous);
  vi.stubEnv("BETTER_AUTH_URL", "https://proxy.example.test");
  vi.stubEnv("TRUST_PROXY_HOPS", "0");
  vi.resetModules();
  return import("./server.js");
}

afterEach(() => vi.unstubAllEnvs());

describe("previous password pepper secret", () => {
  it("allows an absent or distinct strong previous secret", async () => {
    await expect(load(undefined)).resolves.toBeDefined();
    await expect(load("m2Yp9Lw7Nx4Rv6Tk8Yc3Hu5Jd1Fs0ZaB")).resolves.toBeDefined();
  });
  it("rejects the current secret as previous", async () => {
    await expect(load("w7Qp9Lm2Nx4Rv6Tk8Yc3Hu5Jd1Fs0ZaB")).rejects.toThrow(/must differ/);
  });
  it("rejects short and weak previous secrets in production", async () => {
    await expect(load("short", true)).rejects.toThrow();
    await expect(load("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", true)).rejects.toThrow(
      /PREVIOUS is weak/,
    );
  });
});
