import { describe, expect, it } from "vitest";

// Load the real server env schema with the flags UNSET, so the parsed `env`
// object shows the defaults (not the source text that declares them).
const FLAGS = [
  "WMP_PUBLIC_PROVIDER_EGRESS_ENABLED",
  "WMP_MCP_ENABLED",
  "WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY",
  "SIGNUP_ENABLED",
  "WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS",
] as const;
process.env.DATABASE_URL ||= "postgresql://env-default-test@127.0.0.1:5432/env_default_test";
process.env.BETTER_AUTH_SECRET = "w7Qp9Lm2Nx4Rv6Tk8Yc3Hu5Jd1Fs0ZaB";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
for (const flag of FLAGS) delete process.env[flag];

const { strictBooleanFlag } = await import("./shared.js");
const { env } = await import("./server.js");
const { ENV_VARS } = await import("../../../scripts/lib/env-manifest.js");

function manifestDefault(key: string): string | undefined {
  return ENV_VARS.find((entry) => entry.key === key)?.default;
}

describe("egress and MCP kill-switch defaults", () => {
  it("treats an omitted strictBooleanFlag(true) as true and an omitted strictBooleanFlag() as false", () => {
    expect(strictBooleanFlag(true).parse(undefined)).toBe(true);
    expect(strictBooleanFlag().parse(undefined)).toBe(false);
    expect(strictBooleanFlag(true).parse("false")).toBe(false);
    expect(strictBooleanFlag().parse("true")).toBe(true);
  });

  it("defaults egress and MCP on without opening signup or private networks", () => {
    expect(env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED).toBe(true);
    expect(env.WMP_MCP_ENABLED).toBe(true);
    expect(env.WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY).toBe(true);
    expect(env.SIGNUP_ENABLED).toBe(false);
    expect(env.WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS).toBe(false);

    expect(manifestDefault("WMP_PUBLIC_PROVIDER_EGRESS_ENABLED")).toBe("true");
    expect(manifestDefault("WMP_MCP_ENABLED")).toBe("true");
    expect(manifestDefault("WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY")).toBe("true");
    expect(manifestDefault("SIGNUP_ENABLED")).toBe("false");
    expect(manifestDefault("WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS")).toBe("false");
  });
});
