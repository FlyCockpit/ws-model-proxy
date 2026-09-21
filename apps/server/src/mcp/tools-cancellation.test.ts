import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

/**
 * Part G pass 3 cancellation + cleanup contract, mirrored from the R65/R66
 * renewal probes: the per-request DB abort fence (AsyncLocalStorage), the
 * fenced $transaction callback client, stage checks in the diagnostic and
 * credential-test paths, the durable-cleanup permit for capacity release,
 * and the emitted-size boundary (post-SDK headroom + bounded validation
 * errors) through the REAL installed transport.
 *
 * The db mock is the probe shape: mockDeep wrapped with the REAL
 * withDbShutdownFence, so the shared-client seam (and the module-level
 * fence state used by the gate's onClosed) is production code under test.
 */

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "********************",
    BETTER_AUTH_URL: "https://proxy.example.com",
    WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: true,
    WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS: "v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    MODEL_API_GLOBAL_CAPACITY_ENABLED: false,
    NODE_ENV: "test",
    RATE_LIMIT_MCP_POINTS: 1000,
    RATE_LIMIT_MCP_DURATION: 60,
  },
}));
vi.mock("@ws-model-proxy/env/shared", () => ({
  env: {
    BETTER_AUTH_SECRET: "********************",
    DATABASE_URL: "postgresql://unused",
    NODE_ENV: "test",
  },
}));
vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const { withDbShutdownFence } = await import("@ws-model-proxy/db/shutdown-fence");
  const raw = mockDeep();
  return {
    default: withDbShutdownFence(raw),
    raw,
    Prisma: {
      join: (values: unknown[]) => values,
      TransactionIsolationLevel: { Serializable: "Serializable", ReadCommitted: "ReadCommitted" },
    },
  };
});
vi.mock("@ws-model-proxy/api/lib/provider-egress", async (original) => ({
  ...(await original<typeof import("@ws-model-proxy/api/lib/provider-egress")>()),
  providerHttpsRequest: vi.fn(async () => ({ statusCode: 200, resume() {} })),
}));
vi.mock("@ws-model-proxy/api/lib/provider-credential-crypto", async (original) => ({
  ...(await original<typeof import("@ws-model-proxy/api/lib/provider-credential-crypto")>()),
  parseProviderCredentialKeyring: vi.fn(() => ({})),
  decryptProviderCredential: vi.fn(() => "probe-test-only-value"),
}));

const {
  armDbShutdownFence,
  disarmDbShutdownFence,
  DbRequestAbortFenceError,
  DbShutdownFenceError,
  isDbShutdownFenceArmed,
  runWithDbAbortFence,
} = await import("@ws-model-proxy/db/shutdown-fence");
const { createMcpAdmissionGate } = await import("./admission");
const { MCP_TOOL_MANIFEST } = await import("./tool-manifest");
const { runManifestTool, MCP_TOOL_OUTPUT_MAX_BYTES, MCP_TOOL_OUTPUT_SDK_HEADROOM_BYTES } =
  await import("./tools");
const { createMcpContext } = await import("./context");
const { createRouterClient } = await import("@orpc/server");
const { appRouter } = await import("@ws-model-proxy/api/routers/index");
const { createMcpTransport } = await import("./handler");
const { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } =
  await import("@modelcontextprotocol/server");
const dbModule = await import("@ws-model-proxy/db");
const raw = (
  dbModule as unknown as {
    raw: {
      $transaction: MockInstance;
      $queryRaw: MockInstance;
      poolMember: { findUnique: MockInstance };
      modelApiToken: { findUnique: MockInstance; update: MockInstance };
      providerAccount: { findFirst: MockInstance };
      providerCredential: { findFirst: MockInstance };
    };
  }
).raw;
const fencedClient = dbModule.default as unknown as {
  modelApiToken: { update: (args: unknown) => Promise<unknown> };
};

const USER: import("./context").McpSessionUser = {
  id: "user-1",
  name: "Test",
  email: "test@example.com",
  emailVerified: true,
  image: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  slug: "test",
  role: "user",
  locale: "en-US",
  banned: false,
  banReason: null,
  banExpires: null,
  twoFactorEnabled: true,
  operationalAlerts: true,
};

function buildContext(signal?: AbortSignal) {
  return createMcpContext({
    user: USER,
    expiresAt: new Date(Date.now() + 60_000),
    now: new Date(),
    services: signal !== undefined ? { signal } : undefined,
  });
}

/** One router client per test, bound to the SAME signal the dispatch carries
 * (mirrors production: auth.ts threads the permit signal into services). */
function routerClientFor(signal?: AbortSignal) {
  return createRouterClient(appRouter, { context: buildContext(signal) });
}

function descriptor(name: string) {
  const value = MCP_TOOL_MANIFEST.find((tool) => tool.name === name);
  if (!value) throw new Error(`missing descriptor ${name}`);
  return value;
}

let errorSpy: MockInstance;
let warnSpy: MockInstance;

beforeEach(() => {
  disarmDbShutdownFence();
  vi.clearAllMocks();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  disarmDbShutdownFence();
});

describe("G1 — transaction callbacks are fenced (paused tx resumed after gate close)", () => {
  it("provider_account_enabled_set: updateMany + audit create NEVER execute after close", async () => {
    let resolveLookup!: (value: unknown) => void;
    const lookup = new Promise((resolve) => {
      resolveLookup = resolve;
    });
    const tx = {
      $queryRaw: vi.fn(async () => []),
      providerAccount: {
        findFirst: vi
          .fn()
          .mockImplementationOnce(() => lookup)
          .mockResolvedValue({ id: "account-1" }),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      providerAuditEvent: { create: vi.fn(async () => ({})) },
    };
    raw.$transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback(tx),
    );
    const gate = createMcpAdmissionGate({ onClosed: armDbShutdownFence });
    const permit = gate.admit()!;
    const result = runManifestTool(descriptor("provider_account_enabled_set"), {
      dispatch: {
        orpcContext: buildContext(permit.controller.signal),
        requestId: "g1-tx",
        signal: permit.controller.signal,
      },
      scopes: ["mcp:write"],
      client: routerClientFor(permit.controller.signal),
      args: { id: "account-1", enabled: false },
    }).finally(() => permit.release());
    await vi.waitFor(() => expect(tx.providerAccount.findFirst).toHaveBeenCalledTimes(1));
    const closed = gate.close();
    permit.release();
    await closed;
    expect(gate.outstanding).toBe(0);
    expect((await result).structuredContent).toMatchObject({ error: { code: "REQUEST_ABORTED" } });
    // The paused lookup resolves post-close; the resumed transaction
    // callback's NEXT operations are rejected by the fenced tx client.
    resolveLookup({ id: "account-1", enabled: true, currentCredentialId: null });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(tx.providerAccount.updateMany).not.toHaveBeenCalled();
    expect(tx.providerAuditEvent.create).not.toHaveBeenCalled();
    // Sanitized, ctor-only fence log (the tool name is the wrapper's own
    // sanitized metadata; no operation arguments appear).
    const lines = errorSpy.mock.calls.flat().map(String);
    expect(lines.some((line) => line.includes("fence rejected"))).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain("account-1");
      expect(line).not.toContain("false");
      expect(line).not.toContain("DbShutdownFenceError: ");
    }
  });
});

describe("G1 — client abort (no shutdown) arms the per-request fence", () => {
  it("the resumed revoke update is rejected by the ALS abort fence", async () => {
    let resolveLookup!: (value: unknown) => void;
    raw.modelApiToken.findUnique.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
    );
    raw.modelApiToken.update.mockResolvedValue({ id: "token-1" });
    expect(DbRequestAbortFenceError).toBeDefined();
    const controller = new AbortController();
    const result = runManifestTool(descriptor("model_api_token_revoke"), {
      dispatch: {
        orpcContext: buildContext(controller.signal),
        requestId: "g1-client-abort",
        signal: controller.signal,
      },
      scopes: ["mcp:write"],
      client: routerClientFor(controller.signal),
      args: { id: "token-1", confirm: "DELETE" },
    });
    await vi.waitFor(() => expect(raw.modelApiToken.findUnique).toHaveBeenCalledTimes(1));
    controller.abort();
    expect((await result).structuredContent).toMatchObject({ error: { code: "REQUEST_ABORTED" } });
    // The wrapper settled, but the global fence is NOT armed — only the
    // per-request fence protects the resumed continuation.
    resolveLookup({ id: "token-1", userId: "user-1", revokedAt: null });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(raw.modelApiToken.update).not.toHaveBeenCalled();
    const lines = errorSpy.mock.calls.flat().map(String);
    expect(lines.some((line) => line.includes("DbRequestAbortFenceError"))).toBe(true);
  });

  it("provider_credential_test: the external HTTPS call never starts after abort", async () => {
    const { providerHttpsRequest } = await import("@ws-model-proxy/api/lib/provider-egress");
    raw.providerAccount.findFirst.mockResolvedValue({
      id: "account-1",
      userId: "user-1",
      deletedAt: null,
      currentCredentialId: "credential-1",
      providerType: "openai",
      baseUrl: "https://provider.example.com",
    });
    let resolveLookup!: (value: unknown) => void;
    raw.providerCredential.findFirst.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
    );
    const gate = createMcpAdmissionGate({ onClosed: armDbShutdownFence });
    const permit = gate.admit()!;
    const result = runManifestTool(descriptor("provider_credential_test"), {
      dispatch: {
        orpcContext: buildContext(permit.controller.signal),
        requestId: "g1-external",
        signal: permit.controller.signal,
      },
      scopes: ["mcp:write"],
      client: routerClientFor(permit.controller.signal),
      args: { providerAccountId: "account-1", confirm: "RUN" },
    }).finally(() => permit.release());
    await vi.waitFor(() => expect(raw.providerCredential.findFirst).toHaveBeenCalledTimes(1));
    const closed = gate.close();
    permit.release();
    await closed;
    expect((await result).structuredContent).toMatchObject({ error: { code: "REQUEST_ABORTED" } });
    resolveLookup({
      id: "credential-1",
      credentialType: "API_KEY",
      ciphertext: new Uint8Array(),
      nonce: new Uint8Array(),
      authTag: new Uint8Array(),
      keyVersion: "v1",
      algorithm: "AES-256-GCM",
      aadVersion: 1,
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(providerHttpsRequest).not.toHaveBeenCalled();
    expect(raw.$transaction).not.toHaveBeenCalled();
  });
});

describe("G1 — pool diagnostic: paused ownership lookup + abort dispatches nothing", () => {
  it("no relay request is sent after the caller aborted during the lookup", async () => {
    const { runPoolMemberTest } = await import("../model-api/diagnostics");
    const { ModelApiConcurrencyLimiter } = await import("../model-api/limits");
    const { mockDeep } = await import("vitest-mock-extended");
    type Manager = NonNullable<Parameters<typeof runPoolMemberTest>[0]["manager"]>;
    const manager = mockDeep<Manager>();
    manager.getActiveCliDeviceIds.mockReturnValue(["cli-1"]);
    let resolveLookup!: (value: unknown) => void;
    raw.poolMember.findUnique.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveLookup = resolve;
        }),
    );
    const controller = new AbortController();
    const result = runPoolMemberTest({
      userId: "user-1",
      memberId: "member-1",
      signal: controller.signal,
      manager,
      concurrencyLimiter: new ModelApiConcurrencyLimiter(),
    });
    await vi.waitFor(() => expect(raw.poolMember.findUnique).toHaveBeenCalledTimes(1));
    armDbShutdownFence();
    controller.abort();
    resolveLookup({
      id: "member-1",
      ModelPool: { userId: "user-1" },
      DiscoveredModel: {
        id: "model-1",
        published: true,
        upstreamModelId: "model",
        capabilityOverrideMode: "OVERRIDE",
        capabilityOverrides: ["TEXT_GENERATION"],
        capabilityOverrideMetadata: {
          version: 1,
          protocol: "openai-compatible",
          chatCompletions: { supported: true, streaming: true },
        },
        Endpoint: {
          published: true,
          slug: "local",
          cliDeviceId: "cli-1",
          capabilityMetadata: null,
          defaultCapabilities: ["TEXT_GENERATION"],
        },
      },
    });
    const outcome = await result;
    expect(outcome).toMatchObject({ outcome: "probe-error" });
    expect(manager.sendRelayRequest).not.toHaveBeenCalled();
    expect(manager.registerRelayResponseHandlers).not.toHaveBeenCalled();
  });
});

describe("G2n — durable cleanup permit (capacity release during shutdown)", () => {
  it("abort-triggered release transactions EXECUTE (not rejected) while the fence is armed", async () => {
    const { PostgresCapacityAdmissionStore } = await import("../model-api/capacity/postgres-store");
    const { holdCapacityLeaseForResponse } = await import("../model-api/capacity/response-lease");
    const tx = {
      $queryRaw: vi.fn(async () => [{ now: new Date() }]),
      $executeRaw: vi.fn(async () => 0),
      capacityWaiter: {
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
      capacityLease: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findMany: vi.fn(async () => []),
      },
      inferenceCapacity: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: "cap-1",
          hardConcurrencyLimit: null,
          schedulerCursor: 0,
          schedulerDeficits: null,
          schedulerVersion: null,
          nextFencingToken: 1n,
        })),
      },
      poolMember: { findMany: vi.fn(async () => []) },
      executionTarget: { findMany: vi.fn(async () => []) },
      admissionRequest: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUnique: vi.fn(async () => null),
      },
      relayRequest: { updateMany: vi.fn(async () => ({ count: 0 })) },
    };
    raw.$transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback(tx),
    );
    const store = new PostgresCapacityAdmissionStore();
    const gate = createMcpAdmissionGate({ onClosed: armDbShutdownFence });
    const permit = gate.admit()!;
    const lease = {
      leaseId: "lease-1",
      attemptId: "attempt-1",
      capacityId: "cap-1",
      executionTargetId: "target-1",
      fencingToken: 1n,
      expiresAt: new Date(Date.now() + 60_000),
    };
    holdCapacityLeaseForResponse({
      response: new Response(new ReadableStream()),
      store,
      lease,
      signal: permit.controller.signal,
      heartbeatIntervalMs: 0,
    });
    const closed = gate.close();
    permit.release();
    await closed;
    // The release retry loop settles WITHOUT the cleanup-failure warning:
    // the first permitted transaction executed and was acknowledged.
    await vi.waitFor(() => expect(tx.capacityLease.updateMany).toHaveBeenCalledTimes(1));
    expect(raw.$transaction).toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalledWith(
      "[capacity] response lease cleanup failed",
      expect.anything(),
    );
    // Durable WAITING→CANCELLED terminalization also executes under permit.
    raw.$transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        ...tx,
        admissionRequest: { ...tx.admissionRequest, findUnique: vi.fn(async () => null) },
      }),
    );
    await expect(store.terminalizeAttempt("waiting-attempt", "CANCELLED")).resolves.toMatchObject({
      state: "MISSING",
    });
    // NON-cleanup writes stay rejected while armed (the fence rejects
    // synchronously at call entry).
    expect(DbShutdownFenceError).toBeDefined();
    await expect(async () =>
      fencedClient.modelApiToken.update({ where: { id: "x" } }),
    ).rejects.toMatchObject({ name: "DbShutdownFenceError" });
  });
});

describe("G5 — the EMITTED (post-SDK) result respects the cap through the real transport", () => {
  const ENVELOPE = {
    [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
    [CLIENT_INFO_META_KEY]: { name: "probe", version: "1" },
    [CLIENT_CAPABILITIES_META_KEY]: {},
  };

  function payloadTool(blobChars: number) {
    return {
      ...descriptor("model_api_tokens_list"),
      name: "g5_wire",
      invokeProcedure: undefined,
      invokeCore: async () => ({ blob: "x".repeat(blobChars) }),
    };
  }

  async function wireResult(
    tool: unknown,
    args: unknown,
  ): Promise<{ bytes: number; body: unknown }> {
    const handler = createMcpTransport({
      registerTools: (server) => {
        server.registerTool(
          "g5_wire",
          {},
          async () =>
            await runManifestTool(tool as never, {
              dispatch: { orpcContext: buildContext(), requestId: "g5" },
              scopes: ["mcp:read"],
              client: undefined,
              args,
            }),
        );
      },
    });
    const response = await handler.fetch(
      new Request("https://proxy.example.com/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-method": "tools/call",
          "mcp-name": "g5_wire",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "g5_wire", arguments: args, _meta: ENVELOPE },
        }),
      }),
    );
    const body = (await response.json()) as { result?: unknown };
    await handler.close();
    return {
      bytes: new TextEncoder().encode(JSON.stringify(body.result ?? {})).length,
      body: body.result,
    };
  }

  it("a just-under payload: the SDK-encoded result stays within the advertised cap", async () => {
    const budget = MCP_TOOL_OUTPUT_MAX_BYTES - MCP_TOOL_OUTPUT_SDK_HEADROOM_BYTES;
    const under = Math.floor((budget - 512) / 2);
    const { bytes, body } = await wireResult(payloadTool(under), {});
    expect((body as { isError?: boolean }).isError).toBeUndefined();
    expect(bytes).toBeLessThanOrEqual(MCP_TOOL_OUTPUT_MAX_BYTES);
  });

  it("a just-over payload: refused with the small OUTPUT_TOO_LARGE result (SDK path included)", async () => {
    const budget = MCP_TOOL_OUTPUT_MAX_BYTES - MCP_TOOL_OUTPUT_SDK_HEADROOM_BYTES;
    const over = Math.floor((budget - 512) / 2) + 2048;
    const { bytes, body } = await wireResult(payloadTool(over), {});
    expect((body as { isError?: boolean }).isError).toBe(true);
    expect(bytes).toBeLessThan(1024);
  });

  it("G5 pass 5: an oversized chat payload is rejected by the byte bound before any dispatch", async () => {
    // With per-entry role validation removed for HTTP parity, the 64 KiB
    // first-stage input bound is the ONE intentional restriction — an
    // oversized payload still yields a small bounded error, never an
    // issues echo, and nothing is dispatched to the diagnostic core.
    const handler = createMcpTransport();
    const response = await handler.fetch(
      new Request("https://proxy.example.com/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-method": "tools/call",
          "mcp-name": "forwarder_chat_completion_test",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "forwarder_chat_completion_test",
            arguments: {
              model: "probe-model",
              messages: [{ role: "user", content: "x".repeat(70_000) }],
              confirm: "RUN",
            },
            _meta: ENVELOPE,
          },
        }),
      }),
    );
    const body = (await response.json()) as { result?: unknown };
    await handler.close();
    const result = body.result as { isError?: boolean } | undefined;
    expect(result?.isError).toBe(true);
    const bytes = new TextEncoder().encode(JSON.stringify(result ?? {})).length;
    expect(bytes).toBeLessThan(8192);
    expect(bytes).toBeLessThanOrEqual(MCP_TOOL_OUTPUT_MAX_BYTES);
    // No procedure/diagnostic side effect: nothing was dispatched.
    expect(raw.poolMember.findUnique).not.toHaveBeenCalled();
  });

  it("G5 pass 5 parity: `messages: []` passes the real transport and forwards to the core exactly like the HTTP regression", async () => {
    // The HTTP diagnostic relays `messages: []` successfully (pinned by
    // chat-test.test.ts); MCP input parity means the same payload passes
    // the advertised schema and reaches the diagnostic core verbatim.
    const invokeCore = vi.fn(async (_input: unknown, _deps: unknown) => ({ dispatched: true }));
    const chatDescriptor = descriptor("forwarder_chat_completion_test");
    const handler = createMcpTransport({
      registerTools: (server) => {
        // R73: register through the PRODUCTION advertised schema so the
        // WIRE arguments are validated by the real descriptor schema — the
        // regression now fails if the schema ever regresses to rejecting
        // empty messages (hardcoded args would bypass that contract).
        server.registerTool<StandardSchemaWithJSON, StandardSchemaWithJSON>(
          "parity_empty",
          { inputSchema: chatDescriptor.inputSchema },
          async (args: unknown) =>
            await runManifestTool(
              { ...chatDescriptor, name: "parity_empty", invokeCore },
              {
                dispatch: { orpcContext: buildContext(), requestId: "parity-empty" },
                scopes: ["mcp:write"],
                client: undefined,
                args,
              },
            ),
        );
      },
    });
    const response = await handler.fetch(
      new Request("https://proxy.example.com/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-method": "tools/call",
          "mcp-name": "parity_empty",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "parity_empty",
            arguments: { model: "m", confirm: "RUN", messages: [] },
            _meta: ENVELOPE,
          },
        }),
      }),
    );
    const body = (await response.json()) as { result?: unknown };
    await handler.close();
    expect(invokeCore).toHaveBeenCalledTimes(1);
    expect(invokeCore.mock.calls[0]?.[0]).toMatchObject({ model: "m", messages: [] });
    const firstCall = invokeCore.mock.calls[0];
    expect(firstCall).toBeDefined();
    const coreInput = firstCall?.[0] as Record<string, unknown> | undefined;
    expect(coreInput?.confirm).toBeUndefined();
    const result = body.result as { isError?: boolean } | undefined;
    expect(result?.isError).toBeUndefined();
  });

  it("G5 pass 4 parity: a valid 50-message history passes the real transport and reaches the core", async () => {
    // HTTP parity (both renewal reviewers): the shared chat diagnostic path
    // has NO message-count limit, so MCP must not add one. The 64 KiB
    // first-stage input bound remains the byte budget.
    const invokeCore = vi.fn(async (_input: unknown, _deps: unknown) => ({ dispatched: true }));
    const handler = createMcpTransport({
      registerTools: (server) => {
        server.registerTool("parity_chat", {}, async () => {
          return await runManifestTool(
            { ...descriptor("forwarder_chat_completion_test"), name: "parity_chat", invokeCore },
            {
              dispatch: { orpcContext: buildContext(), requestId: "parity" },
              scopes: ["mcp:write"],
              client: undefined,
              args: {
                model: "m",
                confirm: "RUN",
                messages: Array.from({ length: 50 }, () => ({
                  role: "user",
                  content: "hello",
                })),
              },
            },
          );
        });
      },
    });
    const args = {
      model: "m",
      confirm: "RUN",
      messages: Array.from({ length: 50 }, () => ({ role: "user", content: "hello" })),
    };
    const response = await handler.fetch(
      new Request("https://proxy.example.com/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "mcp-method": "tools/call",
          "mcp-name": "parity_chat",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "parity_chat", arguments: args, _meta: ENVELOPE },
        }),
      }),
    );
    const body = (await response.json()) as { result?: unknown };
    await handler.close();
    // Validation passed (no issues echo) and the diagnostic core RAN with
    // the full history — matching HTTP acceptance.
    expect(invokeCore).toHaveBeenCalledTimes(1);
    expect(invokeCore.mock.calls[0]?.[0]).toMatchObject({
      model: "m",
      messages: args.messages,
    });
    const firstCall = invokeCore.mock.calls[0];
    expect(firstCall).toBeDefined();
    const coreInput = firstCall?.[0] as Record<string, unknown> | undefined;
    expect(coreInput?.confirm).toBeUndefined();
    const result = body.result as { isError?: boolean } | undefined;
    expect(result?.isError).toBeUndefined();
  });
});

describe("G2n pass 4 — durable cleanup authority (the R67/R68 renewal probes, inverted)", () => {
  it("provider cancellation settlement EXECUTES post-abort (permitted): the reconciliation transaction opens and runs", async () => {
    const { reconcileProviderBudget } = await import("../model-api/provider-budget");
    const txExecute = vi.fn(async () => 0);
    const txQuery = vi.fn(async () => []);
    const tx = {
      $executeRaw: txExecute,
      $queryRaw: txQuery,
      providerAttempt: { findUnique: vi.fn(async () => null) },
    };
    raw.$transaction.mockImplementation(async (callback: (txClient: unknown) => Promise<unknown>) =>
      callback(tx),
    );
    const controller = new AbortController();
    controller.abort();
    // The settlement transaction OPENS and executes its advisory-lock
    // statements even though the request's abort fence is active
    // (permit-scoped to the durable transition).
    await expect(
      runWithDbAbortFence(controller.signal, () =>
        reconcileProviderBudget({
          userId: "user-1",
          providerAccountId: "account-1",
          providerModelId: "model-1",
          credentialId: "credential-1",
          poolId: "pool-1",
          requestId: "request-1",
          attemptId: "attempt-1",
          fencingToken: 1n,
          reason: "CANCELLED",
          revisionSequence: 1n,
          revisionKind: "SNAPSHOT",
        }),
      ),
    ).rejects.toThrow("No admitted provider attempt exists");
    expect(raw.$transaction).toHaveBeenCalled();
    expect(txExecute).toHaveBeenCalled();
    expect(txQuery).toHaveBeenCalled();
  });

  it("health-trial release EXECUTES post-abort (permitted): the release transaction runs", async () => {
    const { releaseProviderHealthTrial } = await import("../model-api/provider-attempt-runtime");
    const txQuery = vi.fn(async () => []);
    const owners = { healthHalfOpenAttemptId: null, healthHalfOpenFencingToken: null };
    const tx = {
      $queryRaw: txQuery,
      providerAccount: { findUniqueOrThrow: vi.fn(async () => owners), updateMany: vi.fn() },
      providerModel: { findUniqueOrThrow: vi.fn(async () => owners), updateMany: vi.fn() },
    };
    raw.$transaction.mockImplementation(async (callback: (txClient: unknown) => Promise<unknown>) =>
      callback(tx),
    );
    const controller = new AbortController();
    controller.abort();
    // Already-aborted context: the permit still lets the durable release
    // transition execute, and the permit does not leak out of its scope.
    await runWithDbAbortFence(controller.signal, async () => {
      await expect(
        releaseProviderHealthTrial({
          userId: "user-1",
          providerAccountId: "account-1",
          providerModelId: "model-1",
          attemptId: "attempt-1",
          fencingToken: 1n,
        }),
      ).resolves.toBe(false);
      await expect(async () =>
        fencedClient.modelApiToken.update({ where: { id: "x" } }),
      ).rejects.toMatchObject({ name: "DbRequestAbortFenceError" });
    });
    expect(raw.$transaction).toHaveBeenCalled();
    expect(txQuery).toHaveBeenCalled();
  });

  it("a fenced capacity poll failure for a persisted WAITING request still terminalizes it (permitted)", async () => {
    const { PostgresCapacityAdmissionStore } = await import("../model-api/capacity/postgres-store");
    const { StoreCapacityAdmissionRuntime } = await import("../model-api/capacity/runtime");
    const controller = new AbortController();
    // The poll transaction aborts the request at its first raw statement;
    // the transaction's NEXT operation is fence-rejected.
    const tx = {
      $executeRaw: vi.fn(async () => {
        controller.abort();
        return 0;
      }),
      admissionRequest: {
        findUnique: vi.fn(async () => ({
          id: "row",
          state: "WAITING",
          Lease: null,
          Waiters: [],
          deadlineAt: new Date(Date.now() + 60_000),
        })),
      },
      capacityWaiter: { findMany: vi.fn(async () => []) },
    };
    raw.$transaction.mockImplementation(async (callback: (txClient: unknown) => Promise<unknown>) =>
      callback(tx),
    );
    const store = new PostgresCapacityAdmissionStore();
    vi.spyOn(store, "acquire").mockResolvedValueOnce({
      state: "WAITING",
      requestId: "waiting-row",
    });
    const terminalize = vi
      .spyOn(store, "terminalizeAttempt")
      .mockResolvedValue({ state: "CANCELLED" });
    const runtime = new StoreCapacityAdmissionRuntime(store);
    vi.spyOn(runtime, "maintain").mockResolvedValue();
    const attempt = {
      attemptId: "waiting-attempt",
      requestId: "waiting-request",
      ownerId: "user-1",
      sourceKind: "DIRECT" as const,
      basePriority: 0,
      connectionOwner: "server-1",
      deadlineAt: new Date(Date.now() + 60_000),
      candidates: [{ capacityId: "cap-1", executionTargetId: "target-1", candidateOrder: 0 }],
    };
    await expect(
      runWithDbAbortFence(controller.signal, () => runtime.acquire(attempt, controller.signal)),
    ).rejects.toMatchObject({ name: "DbRequestAbortFenceError" });
    // The REQUIRED durable transition ran before the failure surfaced.
    expect(terminalize).toHaveBeenCalledTimes(1);
    expect(terminalize).toHaveBeenCalledWith("waiting-attempt", "CANCELLED");
  });

  it("shutdown-armed release completes WITHOUT authorizing new admissions (fill skipped)", async () => {
    const { PostgresCapacityAdmissionStore } = await import("../model-api/capacity/postgres-store");
    const tx = {
      $queryRaw: vi.fn(async () => [{ now: new Date() }]),
      $executeRaw: vi.fn(async () => 0),
      capacityWaiter: {
        findMany: vi.fn(async (args: { include?: unknown }) =>
          args.include
            ? [
                {
                  id: "waiter",
                  userId: "user-1",
                  admissionRequestId: "next-request",
                  executionTargetId: "target-1",
                  poolMemberId: null,
                  effectiveConcurrencyLimit: null,
                  effectivePriority: 0,
                  candidateOrder: 0,
                  AdmissionRequest: {
                    requestId: "req-next",
                    attemptId: "attempt-next",
                    enqueueSequence: 1n,
                  },
                },
              ]
            : [],
        ),
        updateMany: vi.fn(async () => ({ count: 1 })),
        update: vi.fn(async () => ({})),
      },
      capacityLease: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findMany: vi.fn(async () => []),
        create: vi.fn(async () => ({})),
      },
      inferenceCapacity: {
        findUniqueOrThrow: vi.fn(async () => ({
          hardConcurrencyLimit: null,
          schedulerCursor: 0,
          schedulerDeficits: null,
          schedulerVersion: null,
        })),
        update: vi.fn(async () => ({ nextFencingToken: 2n })),
      },
      poolMember: { findMany: vi.fn(async () => []) },
      executionTarget: { findMany: vi.fn(async () => []) },
      admissionRequest: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUnique: vi.fn(async (args: { where: { id?: string } }) =>
          args.where.id ? { state: "WAITING", Lease: null } : null,
        ),
        update: vi.fn(async () => ({})),
      },
      relayRequest: { updateMany: vi.fn(async () => ({ count: 0 })) },
    };
    raw.$transaction.mockImplementation(async (callback: (txClient: unknown) => Promise<unknown>) =>
      callback(tx),
    );
    armDbShutdownFence();
    const store = new PostgresCapacityAdmissionStore();
    await expect(
      store.release({
        leaseId: "lease-old",
        attemptId: "attempt-old",
        capacityId: "cap-1",
        executionTargetId: "target-1",
        fencingToken: 1n,
        expiresAt: new Date(),
      }),
    ).resolves.toBe(true);
    // The durable release transitions executed...
    expect(tx.capacityLease.updateMany).toHaveBeenCalledTimes(1);
    // ...but NO new lease was created and NO waiter was admitted during
    // teardown (the queued waiter stays WAITING for the next boot).
    expect(tx.capacityLease.create).not.toHaveBeenCalled();
    expect(tx.admissionRequest.update).not.toHaveBeenCalled();
    expect(tx.capacityWaiter.update).not.toHaveBeenCalled();
  });
});

describe("G2n pass 5 — shutdown arming DURING a fill stops the next admission (R69/R70 probes)", () => {
  /**
   * The race: #fillAvailable previously checked the shutdown fence ONCE at
   * loop entry; the enclosing release permit kept authorizing
   * capacityLease.create and WAITING→ADMITTED across the loop's awaits
   * after the fence armed mid-fill. The probes arm the fence inside
   * inferenceCapacity.findUniqueOrThrow — AFTER fill entry, BEFORE the
   * durable admission transitions.
   */
  function fillTx(options: { armOnFindUniqueCall: number }) {
    let findUniqueCalls = 0;
    const tx = {
      $queryRaw: vi.fn(async () => [{ now: new Date() }]),
      $executeRaw: vi.fn(async () => 0),
      capacityWaiter: {
        findMany: vi.fn(async (args: { include?: unknown }) =>
          args.include
            ? [
                {
                  id: "waiter",
                  userId: "user-1",
                  admissionRequestId: "next-request",
                  executionTargetId: "target-1",
                  poolMemberId: null,
                  effectiveConcurrencyLimit: null,
                  effectivePriority: 0,
                  candidateOrder: 0,
                  AdmissionRequest: {
                    requestId: "req-next",
                    attemptId: "attempt-next",
                    enqueueSequence: 1n,
                  },
                },
              ]
            : [],
        ),
        updateMany: vi.fn(async () => ({ count: 1 })),
        update: vi.fn(async () => ({})),
      },
      capacityLease: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findMany: vi.fn(async () => []),
        create: vi.fn(async () => ({})),
      },
      inferenceCapacity: {
        findUniqueOrThrow: vi.fn(async () => {
          findUniqueCalls += 1;
          if (findUniqueCalls >= options.armOnFindUniqueCall) armDbShutdownFence();
          return {
            hardConcurrencyLimit: null,
            schedulerCursor: 0,
            schedulerDeficits: null,
            schedulerVersion: null,
            nextFencingToken: 1n,
          };
        }),
        update: vi.fn(async () => ({ nextFencingToken: 2n })),
      },
      poolMember: { findMany: vi.fn(async () => []) },
      executionTarget: { findMany: vi.fn(async () => []) },
      admissionRequest: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUnique: vi.fn(async (args: { where: { id?: string } }) =>
          args.where.id ? { state: "WAITING", Lease: null } : null,
        ),
        update: vi.fn(async () => ({})),
      },
      relayRequest: { updateMany: vi.fn(async () => ({ count: 0 })) },
    };
    return tx;
  }

  function releaseLease(
    store: InstanceType<
      typeof import("../model-api/capacity/postgres-store").PostgresCapacityAdmissionStore
    >,
  ) {
    return store.release({
      leaseId: "lease-old",
      attemptId: "attempt-old",
      capacityId: "cap-1",
      executionTargetId: "target-1",
      fencingToken: 1n,
      expiresAt: new Date(),
    });
  }

  it("arming the fence DURING the fill (after entry) admits nobody: no lease create, no admission update", async () => {
    const { PostgresCapacityAdmissionStore } = await import("../model-api/capacity/postgres-store");
    const tx = fillTx({ armOnFindUniqueCall: 1 });
    raw.$transaction.mockImplementation(async (callback: (txClient: unknown) => Promise<unknown>) =>
      callback(tx),
    );
    const store = new PostgresCapacityAdmissionStore();
    // Fence NOT armed at release entry — it arms inside the fill's first
    // inferenceCapacity.findUniqueOrThrow, after fill entry.
    await expect(releaseLease(store)).resolves.toBe(true);
    // The durable release transitions executed under the permit...
    expect(tx.capacityLease.updateMany).toHaveBeenCalledTimes(1);
    // ...but the mid-fill fence arming stopped the admission BEFORE its
    // durable transitions: no lease, no WAITING→ADMITTED, no waiter flip.
    expect(tx.capacityLease.create).not.toHaveBeenCalled();
    expect(tx.admissionRequest.update).not.toHaveBeenCalled();
    expect(tx.capacityWaiter.update).not.toHaveBeenCalled();
    expect(isDbShutdownFenceArmed()).toBe(true);
  });

  it("a multi-waiter fill admits EXACTLY ONE waiter when shutdown arms after the first admission", async () => {
    const { PostgresCapacityAdmissionStore } = await import("../model-api/capacity/postgres-store");
    // The first #admitOne runs to completion (fence disarmed); the fence
    // arms inside the SECOND iteration's capacity read — the loop must
    // stop instead of admitting the remaining queue.
    const tx = fillTx({ armOnFindUniqueCall: 2 });
    raw.$transaction.mockImplementation(async (callback: (txClient: unknown) => Promise<unknown>) =>
      callback(tx),
    );
    const store = new PostgresCapacityAdmissionStore();
    await expect(releaseLease(store)).resolves.toBe(true);
    expect(tx.capacityLease.updateMany).toHaveBeenCalledTimes(1);
    // Exactly one admission committed, then the mid-loop fence stopped it.
    expect(tx.capacityLease.create).toHaveBeenCalledTimes(1);
    expect(tx.admissionRequest.update).toHaveBeenCalledTimes(1);
    expect(tx.capacityWaiter.update).toHaveBeenCalledTimes(1);
    expect(isDbShutdownFenceArmed()).toBe(true);
  });
});
