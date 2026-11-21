import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_VARS } from "../../../scripts/lib/env-manifest.js";

async function load(backup?: string) {
  vi.stubEnv("DATABASE_URL", "postgresql://env_test@127.0.0.1:5432/env_test");
  vi.stubEnv("BETTER_AUTH_SECRET", "w7Qp9Lm2Nx4Rv6Tk8Yc3Hu5Jd1Fs0ZaB");
  vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
  vi.stubEnv("NODE_ENV", "test");
  for (const key of [
    "BACKUP_ENABLED",
    "WMP_MCP_ENABLED",
    "WMP_PUBLIC_PROVIDER_EGRESS_ENABLED",
    "WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS",
    "SIGNUP_ENABLED",
    "TRUST_PROXY_HOPS",
  ]) {
    vi.stubEnv(key, undefined);
  }
  if (backup !== undefined) vi.stubEnv("BACKUP_ENABLED", backup);
  vi.resetModules();
  return (await import("./server.js")).env;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("easy deployment defaults", () => {
  it("keeps backups opt-in and user-gated services on without lowering shared boundaries", async () => {
    const env = await load();
    expect(env.BACKUP_ENABLED).toBe(false);
    expect(env.WMP_MCP_ENABLED).toBe(true);
    expect(env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED).toBe(true);
    expect(env.WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS).toBe(false);
    expect(env.SIGNUP_ENABLED).toBe(false);
    expect(env.TRUST_PROXY_HOPS).toBe(0);
    expect(ENV_VARS.find((entry) => entry.key === "BACKUP_ENABLED")?.default).toBe("false");
    expect(ENV_VARS.find((entry) => entry.key === "WMP_MCP_ENABLED")?.default).toBe("true");
  });

  it("accepts explicit backup opt-in", async () => {
    expect((await load("true")).BACKUP_ENABLED).toBe(true);
  });

  it("rejects a malformed backup flag", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(load("yes")).rejects.toThrow();
  });
});
