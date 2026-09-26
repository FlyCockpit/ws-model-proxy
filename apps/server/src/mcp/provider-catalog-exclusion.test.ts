import { describe, expect, it, vi } from "vitest";

/**
 * The OpenRouter catalog router (search makes an outbound fetch; import and
 * the pool external equivalent are owner writes) is browser-only. Pin that
 * every leaf is an explicit MCP exclusion and never a tool target.
 */

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret",
    BETTER_AUTH_URL: "https://proxy.example.com",
    WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: true,
    NODE_ENV: "test",
  },
}));
vi.mock("@ws-model-proxy/env/shared", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret",
    DATABASE_URL: "postgresql://mcp-provider-catalog-test",
    NODE_ENV: "test",
  },
}));
vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});
vi.mock("../relay/cli-commands.js", () => ({
  startCliCommand: vi.fn(),
  waitCliCommand: vi.fn(),
  snapshotCliCommand: vi.fn(),
}));

const { MCP_TOOL_MANIFEST, MCP_TOOL_EXCLUSIONS } = await import("./tool-manifest");
const { appRouter } = await import("@ws-model-proxy/api/routers/index");

describe("providerCatalog is not exposed through MCP", () => {
  it("excludes every providerCatalog leaf and maps none to a tool", () => {
    const leaves = Object.keys(appRouter.providerCatalog).map((name) => `providerCatalog.${name}`);
    expect(leaves.sort()).toEqual([
      "providerCatalog.getPoolExternalEquivalent",
      "providerCatalog.importModel",
      "providerCatalog.search",
      "providerCatalog.setPoolExternalEquivalent",
    ]);
    const excluded = new Set(MCP_TOOL_EXCLUSIONS.map((entry) => entry.target));
    const targets = MCP_TOOL_MANIFEST.map((tool) => tool.target);
    for (const leaf of leaves) {
      expect(excluded.has(leaf)).toBe(true);
      expect(targets).not.toContain(leaf);
    }
    expect(targets.some((target) => target.startsWith("providerCatalog."))).toBe(false);
  });
});
