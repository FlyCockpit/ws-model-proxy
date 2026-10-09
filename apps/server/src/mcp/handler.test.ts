import {
  type AuthInfo,
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  type McpRequestContext,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
} from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Transport contract tests (Phase 4 item 4) against the REAL
 * installed `@modelcontextprotocol/server@2.0.0` handler — no mocks on the
 * SDK itself. The modern (2026-07-28) wire shape used here was verified
 * against the installed entry: a request is modern iff `params._meta`
 * carries the protocol-version envelope (plus clientInfo and
 * clientCapabilities) and the `Mcp-Method` (and for tools/call, `Mcp-Name`)
 * headers agree with the body.
 *
 * Teardown observation: the SDK closes each request-created server through
 * the TRANSPORT (the low-level server's `onclose` fires), not through
 * `McpServer.close()` — the tests below hook `onclose` (and pin that
 * application code never calls `McpServer.close()` on a per-request
 * instance).
 */

import {
  createMcpTransport,
  MCP_SERVER_INFO,
  MCP_TRANSPORT_OPTIONS,
  mcpToolManifestHash,
} from "./handler";

// Phase 5: the default registration imports the tool manifest → appRouter →
// Prisma client and env validation chains. Mock both so no real environment
// or database is touched by the transport-contract tests below.
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret",
    BETTER_AUTH_URL: "https://proxy.example.com",
    NODE_ENV: "test",
  },
}));

vi.mock("@ws-model-proxy/env/shared", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret",
    DATABASE_URL: "postgresql://handler-test",
    NODE_ENV: "test",
  },
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

/** Minimal well-typed CallToolResult for the probe tool. */
type ProbeToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

import { MCP_READ_TOOLS } from "@ws-model-proxy/api/contracts";
import { SERVER_VERSION } from "../version";
import { registerMcpTools } from "./tools";

const ENVELOPE = {
  [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
  [CLIENT_INFO_META_KEY]: { name: "probe-client", version: "0.0.0" },
  [CLIENT_CAPABILITIES_META_KEY]: {},
} as const;

function modernRequest(method: string, id: number, extraParams: object = {}) {
  return new Request("http://proxy.example.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-protocol-version": "2026-07-28",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: { ...extraParams, _meta: ENVELOPE },
    }),
  });
}

function toolCallRequest(id: number, tool: string) {
  return new Request("http://proxy.example.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-method": "tools/call",
      "mcp-protocol-version": "2026-07-28",
      "mcp-name": tool,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: tool, arguments: {}, _meta: ENVELOPE },
    }),
  });
}

/**
 * A registerTools-style hook: registers the probe tool on the PASSED
 * per-request server and records lifecycle events (factory invocation,
 * SDK-owned teardown via the transport's onclose, and any application-side
 * close() call — which must NEVER happen).
 */
function trackedRegister(events: string[], toolImpl?: () => Promise<ProbeToolResult>) {
  return (server: McpServer, ctx: McpRequestContext) => {
    events.push(`factory${ctx.authInfo ? "-auth" : ""}`);
    server.registerTool("probe", { description: "probe tool" }, async () => {
      const override = await toolImpl?.();
      return override ?? { content: [{ type: "text" as const, text: "ok" }] };
    });
    // Application-side close on a per-request server must NEVER happen —
    // record any call so the tests can pin its absence.
    const originalClose = server.close.bind(server);
    server.close = async (...args: Parameters<typeof originalClose>) => {
      events.push("app-close-called");
      return originalClose(...args);
    };
    server.server.onclose = () => events.push("sdk-teardown");
  };
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  vi.restoreAllMocks();
});

describe("createMcpTransport — pinned configuration", () => {
  it("configures exactly legacy reject, json response mode, zero subscriptions", () => {
    expect(MCP_TRANSPORT_OPTIONS).toEqual({
      legacy: "reject",
      responseMode: "json",
      maxSubscriptions: 0,
    });
  });

  it("the default registration lists only the read tools when no verified credential is bound", () => {
    const server = new McpServer({ name: "t", version: "1" });
    registerMcpTools(server);
    const handler = createMcpTransport();
    return handler.fetch(modernRequest("tools/list", 1), undefined).then(async (res) => {
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: { tools?: { name: string }[] };
      };
      const names = body.result?.tools?.map((tool) => tool.name).sort();
      expect(names).toEqual([...MCP_READ_TOOLS].sort());
    });
  });
});

describe("createMcpTransport — advertised identity and capabilities", () => {
  it("never advertises tools.listChanged: a stateless JSON-only server sends no notifications", async () => {
    const res = await createMcpTransport().fetch(modernRequest("server/discover", 1));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result?: { capabilities?: { tools?: { listChanged?: boolean } } };
    };
    expect(body.result?.capabilities?.tools).toEqual({ listChanged: false });
  });

  it("carries the app version plus the tool manifest hash in serverInfo", async () => {
    expect(MCP_SERVER_INFO.version).toBe(`${SERVER_VERSION}+tools.${mcpToolManifestHash()}`);
    expect(mcpToolManifestHash()).toMatch(/^[0-9a-f]{12}$/);
    const res = await createMcpTransport().fetch(modernRequest("tools/list", 2));
    const body = (await res.json()) as {
      result?: { _meta?: Record<string, { name?: string; version?: string } | undefined> };
    };
    expect(body.result?._meta?.[SERVER_INFO_META_KEY]).toEqual(MCP_SERVER_INFO);
  });

  it("hashes names and input schemas deterministically, whatever their order", () => {
    const a = { name: "a_get", inputSchema: { type: "object", properties: { id: {} } } };
    const b = { name: "b_get", inputSchema: { type: "object" } };
    expect(mcpToolManifestHash([a, b])).toBe(mcpToolManifestHash([b, a]));
    // Key order inside a schema does not matter either.
    expect(mcpToolManifestHash([a, b])).toBe(
      mcpToolManifestHash([
        { inputSchema: { properties: { id: {} }, type: "object" }, name: "a_get" },
        b,
      ]),
    );
    expect(mcpToolManifestHash()).toBe(mcpToolManifestHash());
    expect(mcpToolManifestHash([a, b])).not.toBe(mcpToolManifestHash([a]));
    expect(mcpToolManifestHash([a, b])).not.toBe(
      mcpToolManifestHash([a, { ...b, inputSchema: { type: "object", required: ["id"] } }]),
    );
    expect(mcpToolManifestHash([a, b])).not.toBe(mcpToolManifestHash([a, { ...b, name: "c_get" }]));
  });
});

describe("createMcpTransport — modern POST exchanges", () => {
  it("a valid modern tools/call reaches a FRESH per-request McpServer and answers JSON (never SSE)", async () => {
    const events: string[] = [];
    const registerTools = trackedRegister(events);
    const handler = createMcpTransport({ registerTools });
    const res = await handler.fetch(toolCallRequest(1, "probe"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    // Stateless transport: no session header is ever issued (config pin
    // already forbids sessions; this is the wire-level proof).
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const body = (await res.json()) as { result?: { content?: unknown[] } };
    expect(body.result?.content).toEqual([{ type: "text", text: "ok" }]);
    expect(events).toContain("factory");
    // SDK-owned teardown fired by the time the response resolved.
    expect(events).toContain("sdk-teardown");
  });

  it("authInfo passed to fetch reaches the factory's request context VERBATIM", async () => {
    const seen: (AuthInfo | undefined)[] = [];
    const handler = createMcpTransport({
      registerTools: (server, ctx) => {
        seen.push(ctx.authInfo);
        server.registerTool("probe", {}, async () => ({
          content: [{ type: "text" as const, text: "ok" }],
        }));
      },
    });
    const authInfo: AuthInfo = {
      token: "presented-token",
      clientId: "client-a",
      scopes: ["mcp:read"],
      expiresAt: 1_900_000_000,
      resource: new URL("https://proxy.example.com/mcp"),
      extra: { sub: "user-1" },
    };
    const res = await handler.fetch(toolCallRequest(2, "probe"), { authInfo });
    expect(res.status).toBe(200);
    expect(seen.at(-1)).toEqual(authInfo);
  });

  it("SDK-owned teardown on FAILURE: a throwing tool still tears the per-request server down", async () => {
    const events: string[] = [];
    const registerTools = trackedRegister(events, async () => {
      throw new Error("boom-secret");
    });
    const handler = createMcpTransport({ registerTools });
    const res = await handler.fetch(toolCallRequest(3, "probe"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { isError?: boolean } };
    expect(body.result?.isError).toBe(true);
    expect(events).toContain("sdk-teardown");
    // Application code never closes the per-request server itself.
    expect(events).not.toContain("app-close-called");
  });

  it("SDK-owned teardown on ABORT: handler.close() resolves an in-flight exchange and tears its server down", async () => {
    const events: string[] = [];
    const registerTools = trackedRegister(events, () => new Promise(() => {}));
    const handler = createMcpTransport({ registerTools });
    const pending = handler
      .fetch(toolCallRequest(4, "probe"))
      .then((r) => r.status)
      .catch((e: unknown) => `rejected:${e instanceof Error ? e.constructor.name : typeof e}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await handler.close();
    expect(events).toContain("sdk-teardown");
    expect(events).not.toContain("app-close-called");
    expect(await pending).toBe(499);
  });

  it("close() is idempotent at the module-lifetime boundary (no throw on second call)", async () => {
    const handler = createMcpTransport();
    await handler.close();
    await expect(handler.close()).resolves.toBeUndefined();
  });
});

describe("createMcpTransport — legacy rejection and subscription refusal", () => {
  it("a 2025-era initialize (no envelope) is REJECTED with the unsupported-protocol-version error", async () => {
    const handler = createMcpTransport();
    const res = await handler.fetch(
      new Request("http://proxy.example.com/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 10,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "c", version: "1" },
          },
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error?: { code?: number; data?: { supported?: string[] } };
    };
    expect(body.error?.code).toBe(-32022);
    expect(body.error?.data?.supported).toEqual(["2026-07-28"]);
  });

  it("an envelope-less ping is rejected as modern-only (no 2025 serving exists)", async () => {
    const handler = createMcpTransport();
    const res = await handler.fetch(
      new Request("http://proxy.example.com/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "ping", params: {} }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: number } };
    expect(body.error?.code).toBe(-32022);
  });

  it("maxSubscriptions 0: subscriptions/listen is refused in-band (-32603), never an SSE stream", async () => {
    const handler = createMcpTransport();
    const res = await handler.fetch(modernRequest("subscriptions/listen", 12));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { error?: { code?: number; message?: string } };
    expect(body.error?.code).toBe(-32603);
    expect(body.error?.message).toBe("Subscription limit reached");
  });
});
