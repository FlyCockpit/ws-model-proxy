import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveMcpPlugins } from "./mcp-plugins";

const httpsBase = "https://ws-model-proxy.example.com";

describe("resolveMcpPlugins (WMP_MCP_ENABLED decision)", () => {
  it("is empty while disabled so the plugin list stays exactly admin/twoFactor/deviceAuthorization", () => {
    expect(resolveMcpPlugins({ enabled: false, baseUrl: httpsBase })).toEqual([]);
  });

  it("adds exactly jwt (mcp/oauth-provider) and cimd when enabled", () => {
    const plugins = resolveMcpPlugins({ enabled: true, baseUrl: httpsBase });
    expect(plugins.map((plugin) => plugin.id)).toEqual(["jwt", "oauth-provider", "cimd"]);
  });

  it("binds the MCP resource to the canonical public origin plus /mcp", () => {
    const plugins = resolveMcpPlugins({
      enabled: true,
      baseUrl: httpsBase,
    });
    const jwtPlugin = plugins[0];
    // mcp() folds `resource` into the oauth-provider `resources` list and
    // pins it into client-registration defaults.
    const mcpPlugin = plugins.find((plugin) => plugin.id === "oauth-provider");
    expect(jwtPlugin?.id).toBe("jwt");
    expect(mcpPlugin && "options" in mcpPlugin ? mcpPlugin.options.resources : undefined).toContain(
      `${httpsBase}/mcp`,
    );
    expect(
      mcpPlugin && "options" in mcpPlugin
        ? mcpPlugin.options.clientRegistrationDefaultResources
        : undefined,
    ).toContain(`${httpsBase}/mcp`);
  });

  it("keeps loopback HTTP dev origins usable (mcp validates loopback HTTP itself)", () => {
    const plugins = resolveMcpPlugins({
      enabled: true,
      baseUrl: "http://localhost:3000",
    });
    expect(plugins).toHaveLength(3);
    const mcpPlugin = plugins.find((plugin) => plugin.id === "oauth-provider");
    expect(mcpPlugin && "options" in mcpPlugin ? mcpPlugin.options.resources : undefined).toContain(
      "http://localhost:3000/mcp",
    );
  });
});

describe("auth instance wiring", () => {
  it("spreads resolveMcpPlugins after the three always-on plugins, gated on env.WMP_MCP_ENABLED", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain("...resolveMcpPlugins({\n      enabled: env.WMP_MCP_ENABLED,");
    // The three always-on plugins stay ahead of the gated spread.
    const deviceIndex = source.indexOf("deviceAuthorization({");
    const spreadIndex = source.indexOf("...resolveMcpPlugins(");
    expect(deviceIndex).toBeGreaterThan(-1);
    expect(spreadIndex).toBeGreaterThan(deviceIndex);
  });
});
