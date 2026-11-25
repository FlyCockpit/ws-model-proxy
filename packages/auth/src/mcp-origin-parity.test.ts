import { mcpOriginProblem } from "@ws-model-proxy/env/mcp-origin";
import { describe, expect, it, vi } from "vitest";

// Differential test: the env guard (packages/env/src/mcp-origin.ts) must refuse
// exactly the origins for which the real MCP plugin construction throws its
// HTTPS TypeError, so the guard is neither weaker nor stricter than
// @better-auth/mcp. resolveMcpPlugins reads the secret from env at call time.
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://proxy.example.com",
    BETTER_AUTH_SECRET: "w7Qp9Lm2Nx4Rv6Tk8Yc3Hu5Jd1Fs0ZaB-parity",
    CORS_ORIGIN: undefined,
  },
}));
// The grant helpers it composes import Prisma; no test touches a database.
vi.mock("@ws-model-proxy/db", () => ({ default: {} }));

const { resolveMcpPlugins } = await import("./mcp-plugins");

const HTTPS_REFUSAL = "MCP resource URL must use HTTPS";

/** Whether constructing the MCP plugins refuses this origin for its scheme/host. */
function pluginRefuses(origin: string): boolean {
  try {
    resolveMcpPlugins({ enabled: true, baseUrl: origin });
    return false;
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith(HTTPS_REFUSAL)) return true;
    throw error;
  }
}

// Raw BETTER_AUTH_URL values; env's originUrl() hands the app `new URL(raw).origin`.
const RAW_ORIGINS = [
  "http://localhost:3000",
  "http://LOCALHOST:3000",
  "http://localhost.:3000",
  "http://localhost.example.com",
  "http://127.0.0.1:3999",
  "http://127.1:3999",
  "http://2130706433",
  "http://127.255.255.255",
  "http://127.0.0.1.example.com",
  "http://[::1]:3000",
  "http://[0:0:0:0:0:0:0:1]:3000",
  "http://[::ffff:127.0.0.1]:3000",
  "http://0.0.0.0:3000",
  "http://192.168.1.10:3999",
  "http://10.0.0.5",
  "http://wsmp.lan:3000",
  "http://example.com",
  "http://[2001:db8::1]:3000",
  "https://192.168.1.10:3999",
  "https://wsmp.example.com",
  "https://localhost",
];

describe("MCP origin guard parity with @better-auth/mcp", () => {
  it.each(RAW_ORIGINS)("agrees with the plugin on %s", (raw) => {
    const origin = new URL(raw).origin;
    const guardRefuses = mcpOriginProblem({ mcpEnabled: true, betterAuthUrl: origin }) !== null;
    expect(guardRefuses).toBe(pluginRefuses(origin));
  });

  it("covers both outcomes", () => {
    const outcomes = new Set(RAW_ORIGINS.map((raw) => pluginRefuses(new URL(raw).origin)));
    expect(outcomes).toEqual(new Set([true, false]));
  });
});
