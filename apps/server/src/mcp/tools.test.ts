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
  cancelMcpWriteToolCallsForGrant,
  mcpToolAllowed,
  resetMcpToolRateLimitsForTests,
  routeToolCall,
  runMcpTool,
} = await import("./tools");
const { testDispatch, testOAuthDispatch } = await import("./tools.test-helper");

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
  it("READ credentials get exactly the 7 read tools, FULL all 28", () => {
    expect(MCP_TOOL_NAMES.filter((name) => mcpToolAllowed(name, "READ"))).toEqual([
      ...MCP_READ_TOOLS,
    ]);
    expect(MCP_TOOL_NAMES.filter((name) => mcpToolAllowed(name, "FULL"))).toHaveLength(28);
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

  it("runtime_stop stops, or with markStopped marks an unprovable stop stopped (confirm MARK_STOPPED)", () => {
    expect(routeToolCall("runtime_stop", { runtimeId: "r", nodeId: "n" })).toEqual([
      { path: "runtimes.stop", input: { runtimeId: "r", nodeId: "n" } },
    ]);
    expect(routeToolCall("runtime_stop", { instanceId: "i" })).toEqual([
      { path: "runtimes.stop", input: { instanceId: "i" } },
    ]);
    expect(
      routeToolCall("runtime_stop", {
        instanceId: "i",
        markStopped: true,
        confirm: "MARK_STOPPED",
        note: "gone",
      }),
    ).toEqual([
      {
        path: "runtimes.instances.markStopped",
        input: { instanceId: "i", confirm: "MARK_STOPPED", note: "gone" },
      },
    ]);
    const stop = tool("runtime_stop").input;
    expect(stop.safeParse({ instanceId: "i", markStopped: true }).success).toBe(false);
    expect(
      stop.safeParse({ runtimeId: "r", markStopped: true, confirm: "MARK_STOPPED" }).success,
    ).toBe(false);
    expect(stop.safeParse({ instanceId: "i", confirm: "MARK_STOPPED" }).success).toBe(false);
    expect(stop.safeParse({ instanceId: "i", runtimeId: "r" }).success).toBe(false);
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
  it("an agent reaches the procedure: a pool it cannot see is NOT_FOUND", async () => {
    const result = await runMcpTool(tool("metrics_query"), {
      dispatch: testDispatch("READ"),
      args: { metrics: ["ttft_p95"], range: "24h", step: "5m", scope: { pool: "p" } },
    });
    expect(result.isError).toBe(true);
    expect(structured(result).error).toMatchObject({ code: "NOT_FOUND" });
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
  it("runtimes_get lists a held STOPPED instance compactly: nulls and empty lists left out", async () => {
    const instance = {
      id: "inst-1",
      phase: "STOPPED",
      phaseReason: null,
      needsOperator: null,
      openSteps: [],
      ranks: [
        {
          nodeNumber: 1,
          port: 30000,
          reserved: "HELD_UNKNOWN",
          nodeSlug: "spark-1958",
          lastStopCheck: {
            at: "2026-10-07T00:00:00.000Z",
            proven: false,
            errorCode: "port_in_use",
          },
        },
      ],
    };
    const result = await runMcpTool(tool("runtimes_get"), {
      dispatch: testDispatch("READ"),
      args: { runtimeId: "rt-1", versions: true },
      invoke: async (path) =>
        path === "runtimes.get" ? { id: "rt-1", instanceList: [instance] } : [{ version: 1 }],
    });
    expect(result.isError).toBeFalsy();
    expect(structured(result).result).toEqual({
      id: "rt-1",
      instanceList: [
        {
          id: "inst-1",
          phase: "STOPPED",
          ranks: [
            {
              nodeNumber: 1,
              port: 30000,
              reserved: "HELD_UNKNOWN",
              nodeSlug: "spark-1958",
              lastStopCheck: {
                at: "2026-10-07T00:00:00.000Z",
                proven: false,
                errorCode: "port_in_use",
              },
            },
          ],
        },
      ],
      versions: [{ version: 1 }],
    });
  });

  it("runtimes_get lists runtimes compactly, with the nodes each is on", async () => {
    const row = (nodes: unknown[]) => ({
      id: "rt-1",
      nodeId: null,
      forkedFromVersionId: null,
      models: [],
      nodes,
    });
    const result = await runMcpTool(tool("runtimes_get"), {
      dispatch: testDispatch("READ"),
      args: {},
      invoke: async () => ({ runtimes: [row([{ id: "node-1", slug: "box" }]), row([])] }),
    });
    expect(structured(result).result).toEqual({
      runtimes: [{ id: "rt-1", nodes: [{ id: "node-1", slug: "box" }] }, { id: "rt-1" }],
    });
  });

  it("pools_get leaves unknown member live load out, and keeps the known values", async () => {
    const pool = (live: Record<string, unknown>) => ({
      id: "pool-1",
      routing: { concurrencyLimit: null },
      members: [{ id: "m-1", live }],
    });
    const unknown = { instances: 1, running: 1, waiting: null, p95LatencyMs: null };
    const known = { instances: 2, running: 2, waiting: 3, p95LatencyMs: 840 };
    const one = await runMcpTool(tool("pools_get"), {
      dispatch: testDispatch("READ"),
      args: { poolId: "pool-1" },
      invoke: async () => pool(unknown),
    });
    expect(structured(one).result).toEqual({
      id: "pool-1",
      routing: { concurrencyLimit: null },
      members: [{ id: "m-1", live: { instances: 1, running: 1 } }],
    });
    const list = await runMcpTool(tool("pools_get"), {
      dispatch: testDispatch("READ"),
      args: {},
      invoke: async () => ({ pools: [pool(known)], sharedWithMe: [] }),
    });
    expect(structured(list).result).toEqual({ pools: [pool(known)], sharedWithMe: [] });
  });

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

  it("keeps a procedure's own message on a BAD_REQUEST without issues or reason", async () => {
    const result = await runMcpTool(tool("runtime_start"), {
      dispatch: testDispatch("FULL"),
      args: { runtimeId: "r", preview: true, count: 1 },
      invoke: async () => {
        throw new ORPCError("BAD_REQUEST", { message: "That start was refused." });
      },
    });
    expect(result.content).toEqual([{ type: "text", text: "That start was refused." }]);
    expect(structured(result).error).toEqual({
      code: "BAD_REQUEST",
      message: "That start was refused.",
    });
  });

  it("lists procedure validation issues as path and message", async () => {
    const result = await runMcpTool(tool("runtime_start"), {
      dispatch: testDispatch("FULL"),
      args: { runtimeId: "r" },
      invoke: async () => {
        throw new ORPCError("BAD_REQUEST", {
          message: "Input validation failed",
          cause: {
            issues: [{ path: [{ key: "nodeIds" }, 0], code: "too_small", message: "Too small" }],
          },
        });
      },
    });
    expect(structured(result).error).toEqual({
      code: "invalid_input",
      issues: [{ path: "nodeIds.0", message: "Too small" }],
    });
  });

  it("a sensitive tool's errors carry no procedure message", async () => {
    const result = await runMcpTool(tool("node_secret_set"), {
      dispatch: testDispatch("FULL"),
      args: { nodeId: "n", name: "WSMP_SECRET_HF", value: "hf_secret_value" },
      invoke: async () => {
        throw new ORPCError("BAD_REQUEST", { message: "value hf_secret_value is bad" });
      },
    });
    expect(JSON.stringify(result)).not.toContain("hf_secret_value");
    expect(structured(result).error).toEqual({ code: "BAD_REQUEST" });
  });

  it("runtime_start on an always-on runtime carries always_on_runtime through the real procedure", async () => {
    const { default: prisma } = await import("@ws-model-proxy/db");
    const db = prisma as unknown as {
      runtime: { findFirst: ReturnType<typeof vi.fn> };
      $transaction: ReturnType<typeof vi.fn>;
    };
    // The applied start plans inside its graph-write transaction.
    db.$transaction.mockImplementation(async (work: (tx: unknown) => unknown) => work(prisma));
    db.runtime.findFirst.mockResolvedValue({
      id: "rt-1",
      kind: "ALWAYS_ON",
      currentVersionId: "ver-1",
    });
    for (const args of [
      { runtimeId: "rt-1" },
      { runtimeId: "rt-1", instanceId: "inst-1" },
      { runtimeId: "rt-1", instanceId: "inst-1", preview: true },
    ]) {
      const result = await runMcpTool(tool("runtime_start"), {
        dispatch: testDispatch("FULL"),
        args,
      });
      expect(result.isError).toBe(true);
      expect(structured(result).error).toMatchObject({
        code: "BAD_REQUEST",
        reason: "always_on_runtime",
        subjectId: "rt-1",
      });
    }
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

  it("aborts a call that registers just after its credential was revoked", async () => {
    cancelMcpToolCallsForToken("late-token");
    const invoke = vi.fn(async () => ({}));
    const result = await runMcpTool(tool("nodes_get"), {
      dispatch: testDispatch("READ", { tokenId: "late-token" }),
      args: {},
      invoke,
    });
    expect(structured(result).error).toEqual({ code: "REQUEST_ABORTED" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("lowering a grant to Read-only aborts its in-flight write calls and lets its reads finish", async () => {
    const grantId = "lowered-grant";
    let writeStarted: () => void = () => undefined;
    const writeRunning = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    let readStarted: () => void = () => undefined;
    const readRunning = new Promise<void>((resolve) => {
      readStarted = resolve;
    });
    let finishRead: (value: unknown) => void = () => undefined;
    const write = runMcpTool(tool("pool_delete"), {
      dispatch: testOAuthDispatch("FULL", { grantId }),
      args: { poolId: "p", confirm: "DELETE" },
      invoke: () => {
        writeStarted();
        return new Promise(() => undefined);
      },
    });
    const read = runMcpTool(tool("nodes_get"), {
      dispatch: testOAuthDispatch("FULL", { grantId }),
      args: {},
      invoke: () => {
        readStarted();
        return new Promise((resolve) => {
          finishRead = resolve;
        });
      },
    });
    await Promise.all([writeRunning, readRunning]);
    expect(cancelMcpWriteToolCallsForGrant(grantId)).toBe(1);
    expect(structured(await write).error).toEqual({ code: "REQUEST_ABORTED" });
    finishRead({ nodes: [] });
    expect((await read).isError).toBeUndefined();
  });

  it("aborts a write that registers after the lowering with a level read before it; not a newer read", async () => {
    const grantId = "lowered-late-grant";
    const readBefore = performance.now();
    cancelMcpWriteToolCallsForGrant(grantId);
    const stale = vi.fn(async () => ({}));
    const staleResult = await runMcpTool(tool("pool_delete"), {
      dispatch: testOAuthDispatch("FULL", { grantId, levelReadAt: readBefore }),
      args: { poolId: "p", confirm: "DELETE" },
      invoke: stale,
    });
    expect(structured(staleResult).error).toEqual({ code: "REQUEST_ABORTED" });
    expect(stale).not.toHaveBeenCalled();

    // A read call on the same stale request is not a write: it runs.
    const reads = vi.fn(async () => ({ nodes: [] }));
    const readResult = await runMcpTool(tool("nodes_get"), {
      dispatch: testOAuthDispatch("FULL", { grantId, levelReadAt: readBefore }),
      args: {},
      invoke: reads,
    });
    expect(readResult.isError).toBeUndefined();
    expect(reads).toHaveBeenCalledTimes(1);

    // Raised again afterwards: a request that read the level after the lowering writes.
    const fresh = vi.fn(async () => ({ ok: true }));
    const freshResult = await runMcpTool(tool("pool_delete"), {
      dispatch: testOAuthDispatch("FULL", { grantId, levelReadAt: performance.now() + 1 }),
      args: { poolId: "p", confirm: "DELETE" },
      invoke: fresh,
    });
    expect(freshResult.isError).toBeUndefined();
    expect(fresh).toHaveBeenCalledTimes(1);
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
