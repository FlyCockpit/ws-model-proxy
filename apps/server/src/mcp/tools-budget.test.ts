import {
  type AuthInfo,
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789",
    BETTER_AUTH_URL: "https://proxy.example.com",
    NODE_ENV: "test",
  },
}));
vi.mock("@ws-model-proxy/env/shared", () => ({
  env: { DATABASE_URL: "postgresql://mcp-budget-test", NODE_ENV: "test" },
}));
vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { MCP_READ_TOOLS, MCP_TOOL_NAMES } = await import("@ws-model-proxy/api/contracts");
const { createMcpTransport } = await import("./handler");
const { bindMcpToolDispatch } = await import("./tool-dispatch");
const { testDispatch } = await import("./tools.test-helper");

/**
 * The token budget of the server's REAL tools/list (owner guidance: terse tool definitions):
 * the production transport and registration, over the wire format a client receives.
 * Measured 2026-10-06 (27 tools, FULL): see the report in the S0 commit; fails above 6,500.
 */
const TOOLS_LIST_TOKEN_BUDGET = 6_500;

async function listTools(level: "READ" | "FULL") {
  const authInfo: AuthInfo = { token: "test", clientId: "c", scopes: ["mcp:read"] };
  bindMcpToolDispatch(authInfo, testDispatch(level));
  const handler = createMcpTransport();
  const response = await handler.fetch(
    new Request("http://proxy.example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-method": "tools/list",
        "mcp-protocol-version": "2026-07-28",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_INFO_META_KEY]: { name: "budget", version: "0" },
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    }),
    { authInfo },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    result?: { tools?: Array<Record<string, unknown> & { name: string }> };
  };
  return body.result?.tools ?? [];
}

describe("the server's tools/list", () => {
  it("lists all 28 tools for FULL credentials within the token budget (chars / 4)", async () => {
    const tools = await listTools("FULL");
    expect(tools.map((entry) => entry.name)).toEqual([...MCP_TOOL_NAMES]);
    const tokens = Math.ceil(JSON.stringify({ tools }).length / 4);
    console.info(`[budget] tools/list: ${tokens} tokens for ${tools.length} tools`);
    expect(tokens).toBeLessThanOrEqual(TOOLS_LIST_TOKEN_BUDGET);
  });

  it("advertises only name, description and the compact input schema", async () => {
    for (const entry of await listTools("FULL")) {
      expect(Object.keys(entry).sort(), entry.name).toEqual(["description", "inputSchema", "name"]);
    }
    const runtimeCreate = (await listTools("FULL")).find(
      (entry) => entry.name === "runtime_create",
    );
    const schema = runtimeCreate?.inputSchema as
      | { properties?: Record<string, unknown> }
      | undefined;
    const properties = schema?.properties;
    expect(properties?.spec).toMatchObject({ type: "object" });
  });

  it("lists only the read tools for READ credentials", async () => {
    expect((await listTools("READ")).map((entry) => entry.name)).toEqual([...MCP_READ_TOOLS]);
  });
});
