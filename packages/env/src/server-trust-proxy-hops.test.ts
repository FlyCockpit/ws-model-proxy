import { afterEach, describe, expect, it, vi } from "vitest";

const KEY = "TRUST_PROXY_HOPS";
process.env.DATABASE_URL ||= "postgresql://env-default-test@127.0.0.1:5432/env_default_test";
process.env.BETTER_AUTH_SECRET = "w7Qp9Lm2Nx4Rv6Tk8Yc3Hu5Jd1Fs0ZaB";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

const { ENV_VARS } = await import("../../../scripts/lib/env-manifest.js");

/** Load the real server schema under `nodeEnv` with the hop count set to `value`. */
async function loadEnv(nodeEnv: string, value: string | undefined) {
  process.env.NODE_ENV = nodeEnv;
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
  vi.resetModules();
  return (await import("./server.js")).env;
}

afterEach(() => {
  delete process.env[KEY];
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  vi.restoreAllMocks();
});

describe("TRUST_PROXY_HOPS", () => {
  it.each(["development", "test"])("defaults to 0 in %s", async (nodeEnv) => {
    expect((await loadEnv(nodeEnv, undefined)).TRUST_PROXY_HOPS).toBe(0);
    expect((await loadEnv(nodeEnv, "")).TRUST_PROXY_HOPS).toBe(0);
  });

  it("refuses to start in production when unset, naming the variable and the usual values", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(loadEnv("production", undefined)).rejects.toThrow();
    const printed = JSON.stringify(errors.mock.calls);
    expect(printed).toContain("TRUST_PROXY_HOPS is required in production");
    expect(printed).toContain("Use 1 behind one reverse proxy");
    expect(printed).toContain("0 when clients connect to the app directly");
  });

  it("treats an empty value as unset in production", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(loadEnv("production", "")).rejects.toThrow();
  });

  it.each([
    ["0", 0],
    ["1", 1],
    ["2", 2],
    [" 1 ", 1],
  ])("accepts %j in production", async (value, expected) => {
    expect((await loadEnv("production", value)).TRUST_PROXY_HOPS).toBe(expected);
  });

  it.each(["-1", "1.5", "one", "1e0", "0x1", "true", "100"])("refuses %j", async (value) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(loadEnv("development", value)).rejects.toThrow();
  });

  it("is a required production prompt in the manifest", () => {
    const entry = ENV_VARS.find((candidate) => candidate.key === KEY);
    expect(entry?.required).toBe(true);
    expect(entry?.source).toBe("prompt");
  });
});
