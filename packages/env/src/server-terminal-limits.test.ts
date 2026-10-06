import { afterEach, describe, expect, it, vi } from "vitest";

const KEYS = ["WMP_TERMINAL_USER_LIMIT", "WMP_TERMINAL_CLI_LIMIT"] as const;
process.env.DATABASE_URL ||= "postgresql://env-default-test@127.0.0.1:5432/env_default_test";
process.env.BETTER_AUTH_SECRET = "w7Qp9Lm2Nx4Rv6Tk8Yc3Hu5Jd1Fs0ZaB";
process.env.BETTER_AUTH_URL = "http://localhost:3000";

const { ENV_VARS } = await import("../../../scripts/lib/env-manifest.js");

/** Load the real server schema with the terminal limits set to `values`. */
async function loadEnv(values: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const key of KEYS) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  return (await import("./server.js")).env;
}

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
  vi.restoreAllMocks();
});

describe("browser terminal limits", () => {
  it("default to 8 per user and 4 per CLI, matching the manifest", async () => {
    const env = await loadEnv({});
    expect(env.WMP_TERMINAL_USER_LIMIT).toBe(8);
    expect(env.WMP_TERMINAL_CLI_LIMIT).toBe(4);
    const manifestDefault = (key: string) => ENV_VARS.find((entry) => entry.key === key)?.default;
    expect(manifestDefault("WMP_TERMINAL_USER_LIMIT")).toBe("8");
    expect(manifestDefault("WMP_TERMINAL_CLI_LIMIT")).toBe("4");
  });

  it("accept whole numbers from 1 to 64", async () => {
    const env = await loadEnv({ WMP_TERMINAL_USER_LIMIT: "64", WMP_TERMINAL_CLI_LIMIT: "1" });
    expect(env.WMP_TERMINAL_USER_LIMIT).toBe(64);
    expect(env.WMP_TERMINAL_CLI_LIMIT).toBe(1);
  });

  it.each(["0", "65", "2.5", "many"])("refuse %s", async (value) => {
    // The schema prints each validation failure before it throws.
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(loadEnv({ WMP_TERMINAL_USER_LIMIT: value })).rejects.toThrow();
    await expect(loadEnv({ WMP_TERMINAL_CLI_LIMIT: value })).rejects.toThrow();
  });
});
