import { afterEach, describe, expect, it, vi } from "vitest";

const KEY = "WMP_RATE_LIMIT_SCALE";
process.env.DATABASE_URL ||= "postgresql://env-default-test@127.0.0.1:5432/env_default_test";
process.env.BETTER_AUTH_SECRET = "w7Qp9Lm2Nx4Rv6Tk8Yc3Hu5Jd1Fs0ZaB";
process.env.BETTER_AUTH_URL = "http://localhost:3000";

const { ENV_VARS } = await import("../../../scripts/lib/env-manifest.js");

/** Load the real server schema with the scale set to `value` (unset when undefined). */
async function loadEnv(value: string | undefined) {
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
  vi.resetModules();
  return (await import("./server.js")).env;
}

afterEach(() => {
  delete process.env[KEY];
  vi.restoreAllMocks();
});

describe("rate-limit scale", () => {
  it("defaults to 1, matching the manifest", async () => {
    const env = await loadEnv(undefined);
    expect(env.WMP_RATE_LIMIT_SCALE).toBe(1);
    expect(ENV_VARS.find((entry) => entry.key === KEY)?.default).toBe("1");
  });

  it.each([
    ["0.1", 0.1],
    ["2.5", 2.5],
    ["100", 100],
  ])("accepts %s", async (value, expected) => {
    const env = await loadEnv(value);
    expect(env.WMP_RATE_LIMIT_SCALE).toBe(expected);
  });

  it("reads an empty value as the default", async () => {
    expect((await loadEnv("")).WMP_RATE_LIMIT_SCALE).toBe(1);
  });

  it.each(["0", "0.09", "100.5", "-1", "fast", "Infinity", "NaN"])("refuses %s", async (value) => {
    // The schema prints each validation failure before it throws.
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(loadEnv(value)).rejects.toThrow();
  });

  it("no longer declares the per-limiter RATE_LIMIT_* keys", () => {
    expect(ENV_VARS.filter((entry) => entry.key.startsWith("RATE_LIMIT_"))).toEqual([]);
  });
});
