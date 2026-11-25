import { afterEach, describe, expect, it, vi } from "vitest";
import { isEnvConfigError } from "./config-error.js";

const STUBBED = [
  "NODE_ENV",
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "WMP_MCP_ENABLED",
];
const ORIGINAL = Object.fromEntries(STUBBED.map((key) => [key, process.env[key]]));

/** Load the real server env with this origin and MCP flag (undefined: the default). */
async function loadEnv(url: string, mcp: string | undefined) {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DATABASE_URL", "postgresql://env-default-test@127.0.0.1:5432/env_default_test");
  vi.stubEnv("BETTER_AUTH_SECRET", "w7Qp9Lm2Nx4Rv6Tk8Yc3Hu5Jd1Fs0ZaB");
  vi.stubEnv("BETTER_AUTH_URL", url);
  vi.stubEnv("WMP_MCP_ENABLED", mcp);
  vi.resetModules();
  return (await import("./server.js")).env;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("server env MCP origin guard", () => {
  it("refuses a LAN http BETTER_AUTH_URL with MCP on by default, as an EnvConfigError", async () => {
    const error = await loadEnv("http://192.168.1.10:3999", undefined).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(isEnvConfigError(error)).toBe(true);
    expect((error as Error).message).toContain("BETTER_AUTH_URL=http://192.168.1.10:3999");
    expect((error as Error).message).toContain("WMP_MCP_ENABLED=false");
  });

  it("accepts loopback http with MCP on", async () => {
    expect((await loadEnv("http://127.0.0.1:3999", undefined)).WMP_MCP_ENABLED).toBe(true);
  });

  it("accepts https on any host with MCP on", async () => {
    expect((await loadEnv("https://wsmp.example.com", "true")).BETTER_AUTH_URL).toBe(
      "https://wsmp.example.com",
    );
  });

  it("accepts a LAN http BETTER_AUTH_URL with MCP off", async () => {
    expect((await loadEnv("http://192.168.1.10:3999", "false")).WMP_MCP_ENABLED).toBe(false);
  });

  it("restores the environment after each case", () => {
    expect(Object.fromEntries(STUBBED.map((key) => [key, process.env[key]]))).toEqual(ORIGINAL);
  });
});
