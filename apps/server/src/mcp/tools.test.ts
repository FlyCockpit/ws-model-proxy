import { ORPCError } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret-0123456789",
    BETTER_AUTH_URL: "https://proxy.example.com",
    NODE_ENV: "test",
  },
}));
vi.mock("@ws-model-proxy/env/shared", () => ({
  env: { DATABASE_URL: "postgresql://mcp-tools-test", NODE_ENV: "test" },
}));
vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const { MCP_READ_TOOLS, MCP_TOOL_NAMES, MCP_TOOLS } = await import("@ws-model-proxy/api/contracts");
const {
  cancelMcpToolCallsForToken,
  mcpToolAllowed,
  resetMcpToolRateLimitsForTests,
  routeToolCall,
  runMcpTool,
} = await import("./tools");
const { testDispatch } = await import("./tools.test-helper");

function tool(name: string) {
  const contract = MCP_TOOLS.find((entry) => entry.name === name);
  if (!contract) throw new Error(`no tool ${name}`);
  return contract;
}

function structured(result: { structuredContent?: unknown }): Record<string, unknown> {
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

beforeEach(() => resetMcpToolRateLimitsForTests());
afterEach(() => vi.restoreAllMocks());

describe("MCP tool levels", () => {
  it("READ credentials get exactly the 7 read tools, FULL all 27", () => {
    expect(MCP_TOOL_NAMES.filter((name) => mcpToolAllowed(name, "READ"))).toEqual([
      ...MCP_READ_TOOLS,
    ]);
    expect(MCP_TOOL_NAMES.filter((name) => mcpToolAllowed(name, "FULL"))).toHaveLength(27);
  });

  it("a FULL tool called with a READ credential answers like an unknown tool and calls nothing", async () => {
    const invoke = vi.fn();
    const result = await runMcpTool(tool("pool_delete"), {
      dispatch: testDispatch("READ"),
      args: { poolId: "p", confirm: "DELETE" },
      invoke,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Tool pool_delete not found" }]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("fails closed without a verified dispatch", async () => {
    const invoke = vi.fn();
    const result = await runMcpTool(tool("nodes_get"), { dispatch: undefined, args: {}, invoke });
    expect(result.isError).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("routing to procedures", () => {
  it("picks list or get by input on the read tools", () => {
    expect(routeToolCall("nodes_get", {})).toEqual([{ path: "nodes.list", input: {} }]);
    expect(routeToolCall("nodes_get", { nodeId: "n" })).toEqual([
      { path: "nodes.get", input: { nodeId: "n" } },
    ]);
    expect(routeToolCall("runtimes_get", { runtimeId: "r", versions: true })).toEqual([
      { path: "runtimes.get", input: { runtimeId: "r" } },
      { path: "runtimes.versions.list", input: { runtimeId: "r" } },
    ]);
    expect(routeToolCall("runtimes_get", { presets: true })[0]?.path).toBe("runtimes.presets.list");
    expect(routeToolCall("pools_get", { poolId: "p", history: true }).map((c) => c.path)).toEqual([
      "pools.get",
      "pools.history.list",
    ]);
  });

  it("runtime_create forks with forkFrom, else creates (kind from nodeId)", () => {
    expect(
      routeToolCall("runtime_create", {
        slug: "copy",
        name: "Copy",
        forkFrom: { runtimeId: "r", versionId: "v" },
        limits: { a: 1 },
        note: "why",
      }),
    ).toEqual([
      {
        path: "runtimes.fork",
        input: {
          runtimeId: "r",
          versionId: "v",
          slug: "copy",
          name: "Copy",
          limits: { a: 1 },
          note: "why",
        },
      },
    ]);
    expect(routeToolCall("runtime_create", { slug: "a", name: "A", spec: {} })).toEqual([
      { path: "runtimes.create", input: { kind: "STARTABLE", slug: "a", name: "A", spec: {} } },
    ]);
    expect(
      routeToolCall("runtime_create", { slug: "a", name: "A", nodeId: "n", spec: {} })[0]?.input
        .kind,
    ).toBe("ALWAYS_ON");
  });

  it("runtime_update sets capabilities after the update", () => {
    expect(
      routeToolCall("runtime_update", {
        runtimeId: "r",
        modelCapabilities: [{ runtimeModelId: "m", capabilities: null }],
        note: "n",
      }),
    ).toEqual([
      { path: "runtimes.update", input: { runtimeId: "r", note: "n" } },
      {
        path: "runtimes.models.setCapabilities",
        input: { runtimeModelId: "m", capabilities: null, note: "n" },
      },
    ]);
  });

  it("pool_update contributes and withdraws, and updates only when something else changes", () => {
    expect(
      routeToolCall("pool_update", { poolId: "p", contribute: { add: ["m1"], withdraw: ["x"] } }),
    ).toEqual([
      { path: "pools.members.addContributed", input: { poolId: "p", runtimeModelId: "m1" } },
      { path: "pools.members.removeContributed", input: { memberId: "x" } },
    ]);
    expect(routeToolCall("pool_update", { poolId: "p", name: "New" })).toEqual([
      { path: "pools.update", input: { poolId: "p", name: "New" } },
    ]);
  });

  it("node_secret_set deletes on a null value", () => {
    expect(
      routeToolCall("node_secret_set", { nodeId: "n", name: "WSMP_SECRET_A", value: null }),
    ).toEqual([{ path: "nodes.secrets.delete", input: { nodeId: "n", name: "WSMP_SECRET_A" } }]);
    expect(
      routeToolCall("node_secret_set", { nodeId: "n", name: "WSMP_SECRET_A", value: "v" })[0]?.path,
    ).toBe("nodes.secrets.set");
  });

  it("every route stays inside the tool's own procedures", async () => {
    for (const contract of MCP_TOOLS) {
      for (const entry of routeToolCall(contract.name, {}))
        expect(contract.procedures, contract.name).toContain(entry.path);
    }
  });

  it("passes confirm through to the procedure (it checks it too)", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    await runMcpTool(tool("pool_delete"), {
      dispatch: testDispatch("FULL"),
      args: { poolId: "p", confirm: "DELETE" },
      invoke,
    });
    expect(invoke).toHaveBeenCalledWith(
      "pools.delete",
      { poolId: "p", confirm: "DELETE" },
      expect.objectContaining({ auth: expect.objectContaining({ kind: "agent_token" }) }),
      expect.any(AbortSignal),
    );
  });
});

describe("through the bound router", () => {
  it("an agent reaches the stub procedure and gets NOT_IMPLEMENTED", async () => {
    // metrics.query is still a stub (lane B5); nodes.list is implemented now.
    const result = await runMcpTool(tool("metrics_query"), {
      dispatch: testDispatch("READ"),
      args: { metrics: ["ttft_p95"], range: "24h", step: "5m", scope: { pool: "p" } },
    });
    expect(result.isError).toBe(true);
    expect(structured(result).error).toEqual({ code: "NOT_IMPLEMENTED" });
  });

  it("procedure input validation answers with paths only", async () => {
    const result = await runMcpTool(tool("nodes_get"), {
      dispatch: testDispatch("READ"),
      args: { nodeId: 7 },
    });
    expect(result.isError).toBe(true);
    expect(structured(result).error).toMatchObject({
      code: "invalid_input",
      issues: [{ path: "nodeId" }],
    });
  });
});

describe("errors and output", () => {
  it("copies a refusal's fixed message and reason", async () => {
    const result = await runMcpTool(tool("runtime_start"), {
      dispatch: testDispatch("FULL"),
      args: { runtimeId: "r" },
      invoke: async () => {
        throw new ORPCError("FORBIDDEN", {
          message: "The node is Relay only.",
          data: { reason: "trust_relay", subjectId: "node-1" },
        });
      },
    });
    expect(structured(result).error).toEqual({
      code: "FORBIDDEN",
      reason: "trust_relay",
      subjectId: "node-1",
      message: "The node is Relay only.",
    });
  });

  it("hides unknown failures behind a generic error with the request id", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await runMcpTool(tool("nodes_get"), {
      dispatch: testDispatch("READ"),
      args: {},
      invoke: async () => {
        throw new Error("SELECT * FROM secret_table");
      },
    });
    expect(result.content).toEqual([{ type: "text", text: "Internal error" }]);
    expect(JSON.stringify([result, error.mock.calls])).not.toContain("secret_table");
  });

  it("combines multi-procedure outputs and redacts credentials", async () => {
    const result = await runMcpTool(tool("providers_get"), {
      dispatch: testDispatch("READ"),
      args: {},
      invoke: async (path) =>
        path === "providers.accounts.list"
          ? { accounts: [{ id: "a", note: `wsmp_key_${"k".repeat(40)}` }] }
          : { models: [{ id: "m" }] },
    });
    expect(structured(result).result).toEqual({
      accounts: [{ id: "a", note: "[redacted]" }],
      models: [{ id: "m" }],
    });
  });
});

describe("rate limits", () => {
  it("limits start/stop/apply per credential", async () => {
    const invoke = vi.fn(async () => ({}));
    const dispatch = testDispatch("FULL");
    const results = [];
    for (let index = 0; index < 11; index += 1)
      results.push(
        await runMcpTool(tool("runtime_stop"), { dispatch, args: { runtimeId: "r" }, invoke }),
      );
    expect(results.slice(0, 10).every((result) => !result.isError)).toBe(true);
    expect(structured(results[10] ?? {}).error).toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(invoke).toHaveBeenCalledTimes(10);
  });

  it("counts model_test only for bench runs (2 per minute)", async () => {
    const invoke = vi.fn(async () => ({}));
    const dispatch = testDispatch("FULL");
    const contract = tool("model_test");
    const plain = { target: { runtimeId: "r" }, prompt: "hi" };
    const bench = { ...plain, bench: { repeat: 2, concurrency: 1 } };
    for (let index = 0; index < 5; index += 1)
      expect((await runMcpTool(contract, { dispatch, args: plain, invoke })).isError).toBeFalsy();
    expect((await runMcpTool(contract, { dispatch, args: bench, invoke })).isError).toBeFalsy();
    expect((await runMcpTool(contract, { dispatch, args: bench, invoke })).isError).toBeFalsy();
    const third = await runMcpTool(contract, { dispatch, args: bench, invoke });
    expect(structured(third).error).toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(invoke).toHaveBeenCalledTimes(7);
  });
});

describe("cancellation", () => {
  it("aborts a token's in-flight calls on revocation", async () => {
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const call = runMcpTool(tool("nodes_get"), {
      dispatch: testDispatch("READ", { tokenId: "revoked-token" }),
      args: {},
      invoke: () => {
        started();
        return new Promise(() => undefined);
      },
    });
    await running;
    expect(cancelMcpToolCallsForToken("revoked-token")).toBe(1);
    const result = await call;
    expect(structured(result).error).toEqual({ code: "REQUEST_ABORTED" });
    expect(cancelMcpToolCallsForToken("revoked-token")).toBe(0);
  });

  it("stops when the request's signal aborts", async () => {
    const controller = new AbortController();
    const call = runMcpTool(tool("nodes_get"), {
      dispatch: testDispatch("READ", { signal: controller.signal }),
      args: {},
      invoke: () => new Promise(() => undefined),
    });
    controller.abort();
    expect(structured(await call).error).toEqual({ code: "REQUEST_ABORTED" });
  });
});
