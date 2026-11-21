import { afterEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL ||= "postgresql://env-default-test@127.0.0.1:5432/env_default_test";
process.env.BETTER_AUTH_SECRET = "w7Qp9Lm2Nx4Rv6Tk8Yc3Hu5Jd1Fs0ZaB";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
const key = "WMP_AGENT_TOKEN_MAX_LIFETIME_DAYS";
const { ENV_VARS } = await import("../../../scripts/lib/env-manifest.js");
async function load(value?: string) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  vi.resetModules();
  return (await import("./server.js")).env;
}
afterEach(() => {
  delete process.env[key];
  vi.restoreAllMocks();
});
describe("agent token maximum lifetime", () => {
  it("defaults to 90 days, matching the manifest", async () => {
    expect((await load()).WMP_AGENT_TOKEN_MAX_LIFETIME_DAYS).toBe(90);
    expect(ENV_VARS.find((entry) => entry.key === key)?.default).toBe("90");
  });
  it.each(["1", "3650"])("accepts boundary %s", async (value) => {
    expect((await load(value)).WMP_AGENT_TOKEN_MAX_LIFETIME_DAYS).toBe(Number(value));
  });
  it.each(["0", "3651", "2.5", "many"])("rejects %s", async (value) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(load(value)).rejects.toThrow();
  });
});
