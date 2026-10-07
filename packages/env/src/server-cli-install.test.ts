import { afterEach, describe, expect, it, vi } from "vitest";

const KEYS = ["WMP_CLI_RELEASE_BASE_URL", "WMP_CLI_SOURCE_REV"] as const;
process.env.DATABASE_URL ||= "postgresql://env-default-test@127.0.0.1:5432/env_default_test";
process.env.BETTER_AUTH_SECRET = "w7Qp9Lm2Nx4Rv6Tk8Yc3Hu5Jd1Fs0ZaB";
process.env.BETTER_AUTH_URL = "http://localhost:3000";

/** Load the real server schema with the /install.sh settings set to `values`. */
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

describe("/install.sh settings", () => {
  it("are optional", async () => {
    const env = await loadEnv({});
    expect(env.WMP_CLI_RELEASE_BASE_URL).toBeUndefined();
    expect(env.WMP_CLI_SOURCE_REV).toBeUndefined();
  });

  it("accept an https release URL and drop its trailing slash", async () => {
    const env = await loadEnv({
      WMP_CLI_RELEASE_BASE_URL: "https://mirror.example.com:8443/wsmp/v0.4.0/",
    });
    expect(env.WMP_CLI_RELEASE_BASE_URL).toBe("https://mirror.example.com:8443/wsmp/v0.4.0");
  });

  // The script embeds the URL in single quotes and downloads over https only.
  it.each([
    "http://mirror.example.com/wsmp",
    "https://mirror.example.com/it's",
    "https://mirror.example.com/$(id)",
    "https://mirror.example.com/a b",
    "https://mirror.example.com/a?b=c",
    "ftp://mirror.example.com/wsmp",
  ])("refuse release URL %s", async (value) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(loadEnv({ WMP_CLI_RELEASE_BASE_URL: value })).rejects.toThrow();
  });
});
