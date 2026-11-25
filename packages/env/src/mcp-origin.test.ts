import { describe, expect, it } from "vitest";
import { isMcpLoopbackHost, mcpOriginProblem } from "./mcp-origin.js";

describe("mcpOriginProblem", () => {
  it("refuses plain http on a LAN address while MCP is on, naming both variables and every fix", () => {
    const problem = mcpOriginProblem({
      mcpEnabled: true,
      betterAuthUrl: "http://192.168.1.10:3999",
    });
    expect(problem).toContain("BETTER_AUTH_URL=http://192.168.1.10:3999");
    expect(problem).toContain("WMP_MCP_ENABLED");
    expect(problem).toContain("https origin");
    expect(problem).toContain("http://localhost:<port>");
    expect(problem).toContain("http://127.0.0.1:<port>");
    expect(problem).toContain("WMP_MCP_ENABLED=false");
    // One line: entrypoints print it as is.
    expect(problem).not.toContain("\n");
  });

  it.each([
    "http://wsmp.lan:3000",
    "http://10.0.0.5",
    "http://example.com",
    "http://[2001:db8::1]:3000",
    "http://127.0.0.1.example.com",
    "http://localhost.example.com",
  ])("refuses plain http on %s while MCP is on", (url) => {
    expect(mcpOriginProblem({ mcpEnabled: true, betterAuthUrl: url })).not.toBeNull();
  });

  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:3999",
    "http://127.1.2.3",
    "http://[::1]:3000",
  ])("accepts loopback http %s while MCP is on", (url) => {
    expect(mcpOriginProblem({ mcpEnabled: true, betterAuthUrl: url })).toBeNull();
  });

  it.each(["https://wsmp.example.com", "https://192.168.1.10:3999", "https://localhost"])(
    "accepts https %s while MCP is on",
    (url) => {
      expect(mcpOriginProblem({ mcpEnabled: true, betterAuthUrl: url })).toBeNull();
    },
  );

  it("accepts plain http on a LAN address with MCP off", () => {
    expect(
      mcpOriginProblem({ mcpEnabled: false, betterAuthUrl: "http://192.168.1.10:3999" }),
    ).toBeNull();
  });
});

describe("isMcpLoopbackHost", () => {
  it("matches the hosts @better-auth/mcp allows over http, and nothing else", () => {
    for (const host of ["localhost", "[::1]", "127.0.0.1", "127.255.255.255"]) {
      expect(isMcpLoopbackHost(host)).toBe(true);
    }
    for (const host of ["::1", "127.0.0.256", "127.0.0", "0.0.0.0", "192.168.1.10", "wsmp.local"]) {
      expect(isMcpLoopbackHost(host)).toBe(false);
    }
  });
});
