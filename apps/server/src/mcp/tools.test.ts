import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

/**
 * Phase 5 tool-wrapper contract tests, driven END-TO-END through the REAL
 * installed transport (`createMcpTransport` → SDK `tools/call` →
 * `registerMcpTools` wrappers → `createRouterClient(appRouter)` with the
 * per-request synthetic-session context) — the same path a verified /mcp
 * request takes after `onVerified` binds the dispatch. Prisma is mocked;
 * no test touches a real database.
 */

const providerGate = vi.hoisted(() => ({ enabled: true }));

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret",
    BETTER_AUTH_URL: "https://proxy.example.com",
    get WMP_PUBLIC_PROVIDER_EGRESS_ENABLED() {
      return providerGate.enabled;
    },
    NODE_ENV: "test",
    // auth.ts builds the MCP rate limiters at module scope (the full-chain
    // test below imports it).
    RATE_LIMIT_MCP_POINTS: 1000,
    RATE_LIMIT_MCP_DURATION: 60,
    RATE_LIMIT_MCP_CONSENT_POINTS: 2,
    RATE_LIMIT_MCP_CONSENT_DURATION: 60,
  },
}));

vi.mock("@ws-model-proxy/env/shared", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret",
    DATABASE_URL: "postgresql://mcp-tools-test",
    NODE_ENV: "test",
  },
}));

vi.mock("@ws-model-proxy/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  return { default: mockDeep() };
});

const cliRuntime = vi.hoisted(() => ({
  startCliCommand: vi.fn(),
  waitCliCommand: vi.fn(),
  snapshotCliCommand: vi.fn(),
  startSupervisedCommand: vi.fn(),
  snapshotSupervisedCommand: vi.fn((): unknown => null),
}));

vi.mock("../relay/cli-commands.js", () => cliRuntime);

const fileRuntime = vi.hoisted(() => ({ runFileOp: vi.fn(), auditRefusedFileInput: vi.fn() }));

vi.mock("../relay/cli-file-ops.js", () => ({
  runFileOp: fileRuntime.runFileOp,
  cancelFileOpsForToken: vi.fn(),
  sweepExpiredFileOps: vi.fn(),
  auditRefusedFileInput: fileRuntime.auditRefusedFileInput,
}));

// The full-chain test drives the Phase 4 request handler whose verifier is
// the upstream requireMcpAuth wrapper. Mock ONLY that wrapper (keeping the
// real `mcp` plugin via importOriginal — the auth package's plugin chain
// imports it at module scope), exactly like auth.test.ts: the mock invokes
// the wrapped handler with the claims parked in verifierState.
const verifierState = vi.hoisted(() => ({
  claims: {} as Record<string, unknown>,
}));

vi.mock("@better-auth/mcp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@better-auth/mcp")>();
  return {
    ...actual,
    requireMcpAuth: vi.fn(
      (
        _auth: unknown,
        handler: (request: Request, claims: Record<string, unknown>) => Promise<Response>,
        _opts: Record<string, unknown>,
      ) =>
        async (request: Request): Promise<Response> =>
          handler(request, verifierState.claims),
    ),
  };
});

const { createMcpTransport } = await import("./handler");
const {
  registerMcpTools,
  runManifestTool,
  MCP_TOOL_OUTPUT_MAX_BYTES,
  MCP_TOOL_OUTPUT_SDK_HEADROOM_BYTES,
} = await import("./tools");
const { MCP_TOOL_MANIFEST } = await import("./tool-manifest");
const { bindMcpToolDispatch } = await import("./tool-dispatch");
const { projectFileToolOutput } = await import("./cli-file-tools");
const { createMcpContext } = await import("./context");
const { default: prisma } = await import("@ws-model-proxy/db");
type McpToolDescriptor = (typeof MCP_TOOL_MANIFEST)[number];

const db = prisma as unknown as {
  modelApiToken: { findMany: MockInstance; findUnique: MockInstance; update: MockInstance };
  relayRequest: { findMany: MockInstance };
  cliDevice: { findMany: MockInstance };
  providerAccount: { findFirst: MockInstance };
  providerCredential: { findMany: MockInstance };
  mcpGrant: { findUnique: MockInstance };
  user: { findUnique: MockInstance };
  modelPool: { findUnique: MockInstance };
};

const ENVELOPE = {
  [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
  [CLIENT_INFO_META_KEY]: { name: "probe-client", version: "0.0.0" },
  [CLIENT_CAPABILITIES_META_KEY]: {},
} as const;

function toolCallRequest(id: number, tool: string, args: unknown = {}) {
  return new Request("http://proxy.example.com/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-method": "tools/call",
      "mcp-name": tool,
    },
    body: toolCallBody(tool, args, id),
  });
}

/** The exact JSON-RPC body a `tools/call` sends (byte length is what the /mcp body cap measures). */
function toolCallBody(tool: string, args: unknown, id = 1) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: tool, arguments: args, _meta: ENVELOPE },
  });
}

function toolsListRequest(id: number) {
  return new Request("http://proxy.example.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "mcp-method": "tools/list" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/list",
      params: { _meta: ENVELOPE },
    }),
  });
}

const USER: import("./context").McpSessionUser = {
  id: "user-1",
  name: "Test User",
  email: "test@example.com",
  emailVerified: true,
  image: null,
  createdAt: new Date("2025-01-01T00:00:00Z"),
  updatedAt: new Date("2025-01-01T00:00:00Z"),
  slug: "test-user-slug",
  role: "user",
  locale: "en-US",
  banned: null,
  banReason: null,
  banExpires: null,
  twoFactorEnabled: true,
  operationalAlerts: true,
};

function buildAuthInfo(scopes: string[]): AuthInfo {
  return {
    token: "verified-access-token",
    clientId: "client-a",
    scopes,
    expiresAt: 1_900_000_000,
    resource: new URL("https://proxy.example.com/mcp"),
    extra: { sub: "user-1" },
  };
}

/** Bind a dispatch exactly the way the production `onVerified` wiring does. */
function bindRequest(
  authInfo: AuthInfo,
  requestId = "req-42",
  credential?:
    | { kind: "oauth" }
    | {
        kind: "pat";
        tokenId: string;
        allowCliCommands: boolean;
        allowCliFileRead: boolean;
        scopes: readonly string[];
        expiresAt: Date | null;
      },
) {
  bindMcpToolDispatch(authInfo, {
    orpcContext: createMcpContext({
      user: USER,
      expiresAt: new Date("2026-01-01T00:00:00Z"),
      now: new Date("2025-06-01T00:00:00Z"),
      services: undefined,
    }),
    requestId,
    ...(credential !== undefined ? { credential } : {}),
  });
}

const CLI_FILE_TOOL_NAMES = [
  "forwarder_cli_file_read",
  "forwarder_cli_file_stat",
  "forwarder_cli_dir_list",
  "forwarder_cli_file_search",
  "forwarder_cli_file_edit",
  "forwarder_cli_file_write",
  "forwarder_cli_file_rename",
  "forwarder_cli_dir_create",
  "forwarder_cli_file_delete",
] as const;

/** Every PAT-only CLI tool: the three command tools and the nine node file tools. */
const CLI_COMMAND_TOOL_NAMES = new Set<string>([
  "deployment_plan_start",
  "deployment_plan_stop",
  "deployment_plan_apply",
  "forwarder_cli_command_run",
  "forwarder_cli_supervised_command_start",
  "forwarder_cli_command_result",
  "forwarder_cli_activity_list",
  "forwarder_device_metric_sources_set",
  "forwarder_device_engine_adapters_set",
  "forwarder_device_engine_adapters_clear",
  ...CLI_FILE_TOOL_NAMES,
]);

function catalogNames(includeCliCommands: boolean): string[] {
  return MCP_TOOL_MANIFEST.map((tool) => tool.name)
    .filter((name) => includeCliCommands || !CLI_COMMAND_TOOL_NAMES.has(name))
    .sort();
}

interface WireResult {
  content?: { type: string; text: string }[];
  structuredContent?: {
    result?: unknown;
    error?: {
      code?: string;
      fields?: string[];
      message?: string;
      issues?: {
        code: string;
        unknownKeyCount?: number;
        suggestions?: string[];
      }[];
    };
    requestId?: string;
  };
  isError?: boolean;
}

/** First text block of an in-band tool result (empty when absent). */
function resultText(result: { content?: { type: string; text?: unknown }[] }): string {
  const first = result.content?.[0];
  return typeof first?.text === "string" ? first.text : "";
}

async function callTool(
  authInfo: AuthInfo,
  tool: string,
  args: unknown,
): Promise<{ status: number; body: { result?: WireResult; error?: { message?: string } } }> {
  const handler = createMcpTransport();
  const response = await handler.fetch(
    toolCallRequest(Math.floor(Math.random() * 1e6), tool, args),
    {
      authInfo,
    },
  );
  return { status: response.status, body: (await response.json()) as never };
}

let consoleError: MockInstance;

beforeEach(() => {
  vi.clearAllMocks();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("tools/list — the manifest is the advertised catalog", () => {
  it("advertises exactly the manifest tool names", async () => {
    const handler = createMcpTransport();
    const response = await handler.fetch(toolsListRequest(1), undefined);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result?: { tools?: { name: string }[] } };
    const names = body.result?.tools?.map((tool) => tool.name).sort();
    // No credential is bound, so the two CLI command tools stay hidden.
    expect(names).toEqual(catalogNames(false));
  });

  it("a confirmation-gated tool advertises the required literal in its input schema", async () => {
    const handler = createMcpTransport();
    const response = await handler.fetch(toolsListRequest(2), undefined);
    const body = (await response.json()) as {
      result?: { tools?: { name: string; inputSchema?: { required?: string[] } }[] };
    };
    const revoke = body.result?.tools?.find((tool) => tool.name === "model_api_token_revoke");
    expect(revoke?.inputSchema?.required).toContain("confirm");
  });
});

describe("#117 — real input schemas and named failing fields", () => {
  it("bounds owner-scoped deployment metadata pages through the actual MCP handler", async () => {
    vi.mocked(prisma.deploymentConfig.findMany).mockResolvedValueOnce([]);
    const authInfo = buildAuthInfo(["mcp:read"]);
    bindRequest(authInfo);
    const { body } = await callTool(authInfo, "deployment_configs_list", {
      limit: 1,
      cursor: "another-owner-cursor",
    });
    expect(body.result?.structuredContent).toEqual({ result: { items: [], nextCursor: null } });
    expect(prisma.deploymentConfig.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1", id: { gt: "another-owner-cursor" } },
      orderBy: { id: "asc" },
      take: 2,
      include: { Revisions: { orderBy: { revision: "desc" }, take: 1 } },
    });
  });

  it("walks deployment metadata pages with a non-null nextCursor until the last page", async () => {
    const row = (id: string) => ({
      id,
      userId: "user-1",
      name: id,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      Revisions: [],
    });
    vi.mocked(prisma.deploymentConfig.findMany)
      .mockResolvedValueOnce([row("cfg-a"), row("cfg-b"), row("cfg-c")] as never)
      .mockResolvedValueOnce([row("cfg-c")] as never);
    const authInfo = buildAuthInfo(["mcp:read"]);
    bindRequest(authInfo);

    const first = await callTool(authInfo, "deployment_configs_list", { limit: 2 });
    const firstPage = first.body.result?.structuredContent?.result as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect(firstPage.items.map((item) => item.id)).toEqual(["cfg-a", "cfg-b"]);
    expect(firstPage.nextCursor).toBe("cfg-b");
    expect(prisma.deploymentConfig.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { userId: "user-1" }, take: 3 }),
    );

    const second = await callTool(authInfo, "deployment_configs_list", {
      limit: 2,
      cursor: firstPage.nextCursor,
    });
    const secondPage = second.body.result?.structuredContent?.result as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect(secondPage.items.map((item) => item.id)).toEqual(["cfg-c"]);
    expect(secondPage.nextCursor).toBeNull();
    expect(prisma.deploymentConfig.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { userId: "user-1", id: { gt: "cfg-b" } }, take: 3 }),
    );
  });

  it("rejects a malformed cursor as invalid input without a database read or echo", async () => {
    const authInfo = buildAuthInfo(["mcp:read"]);
    bindRequest(authInfo);
    const badCursor = `not a cursor ${"x".repeat(8)}/..`;
    const { body } = await callTool(authInfo, "deployment_configs_list", {
      limit: 2,
      cursor: badCursor,
    });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.structuredContent?.error?.fields).toEqual(["cursor"]);
    expect(JSON.stringify(body)).not.toContain(badCursor);
    expect(prisma.deploymentConfig.findMany).not.toHaveBeenCalled();
  });

  it("keeps safe procedure reason codes even when no declared field is supplied", async () => {
    const { ORPCError } = await import("@orpc/server");
    db.modelPool.findUnique.mockRejectedValueOnce(
      new ORPCError("BAD_REQUEST", { data: { reason: "CONCURRENCY_EXCEEDS_PHYSICAL" } }),
    );
    const authInfo = buildAuthInfo(["mcp:write"]);
    bindRequest(authInfo);
    const { body } = await callTool(authInfo, "forwarder_model_pool_update", { id: "pool-1" });
    expect(body.result?.structuredContent).toEqual({
      error: { code: "invalid_input", reason: "CONCURRENCY_EXCEEDS_PHYSICAL" },
    });
  });
  it("MCP trusted actor prevents a human-only paid policy mutation before database work", async () => {
    db.modelPool.findUnique.mockClear();
    const authInfo = buildAuthInfo(["mcp:write"]);
    bindRequest(authInfo);
    const { body } = await callTool(authInfo, "forwarder_model_pool_update", {
      id: "pool-1",
      paidWarmProtectionEnabled: true,
    });
    expect(body.result?.structuredContent).toEqual({ error: { code: "FORBIDDEN" } });
    expect(db.modelPool.findUnique).not.toHaveBeenCalled();
  });

  it("deployment command tools are hidden without PAT consent and visible with it", async () => {
    const handler = createMcpTransport();
    const oauth = buildAuthInfo(["mcp:write"]);
    bindRequest(oauth, "deployment-oauth", { kind: "oauth" });
    const oauthResult = await handler.fetch(toolsListRequest(902), { authInfo: oauth });
    const oauthBody = (await oauthResult.json()) as { result: { tools: Array<{ name: string }> } };
    expect(oauthBody.result.tools.map((tool) => tool.name)).not.toContain("deployment_plan_apply");
    const pat = buildAuthInfo(["mcp:write"]);
    bindRequest(pat, "deployment-pat", {
      kind: "pat",
      tokenId: "pat-1",
      allowCliCommands: true,
      allowCliFileRead: false,
      scopes: ["mcp:write"],
      expiresAt: null,
    });
    const patResult = await handler.fetch(toolsListRequest(903), { authInfo: pat });
    const patBody = (await patResult.json()) as { result: { tools: Array<{ name: string }> } };
    expect(patBody.result.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "deployment_plan_start",
        "deployment_plan_stop",
        "deployment_plan_apply",
        "deployment_config_create",
      ]),
    );
  });
  it("tools/list advertises the real required fields of a procedure-backed tool", async () => {
    const handler = createMcpTransport();
    const response = await handler.fetch(toolsListRequest(21), undefined);
    const body = (await response.json()) as {
      result?: {
        tools?: { name: string; inputSchema?: { required?: string[]; properties?: object } }[];
      };
    };
    const tool = (name: string) => body.result?.tools?.find((item) => item.name === name);
    expect(tool("forwarder_pool_fallback_get")?.inputSchema?.required).toEqual(["poolId"]);
    expect(tool("forwarder_pool_fallback_get")?.inputSchema?.properties).toHaveProperty("poolId");
    expect(tool("model_api_tokens_preview")?.inputSchema?.required).toEqual(["scopeMode"]);
  });

  it("the real tools/list payload (descriptions included) stays within the client budget", async () => {
    const handler = createMcpTransport();
    const response = await handler.fetch(toolsListRequest(22), undefined);
    const raw = await response.text();
    const bytes = new TextEncoder().encode(raw).length;
    // Measured 139-142 KB for 75-78 tools; the limit is ours, with headroom.
    expect(bytes).toBeGreaterThan(50_000);
    expect(bytes).toBeLessThanOrEqual(200 * 1024);
  });

  it("an unknown key on a strict procedure is never echoed; suggestions are declared names", async () => {
    const KEY = "plain-hostile-key-4242";
    const VALUE = "plain-hostile-value-4242";
    const authInfo = buildAuthInfo(["mcp:write"]);
    bindRequest(authInfo);
    const { body } = await callTool(authInfo, "forwarder_pool_fallback_update", {
      poolId: "pool-1",
      fallbackEnabled: true,
      [KEY]: VALUE,
    });
    expect(body.result?.isError).toBe(true);
    const wire = JSON.stringify(body);
    expect(wire).not.toContain(VALUE);
    expect(wire).not.toContain(KEY);
    const issues = body.result?.structuredContent?.error?.issues ?? [];
    expect(issues.map((issue) => issue.code)).toContain("unrecognized_keys");
    expect(body.result?.structuredContent?.error?.fields ?? []).not.toContain(KEY);
    expect(issues.some((issue) => (issue.unknownKeyCount ?? 0) > 0)).toBe(true);
  });

  it("a missing required field is named by path and code, and the procedure stays the authority", async () => {
    const authInfo = buildAuthInfo(["mcp:read"]);
    bindRequest(authInfo);
    const { body } = await callTool(authInfo, "forwarder_pool_fallback_get", {});
    expect(body.result?.isError).toBe(true);
    expect(body.result?.structuredContent).toEqual({
      error: {
        code: "invalid_input",
        fields: ["poolId"],
        message: "poolId: Invalid input: expected string, received undefined",
        issues: [
          {
            path: ["poolId"],
            code: "invalid_type",
            message: "Invalid input: expected string, received undefined",
          },
        ],
      },
    });
    expect(resultText(body.result ?? {})).toBe(
      "Invalid input: poolId: Invalid input: expected string, received undefined",
    );
  });

  it("never echoes input values, in any issue field, however the value is invalid", async () => {
    const SECRET = "wsmp_model_ZZSECRETVALUEZZ0123456789";
    const PLAIN = "plain-secret-value-9876";
    const cases: [string, Record<string, unknown>][] = [
      ["forwarder_pool_fallback_get", { poolId: SECRET.repeat(20) }],
      ["forwarder_pool_fallback_get", { poolId: { nested: PLAIN } }],
      ["forwarder_pool_fallback_get", { poolId: [PLAIN] }],
      ["forwarder_pool_fallback_get", { poolId: 42, extraKey: PLAIN }],
      ["model_api_tokens_preview", { scopeMode: PLAIN }],
      ["model_api_tokens_preview", { scopeMode: "ALLOWLIST", modelIds: [PLAIN, 7, SECRET] }],
    ];
    for (const [tool, args] of cases) {
      const authInfo = buildAuthInfo(["mcp:read"]);
      bindRequest(authInfo);
      const { body } = await callTool(authInfo, tool, args);
      expect(body.result?.isError).toBe(true);
      const wire = JSON.stringify(body);
      expect(wire).not.toContain(PLAIN);
      expect(wire).not.toContain("ZZSECRETVALUEZZ");
      expect(body.result?.structuredContent?.error?.code).toBe("invalid_input");
    }
  });

  it("a BAD_REQUEST without validation issues keeps the plain stable error", async () => {
    const { ORPCError } = await import("@orpc/server");
    db.modelApiToken.findUnique.mockRejectedValueOnce(
      new ORPCError("BAD_REQUEST", { message: "SECRET DETAIL", data: { issues: "not-a-list" } }),
    );
    const authInfo = buildAuthInfo(["mcp:write"]);
    bindRequest(authInfo);
    const { body } = await callTool(authInfo, "model_api_token_revoke", {
      id: "token-1",
      confirm: "DELETE",
    });
    expect(resultText(body.result ?? {})).toBe("Invalid input");
    expect(JSON.stringify(body)).not.toContain("SECRET");
  });

  it("a schema-valid BAD_REQUEST names the declared field and keeps the static message", async () => {
    const { ORPCError } = await import("@orpc/server");
    db.modelPool.findUnique.mockRejectedValueOnce(
      new ORPCError("BAD_REQUEST", {
        message: "Effective concurrency limit exceeds physical capacity.",
        data: {
          fields: ["capacityConcurrencyLimit", "hardConcurrencyLimit", "notAField", "pool id"],
        },
      }),
    );
    const authInfo = buildAuthInfo(["mcp:write"]);
    bindRequest(authInfo);
    const { body } = await callTool(authInfo, "forwarder_model_pool_update", {
      id: "pool-1",
      capacityConcurrencyLimit: 8,
    });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.structuredContent).toEqual({
      error: {
        code: "invalid_input",
        fields: ["capacityConcurrencyLimit"],
        message: "Effective concurrency limit exceeds physical capacity.",
      },
    });
    expect(resultText(body.result ?? {})).toBe(
      "Invalid input: capacityConcurrencyLimit: Effective concurrency limit exceeds physical capacity.",
    );
  });

  it("forwards a guarded-pool-create reason next to data.fields", async () => {
    const { ORPCError } = await import("@orpc/server");
    db.modelPool.findUnique.mockRejectedValueOnce(
      new ORPCError("BAD_REQUEST", {
        message: "Effective concurrency limit exceeds physical capacity.",
        data: {
          fields: ["capacityConcurrencyLimit"],
          reason: "CONCURRENCY_EXCEEDS_PHYSICAL",
        },
      }),
    );
    const authInfo = buildAuthInfo(["mcp:write"]);
    bindRequest(authInfo);
    const { body } = await callTool(authInfo, "forwarder_model_pool_update", {
      id: "pool-1",
      capacityConcurrencyLimit: 8,
    });
    expect(body.result?.structuredContent).toEqual({
      error: {
        code: "invalid_input",
        fields: ["capacityConcurrencyLimit"],
        message: "Effective concurrency limit exceeds physical capacity.",
        reason: "CONCURRENCY_EXCEEDS_PHYSICAL",
      },
    });
  });

  it("drops an unknown reason on the data.fields path", async () => {
    const { ORPCError } = await import("@orpc/server");
    db.modelPool.findUnique.mockRejectedValueOnce(
      new ORPCError("BAD_REQUEST", {
        message: "Effective concurrency limit exceeds physical capacity.",
        data: {
          fields: ["capacityConcurrencyLimit"],
          reason: "SECRET_REASON",
        },
      }),
    );
    const authInfo = buildAuthInfo(["mcp:write"]);
    bindRequest(authInfo);
    const { body } = await callTool(authInfo, "forwarder_model_pool_update", {
      id: "pool-1",
      capacityConcurrencyLimit: 8,
    });
    expect(body.result?.structuredContent).toEqual({
      error: {
        code: "invalid_input",
        fields: ["capacityConcurrencyLimit"],
        message: "Effective concurrency limit exceeds physical capacity.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("SECRET_REASON");
  });

  it("forwards guarded-create advanced.contextMargin through declared fields", async () => {
    const authInfo = buildAuthInfo(["mcp:write"]);
    bindRequest(authInfo);
    const { body } = await callTool(authInfo, "forwarder_guarded_pool_create", {
      slug: "guarded-margin",
      name: "Guarded margin",
      localModelIds: ["local-id"],
      recommendedSurface: "OPENAI_RESPONSES",
      memberConcurrencyLimit: 1,
      memberContextCeiling: 100,
      reservedSlots: 0,
      localWaitBudgetMs: 30_000,
      providerModels: [],
      advanced: {
        physicalCountStrategy: "CONSERVATIVE_ESTIMATE",
        contextMargin: 100,
        borrowPolicy: "WHEN_IDLE",
        protocolAdaptationEnabled: false,
        allowLossyDeveloperRoleCollapse: false,
        affinity: {
          enabled: false,
          ttlSeconds: 3_600,
          maxRecords: 10_000,
          prefixWeight: 100,
          conversationWeight: 150,
          confirmedCacheWeight: 250,
          loadPenaltyWeight: 100,
        },
        memberOverrides: [],
      },
    });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.structuredContent).toEqual({
      error: {
        code: "invalid_input",
        fields: ["advanced.contextMargin", "memberContextCeiling"],
        message: "Pool context margin must be smaller than the context ceiling.",
        reason: "POOL_POLICY_INVALID",
      },
    });
    expect(JSON.stringify(body.result?.structuredContent)).not.toContain("capacityContextMargin");
  });
});

describe("scope enforcement", () => {
  it("a read tool works with an mcp:read-only token (ownership stays in oRPC)", async () => {
    db.modelApiToken.findMany.mockResolvedValue([
      {
        id: "token-1",
        createdAt: new Date("2026-02-03T04:05:06Z"),
        updatedAt: new Date("2026-02-03T04:05:06Z"),
        userId: "user-1",
        name: "wsmp_model_SUPERSECRETVALUE",
        scopeMode: "ALL_VISIBLE",
        allowExternal: false,
        lookupPrefix: "wsmp_mod",
        lastUsedAt: null,
        revokedAt: null,
        expiresAt: null,
        AllowlistEntries: [],
      },
    ]);
    const authInfo = buildAuthInfo(["mcp:read", "offline_access"]);
    bindRequest(authInfo);
    const { status, body } = await callTool(authInfo, "model_api_tokens_list", {});
    expect(status).toBe(200);
    expect(body.result?.isError).toBeUndefined();
    expect(db.modelApiToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user-1" }),
      }),
    );
    const rows = body.result?.structuredContent?.result as {
      createdAt: string;
      name: string;
    }[];
    expect(rows[0]?.createdAt).toBe("2026-02-03T04:05:06.000Z");
    // Defense-in-depth value redaction: the product-credential-looking value
    // under a non-secret key is replaced, not shipped.
    expect(rows[0]?.name).toBe("[redacted]");
  });

  it("a read tool also works with an mcp:write-only token (write satisfies read)", async () => {
    db.modelApiToken.findMany.mockResolvedValue([]);
    const authInfo = buildAuthInfo(["mcp:write"]);
    bindRequest(authInfo);
    const { body } = await callTool(authInfo, "model_api_tokens_list", {});
    expect(body.result?.isError).toBeUndefined();
  });

  it("a write tool with a read-only token gets the in-band insufficient-scope error and NO procedure call", async () => {
    const authInfo = buildAuthInfo(["mcp:read"]);
    bindRequest(authInfo);
    const { status, body } = await callTool(authInfo, "model_api_token_revoke", {
      id: "token-1",
      confirm: "DELETE",
    });
    expect(status).toBe(200);
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("requires mcp:write");
    expect(body.result?.structuredContent?.error?.code).toBe("INSUFFICIENT_SCOPE");
    expect(db.modelApiToken.findUnique).not.toHaveBeenCalled();
  });

  it("a write tool with a literal mcp:write token runs the procedure", async () => {
    db.modelApiToken.findUnique.mockResolvedValue({
      id: "token-1",
      userId: "user-1",
      revokedAt: null,
    });
    db.modelApiToken.update.mockResolvedValue({
      id: "token-1",
      createdAt: new Date("2026-02-03T04:05:06Z"),
      updatedAt: new Date("2026-02-03T04:05:06Z"),
      name: "revoked token",
      scopeMode: "ALL_VISIBLE",
      allowExternal: false,
      lookupPrefix: "wsmp_mod",
      lastUsedAt: null,
      revokedAt: new Date("2026-03-01T00:00:00Z"),
      expiresAt: null,
      AllowlistEntries: [],
    });
    const authInfo = buildAuthInfo(["mcp:write", "mcp:read"]);
    bindRequest(authInfo);
    const { body } = await callTool(authInfo, "model_api_token_revoke", {
      id: "token-1",
      confirm: "DELETE",
    });
    expect(body.result?.isError).toBeUndefined();
    expect(db.modelApiToken.update).toHaveBeenCalled();
    // The ceremonial confirm literal never reaches the procedure input.
    const updateArgs = db.modelApiToken.update.mock.calls[0]?.[0] as {
      data?: Record<string, unknown>;
    };
    expect(updateArgs.data).not.toHaveProperty("confirm");
  });
});

describe("fail-closed dispatch", () => {
  it("a tool call whose authInfo has NO bound dispatch never reaches a procedure", async () => {
    const authInfo = buildAuthInfo(["mcp:read"]);
    // NOTE: no bindRequest — nothing was verified/admitted for this authInfo.
    const { status, body } = await callTool(authInfo, "model_api_tokens_list", {});
    expect(status).toBe(200);
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toBe("Internal error");
    expect(body.result?.structuredContent?.error?.code).toBe("INTERNAL_ERROR");
    expect(db.modelApiToken.findMany).not.toHaveBeenCalled();
  });
});

describe("confirmation gate", () => {
  it("missing confirmation is rejected in-band (wrapper level, below the SDK schema)", async () => {
    const descriptor = requireDescriptor("model_api_token_revoke");
    const authInfo = buildAuthInfo(["mcp:write"]);
    bindRequest(authInfo);
    const result = await runManifestTool(descriptor, {
      dispatch: {
        orpcContext: createMcpContext({
          user: USER,
          expiresAt: new Date("2026-01-01T00:00:00Z"),
          now: new Date("2025-06-01T00:00:00Z"),
          services: undefined,
        }),
        requestId: "req-42",
      },
      scopes: ["mcp:write"],
      client: undefined,
      args: { id: "token-1" },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain('confirm="DELETE"');
    expect((result.structuredContent as { error?: { code?: string } }).error?.code).toBe(
      "CONFIRMATION_REQUIRED",
    );
    expect(db.modelApiToken.findUnique).not.toHaveBeenCalled();
  });

  it("the SDK rejects a gated tools/call whose arguments omit the literal (no procedure call)", async () => {
    const authInfo = buildAuthInfo(["mcp:write"]);
    bindRequest(authInfo);
    const { body } = await callTool(authInfo, "cli_token_revoke", { id: "cli-token-1" });
    expect(body.result?.isError).toBe(true);
    expect(db.modelApiToken.update).not.toHaveBeenCalled();
  });
});

describe("error mapping", () => {
  it("ownership-hiding NOT_FOUND maps to the stable 'Not found' without the app message", async () => {
    db.modelApiToken.findUnique.mockResolvedValue(null);
    const authInfo = buildAuthInfo(["mcp:write"]);
    bindRequest(authInfo);
    const { body } = await callTool(authInfo, "model_api_token_revoke", {
      id: "foreign-or-missing",
      confirm: "DELETE",
    });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toBe("Not found");
    expect(body.result?.structuredContent?.error?.code).toBe("NOT_FOUND");
    // The app-authored oRPC message is never copied to the tool output.
    expect(JSON.stringify(body)).not.toContain("Model API token not found");
  });

  it.each([
    {
      tool: "forwarder_cli_device_get",
      args: { cliDeviceId: "cli-other-owner" },
      mock: () =>
        vi
          .mocked(prisma.cliDevice.findUnique)
          .mockResolvedValue({ id: "cli-other-owner", userId: "user-2" } as never),
      appMessage: "CLI device not found.",
    },
    {
      tool: "forwarder_model_pool_get",
      args: { poolId: "pool-other-owner" },
      mock: () =>
        vi
          .mocked(prisma.modelPool.findUnique)
          .mockResolvedValue({ id: "pool-other-owner", userId: "user-2" } as never),
      appMessage: "Model pool not found.",
    },
  ])(
    "$tool hides another owner's id as NOT_FOUND through the manifest tool",
    async ({ tool, args, mock, appMessage }) => {
      mock();
      const descriptor = MCP_TOOL_MANIFEST.find((entry) => entry.name === tool);
      if (!descriptor) throw new Error(`missing manifest tool ${tool}`);
      const orpcContext = createMcpContext({
        user: USER,
        expiresAt: new Date("2026-01-01T00:00:00Z"),
        now: new Date("2025-06-01T00:00:00Z"),
        services: undefined,
      });
      const { createRouterClient } = await import("@orpc/server");
      const { appRouter } = await import("@ws-model-proxy/api/routers/index");
      const result = await runManifestTool(descriptor, {
        dispatch: { orpcContext, requestId: "req-42" },
        scopes: ["mcp:read"],
        client: createRouterClient(appRouter, { context: orpcContext }),
        args,
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toBe("Not found");
      expect(result.structuredContent).toMatchObject({ error: { code: "NOT_FOUND" } });
      expect(JSON.stringify(result)).not.toContain(appMessage);
      expect(JSON.stringify(result)).not.toContain("user-2");
    },
  );

  it("unknown failures become the generic internal error with the request id, never the cause", async () => {
    db.modelApiToken.findUnique.mockRejectedValue(
      new Error("PrismaClientKnownRequestError P2025 SECRET_SQL FROM provider"),
    );
    const authInfo = buildAuthInfo(["mcp:write"]);
    bindRequest(authInfo, "req-77");
    const { body } = await callTool(authInfo, "model_api_token_revoke", {
      id: "token-1",
      confirm: "DELETE",
    });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toBe("Internal error");
    expect(body.result?.structuredContent?.requestId).toBe("req-77");
    expect(JSON.stringify(body)).not.toContain("SECRET_SQL");
    // The sanitized log line carries the constructor name only.
    const logged = consoleError.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("Error");
    expect(logged).not.toContain("SECRET_SQL");
  });

  it("forwards a deletion CONFLICT's stable reason, never its message", async () => {
    const { ORPCError } = await import("@orpc/server");
    const { DELETION_CONFLICT_REASONS } = await import("@ws-model-proxy/config/deletion-conflict");
    for (const reason of DELETION_CONFLICT_REASONS) {
      db.modelApiToken.findUnique.mockRejectedValueOnce(
        new ORPCError("CONFLICT", { message: "APP MESSAGE DETAIL", data: { reason } }),
      );
      const authInfo = buildAuthInfo(["mcp:write"]);
      bindRequest(authInfo);
      const { body } = await callTool(authInfo, "model_api_token_revoke", {
        id: "token-1",
        confirm: "DELETE",
      });
      expect(body.result?.isError).toBe(true);
      expect(body.result?.content?.[0]?.text).toBe(`Conflict: ${reason}`);
      expect(body.result?.structuredContent).toEqual({ error: { code: "CONFLICT", reason } });
      expect(JSON.stringify(body)).not.toContain("APP MESSAGE DETAIL");
    }
  });

  it("drops an unknown CONFLICT reason and any other data", async () => {
    const { ORPCError } = await import("@orpc/server");
    for (const data of [
      { reason: "SECRET_REASON", extra: "SECRET_DATA" },
      { reason: { nested: "SECRET_DATA" } },
      "SECRET_DATA",
      undefined,
    ]) {
      db.modelApiToken.findUnique.mockRejectedValueOnce(
        new ORPCError("CONFLICT", { message: "APP MESSAGE DETAIL", data }),
      );
      const authInfo = buildAuthInfo(["mcp:write"]);
      bindRequest(authInfo);
      const { body } = await callTool(authInfo, "model_api_token_revoke", {
        id: "token-1",
        confirm: "DELETE",
      });
      expect(body.result?.content?.[0]?.text).toBe("Conflict");
      expect(body.result?.structuredContent).toEqual({ error: { code: "CONFLICT" } });
      expect(JSON.stringify(body)).not.toContain("SECRET");
    }
    // A deletion reason on another code is not forwarded either.
    db.modelApiToken.findUnique.mockRejectedValueOnce(
      new ORPCError("BAD_REQUEST", { data: { reason: "retained_history" } }),
    );
    const authInfo = buildAuthInfo(["mcp:write"]);
    bindRequest(authInfo);
    const { body } = await callTool(authInfo, "model_api_token_revoke", {
      id: "token-1",
      confirm: "DELETE",
    });
    expect(body.result?.structuredContent).toEqual({ error: { code: "BAD_REQUEST" } });
  });

  it("non-allowlisted oRPC codes also collapse to the generic internal error", async () => {
    const { ORPCError } = await import("@orpc/server");
    db.modelApiToken.findUnique.mockRejectedValue(
      new ORPCError("INTERNAL_SERVER_ERROR", { message: "DATABASE SECRET DETAIL" }),
    );
    const authInfo = buildAuthInfo(["mcp:write"]);
    bindRequest(authInfo);
    const { body } = await callTool(authInfo, "model_api_token_revoke", {
      id: "token-1",
      confirm: "DELETE",
    });
    expect(body.result?.content?.[0]?.text).toBe("Internal error");
    expect(JSON.stringify(body)).not.toContain("DATABASE SECRET DETAIL");
  });
});

describe("safe projections and redaction", () => {
  it("provider_credentials_list keeps ONLY the safe credential fields even when the row carries more", async () => {
    db.providerAccount.findFirst.mockResolvedValue({ id: "account-1", userId: "user-1" });
    db.providerCredential.findMany.mockResolvedValue([
      {
        id: "cred-1",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        credentialType: "BEARER",
        keyVersion: "v1",
        displaySuffix: "…abcd",
        status: "ACTIVE",
        replacedAt: null,
        lastUsedAt: null,
        revokedAt: null,
        // Hostile extras a future select-widening might add:
        ciphertext: "BASE64CIPHERTEXT",
        nonce: "NONCE",
        authTag: "AUTHTAG",
        secretDigest: "deadbeef",
      },
    ]);
    const authInfo = buildAuthInfo(["mcp:read"]);
    bindRequest(authInfo);
    const { body } = await callTool(authInfo, "provider_credentials_list", {
      providerAccountId: "account-1",
    });
    expect(body.result?.isError).toBeUndefined();
    const rows = body.result?.structuredContent?.result as Record<string, unknown>[];
    expect(rows).toEqual([
      {
        id: "cred-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        credentialType: "BEARER",
        keyVersion: "v1",
        displaySuffix: "…abcd",
        status: "ACTIVE",
        replacedAt: null,
        lastUsedAt: null,
        revokedAt: null,
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("BASE64CIPHERTEXT");
    expect(JSON.stringify(body)).not.toContain("deadbeef");
  });
});

describe("output cap", () => {
  it("oversized tool output is refused with the stable size error", async () => {
    const descriptor: McpToolDescriptor = {
      name: "test_output_cap",
      target: "test://output-cap",
      scope: "read",
      confirmation: null,
      classification: "pure",
      inputSchema: requireDescriptor("model_api_tokens_list").inputSchema,
      invokeCore: async () => ({
        blob: "x".repeat(MCP_TOOL_OUTPUT_MAX_BYTES + 1024),
      }),
    };
    const authInfo = buildAuthInfo(["mcp:read"]);
    bindRequest(authInfo);
    const result = await runManifestTool(descriptor, {
      dispatch: {
        orpcContext: createMcpContext({
          user: USER,
          expiresAt: new Date("2026-01-01T00:00:00Z"),
          now: new Date("2025-06-01T00:00:00Z"),
          services: undefined,
        }),
        requestId: "req-42",
      },
      scopes: ["mcp:read"],
      client: undefined,
      args: {},
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("exceeded the maximum size");
  });
});

describe("registerMcpTools — direct registration", () => {
  it("registers every manifest tool on a bare server (catalog parity)", async () => {
    const { McpServer } = await import("@modelcontextprotocol/server");
    const server = new McpServer({ name: "direct", version: "1" });
    expect(() => registerMcpTools(server)).not.toThrow();
    const handler = createMcpTransport();
    const response = await handler.fetch(toolsListRequest(3), undefined);
    const body = (await response.json()) as { result?: { tools?: unknown[] } };
    expect(body.result?.tools).toHaveLength(catalogNames(false).length);
  });
});

describe("full chain — createMcpRequestHandler onVerified binding → tools/call → procedure", () => {
  it("a verified, admitted request binds the dispatch and its tool call reaches the procedure as the verified user", async () => {
    const { Hono } = await import("hono");
    const { createMcpRequestHandler } = await import("./auth");
    // Admission fixtures: an active grant and the live user row. The claims
    // are what the real verifier would have produced for the token (full
    // admission shape: sub, client, scopes, exp, grant id, iss, aud).
    verifierState.claims = {
      sub: USER.id,
      client_id: "client-a",
      scope: "mcp:read offline_access",
      exp: 1_900_000_000,
      mcp_grant_id: "grant-1",
      iss: "https://proxy.example.com/api/auth",
      aud: "https://proxy.example.com/mcp",
    };
    db.mcpGrant.findUnique.mockResolvedValue({
      id: "grant-1",
      userId: USER.id,
      clientId: "client-a",
      revokedAt: null,
    });
    db.user.findUnique.mockResolvedValue(USER);
    db.modelApiToken.findMany.mockResolvedValue([]);

    const seenRequestIds: string[] = [];
    const handler = createMcpRequestHandler({
      authInstance: { $context: {} } as never,
      transport: createMcpTransport(),
      prisma: prisma as never,
      isForceTwoFactorRequired: async () => false,
      consumeIdentityQuota: async () => ({ ok: true }),
      // The PRODUCTION wiring (app.ts): bind the verified AuthInfo to the
      // per-request oRPC context and request id.
      onVerified: ({ authInfo, orpcContext, requestId, signal, credential }) => {
        seenRequestIds.push(requestId);
        bindMcpToolDispatch(authInfo, { orpcContext, requestId, signal, credential });
      },
    });

    const app = new Hono<{ Variables: { requestId: string } }>();
    app.use("*", async (c, next) => {
      c.set("requestId", "chain-req-1");
      await next();
    });
    app.all("/mcp", (c) => handler(c));

    // Raw Request with an EXPLICIT Host header (undici strips Host from
    // constructed requests; the canonical-authority validation requires it).
    const chainHeaders = new Headers({
      "content-type": "application/json",
      authorization: "Bearer verified-access-token",
      "mcp-method": "tools/call",
      "mcp-name": "model_api_tokens_list",
    });
    chainHeaders.set("host", "proxy.example.com");
    const chainRequest = new Request("https://proxy.example.com/mcp", {
      method: "POST",
      headers: chainHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 900,
        method: "tools/call",
        params: { name: "model_api_tokens_list", arguments: {}, _meta: ENVELOPE },
      }),
    });
    const response = await app.request(chainRequest);
    expect(response.status).toBe(200);
    expect(seenRequestIds).toEqual(["chain-req-1"]);
    // The tool call reached the procedure for the VERIFIED user.
    expect(db.modelApiToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: USER.id }),
      }),
    );
    const body = (await response.json()) as WireResult;
    expect(body.isError).toBeUndefined();
  });
});

describe("G1 — cancellation through dispatch (owned admission signal)", () => {
  function dispatchWithSignal(signal?: AbortSignal) {
    return {
      orpcContext: createMcpContext({
        user: USER,
        expiresAt: new Date("2026-01-01T00:00:00Z"),
        now: new Date("2025-06-01T00:00:00Z"),
        services: undefined,
      }),
      requestId: "req-g1",
      ...(signal !== undefined ? { signal } : {}),
    };
  }

  it("a never-settling core settles as cancelled when the signal aborts (race), and post-await stages never start", async () => {
    const descriptor: McpToolDescriptor = {
      name: "test_abort_race",
      target: "test://abort-race",
      scope: "read",
      confirmation: null,
      classification: "pure",
      inputSchema: requireDescriptor("model_api_tokens_list").inputSchema,
      invokeCore: () => new Promise<unknown>(() => {}),
    };
    const controller = new AbortController();
    const resultPromise = runManifestTool(descriptor, {
      dispatch: dispatchWithSignal(controller.signal),
      scopes: ["mcp:read"],
      client: undefined,
      args: {},
    });
    controller.abort();
    const result = await resultPromise;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "REQUEST_ABORTED" } });
  });

  it("an ALREADY-aborted signal never invokes the core at all", async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const descriptor: McpToolDescriptor = {
      name: "test_abort_entry",
      target: "test://abort-entry",
      scope: "read",
      confirmation: null,
      classification: "pure",
      inputSchema: requireDescriptor("model_api_tokens_list").inputSchema,
      invokeCore: invoke,
    };
    const controller = new AbortController();
    controller.abort();
    const result = await runManifestTool(descriptor, {
      dispatch: dispatchWithSignal(controller.signal),
      scopes: ["mcp:read"],
      client: undefined,
      args: {},
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ error: { code: "REQUEST_ABORTED" } });
  });

  it("a completing core's OUTPUT pipeline is fenced on abort (projection never runs post-abort)", async () => {
    const projector = vi.fn((output: unknown) => output);
    const descriptor: McpToolDescriptor = {
      name: "test_abort_postawait",
      target: "test://abort-postawait",
      scope: "read",
      confirmation: null,
      classification: "pure",
      inputSchema: requireDescriptor("model_api_tokens_list").inputSchema,
      outputProjector: projector,
      invokeCore: async () => ({ value: 1 }),
    };
    const controller = new AbortController();
    const result = await runManifestTool(descriptor, {
      dispatch: dispatchWithSignal(controller.signal),
      scopes: ["mcp:read"],
      client: undefined,
      args: {},
    });
    // Not aborted yet: the pipeline ran normally.
    expect(result.isError).toBeUndefined();
    expect(projector).toHaveBeenCalledTimes(1);
    // Now abort BEFORE a second call's pipeline: simulate by resolving the
    // core then aborting synchronously — covered by the entry fence above;
    // here pin the fence between invoke and project with a late-abort race.
    const controller2 = new AbortController();
    const slowDescriptor: McpToolDescriptor = {
      ...descriptor,
      name: "test_abort_postawait_slow",
      invokeCore: () =>
        new Promise<unknown>((resolve) => {
          controller2.signal.addEventListener("abort", () => resolve({ value: 2 }), {
            once: true,
          });
        }),
    };
    const pending = runManifestTool(slowDescriptor, {
      dispatch: dispatchWithSignal(controller2.signal),
      scopes: ["mcp:read"],
      client: undefined,
      args: {},
    });
    controller2.abort();
    const settled = await pending;
    expect(settled.structuredContent).toMatchObject({ error: { code: "REQUEST_ABORTED" } });
    expect(projector).toHaveBeenCalledTimes(1);
  });
});

describe("G3 — JSON→Date input adaptation", () => {
  it("relay_requests_list accepts ISO timestamps through the REAL transport (procedure schema satisfied)", async () => {
    db.relayRequest.findMany = db.relayRequest.findMany ?? vi.fn();
    const findMany = db.relayRequest.findMany as MockInstance;
    findMany.mockResolvedValue([]);
    const authInfo = buildAuthInfo(["mcp:read"]);
    bindRequest(authInfo);
    const { status, body } = await callTool(authInfo, "relay_requests_list", {
      createdAfter: "2026-01-01T00:00:00.000Z",
      createdBefore: "2026-02-01T00:00:00Z",
    });
    expect(status).toBe(200);
    expect(body.result?.isError).toBeUndefined();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: {
            gte: new Date("2026-01-01T00:00:00.000Z"),
            lt: new Date("2026-02-01T00:00:00Z"),
          },
        }),
      }),
    );
  });

  it("invalid timestamps get a clean field-naming error and NO procedure call", async () => {
    db.relayRequest.findMany = db.relayRequest.findMany ?? vi.fn();
    const findMany = db.relayRequest.findMany as MockInstance;
    findMany.mockResolvedValue([]);
    const authInfo = buildAuthInfo(["mcp:read"]);
    bindRequest(authInfo);
    const { body } = await callTool(authInfo, "relay_requests_list", {
      createdAfter: "not-a-timestamp",
    });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain('"createdAfter"');
    expect(body.result?.structuredContent).toMatchObject({
      error: { code: "invalid_input", fields: ["createdAfter"] },
    });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("a date-only staleBefore adapts on the gated metadata-remove tools too", async () => {
    const authInfo = buildAuthInfo(["mcp:write"]);
    bindRequest(authInfo);
    const { body } = await callTool(authInfo, "forwarder_cli_metadata_remove", {
      id: "cli-1",
      staleBefore: "2025-12-31T00:00:00Z",
      confirm: "DELETE",
    });
    // The procedure ran (some downstream outcome), NOT an invalid_input
    // adapter error — the Date conversion satisfied z.date().
    expect(body.result?.structuredContent).not.toMatchObject({
      error: { code: "invalid_input" },
    });
  });
});

describe("CLI presence through the MCP projection", () => {
  it("forwarder_cli_devices_list shows a disconnected CLI's endpoints as OFFLINE", async () => {
    const heartbeat = new Date(Date.now() - 1_000);
    db.cliDevice.findMany = db.cliDevice.findMany ?? vi.fn();
    db.cliDevice.findMany.mockResolvedValue(
      (["CONNECTED", "DISCONNECTED"] as const).map((status) => ({
        id: `cli-${status}`,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        slug: status.toLowerCase(),
        name: null,
        reportedHostname: "host",
        status,
        lastHeartbeatAt: heartbeat,
        User: { slug: "owner" },
        Endpoints: [
          {
            id: `ep-${status}`,
            createdAt: new Date("2026-01-01T00:00:00Z"),
            updatedAt: new Date("2026-01-01T00:00:00Z"),
            slug: "ep",
            label: "ep",
            kind: "OPENAI_COMPATIBLE",
            status: "ONLINE",
            defaultCapabilities: [],
            capabilityMetadata: null,
            probeSuggestions: null,
            lastSeenAt: null,
            lastHealthCheckAt: null,
            statusChangedAt: null,
            failureReasonCode: null,
            published: true,
            unpublishedAt: null,
            DiscoveredModels: [],
          },
        ],
      })),
    );
    const authInfo = buildAuthInfo(["mcp:read"]);
    bindRequest(authInfo);
    const { body } = await callTool(authInfo, "forwarder_cli_devices_list", {});
    const page = body.result?.structuredContent?.result as {
      items: {
        status: string;
        endpoints: { status: string; reportedStatus: string; slug: string }[];
      }[];
      nextCursor: string | null;
    };
    expect(page.items.map((row) => [row.status, row.endpoints[0]?.status])).toEqual([
      ["CONNECTED", "ONLINE"],
      ["DISCONNECTED", "OFFLINE"],
    ]);
    expect(page.items[1]?.endpoints[0]?.reportedStatus).toBe("ONLINE");
    expect(page.items[0]?.endpoints[0]?.slug).toBe("ep");
    expect(page.nextCursor).toBeNull();
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain("models");
    expect(serialized).not.toContain("defaultCapabilities");
    expect(serialized).not.toContain("capabilityMetadata");
  });
});

describe("G4 — the sanitizing boundary covers the ENTIRE pipeline", () => {
  function dispatchFor(output: () => unknown, projector?: (output: unknown) => unknown) {
    return {
      descriptor: {
        name: "test_boundary",
        target: "test://boundary",
        scope: "read",
        confirmation: null,
        classification: "pure",
        inputSchema: requireDescriptor("model_api_tokens_list").inputSchema,
        ...(projector !== undefined ? { outputProjector: projector } : {}),
        invokeCore: async () => output(),
      } as McpToolDescriptor,
      dispatch: {
        orpcContext: createMcpContext({
          user: USER,
          expiresAt: new Date("2026-01-01T00:00:00Z"),
          now: new Date("2025-06-01T00:00:00Z"),
          services: undefined,
        }),
        requestId: "req-g4",
      },
    };
  }

  it("a throwing PROJECTOR becomes the generic correlated error — the sentinel never reaches output", async () => {
    const { descriptor, dispatch } = dispatchFor(
      () => ({ row: { secret: "redaction-projection-test-placeholder" } }),
      () => {
        throw new Error("R63_PROJECTION_SENTINEL");
      },
    );
    const result = await runManifestTool(descriptor, {
      dispatch,
      scopes: ["mcp:read"],
      client: undefined,
      args: {},
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toBe("Internal error");
    expect(result.structuredContent).toMatchObject({
      error: { code: "INTERNAL_ERROR" },
      requestId: "req-g4",
    });
    expect(JSON.stringify(result)).not.toContain("R63_PROJECTION_SENTINEL");
  });

  it("a throwing Date CONVERSION (toISOString sabotage) becomes the generic correlated error", async () => {
    const poisoned = new Date("2026-01-01T00:00:00Z");
    poisoned.toISOString = () => {
      throw new Error("SECRET_OUTPUT_CONVERSION");
    };
    const descriptor = {
      name: "test_bad_date",
      target: "test://bad-date",
      scope: "read",
      confirmation: null,
      classification: "pure",
      inputSchema: requireDescriptor("model_api_tokens_list").inputSchema,
      invokeCore: async () => ({ when: poisoned }),
    } as McpToolDescriptor;
    const dispatch = {
      orpcContext: createMcpContext({
        user: USER,
        expiresAt: new Date("2026-01-01T00:00:00Z"),
        now: new Date("2025-06-01T00:00:00Z"),
        services: undefined,
      }),
      requestId: "req-g4b",
    };
    const result = await runManifestTool(descriptor, {
      dispatch,
      scopes: ["mcp:read"],
      client: undefined,
      args: {},
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "INTERNAL_ERROR" },
      requestId: "req-g4b",
    });
    expect(JSON.stringify(result)).not.toContain("SECRET_OUTPUT_CONVERSION");
  });
});

describe("G5 — the cap bounds the FINAL serialized result", () => {
  function payloadTool(blobChars: number): McpToolDescriptor {
    return {
      name: "test_final_cap",
      target: "test://final-cap",
      scope: "read",
      confirmation: null,
      classification: "pure",
      inputSchema: requireDescriptor("model_api_tokens_list").inputSchema,
      invokeCore: async () => ({ blob: "x".repeat(blobChars) }),
    };
  }

  it("a just-UNDER payload succeeds and its serialized result stays within the cap", async () => {
    // Just under the EMITTED budget (cap minus SDK headroom): the result
    // embeds the payload twice (text + structuredContent).
    const under = Math.floor(
      (MCP_TOOL_OUTPUT_MAX_BYTES - MCP_TOOL_OUTPUT_SDK_HEADROOM_BYTES - 256) / 2,
    );
    const result = await runManifestTool(payloadTool(under), {
      dispatch: {
        orpcContext: createMcpContext({
          user: USER,
          expiresAt: new Date("2026-01-01T00:00:00Z"),
          now: new Date("2025-06-01T00:00:00Z"),
          services: undefined,
        }),
        requestId: "req-g5",
      },
      scopes: ["mcp:read"],
      client: undefined,
      args: {},
    });
    expect(result.isError).toBeUndefined();
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(
      MCP_TOOL_OUTPUT_MAX_BYTES,
    );
  });

  it("a just-OVER payload is refused with the small OUTPUT_TOO_LARGE result (no duplication blow-up)", async () => {
    const over =
      Math.floor((MCP_TOOL_OUTPUT_MAX_BYTES - MCP_TOOL_OUTPUT_SDK_HEADROOM_BYTES - 256) / 2) + 2048;
    const result = await runManifestTool(payloadTool(over), {
      dispatch: {
        orpcContext: createMcpContext({
          user: USER,
          expiresAt: new Date("2026-01-01T00:00:00Z"),
          now: new Date("2025-06-01T00:00:00Z"),
          services: undefined,
        }),
        requestId: "req-g5",
      },
      scopes: ["mcp:read"],
      client: undefined,
      args: {},
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "OUTPUT_TOO_LARGE", maxBytes: MCP_TOOL_OUTPUT_MAX_BYTES },
    });
    // The refusal itself is tiny.
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(512);
  });
});

describe("G6 — prototype-safe error-code allowlist", () => {
  const hostileCodes = ["toString", "constructor", "hasOwnProperty"] as const;

  for (const code of hostileCodes) {
    it(`new ORPCError("${code}") collapses to the generic internal error`, async () => {
      const { ORPCError } = await import("@orpc/server");
      db.modelApiToken.findUnique.mockRejectedValue(
        new ORPCError(code, { message: "PROTOTYPE_SENTINEL" }),
      );
      const authInfo = buildAuthInfo(["mcp:write"]);
      bindRequest(authInfo);
      const { body } = await callTool(authInfo, "model_api_token_revoke", {
        id: "token-1",
        confirm: "DELETE",
      });
      expect(body.result?.content?.[0]?.text).toBe("Internal error");
      expect(body.result?.structuredContent).toMatchObject({
        error: { code: "INTERNAL_ERROR" },
      });
      expect(JSON.stringify(body)).not.toContain("PROTOTYPE_SENTINEL");
      expect(JSON.stringify(body)).not.toContain(`"code":"${code}"`);
    });
  }
});

describe("G2 — diagnostic failure data never crosses the MCP boundary", () => {
  it("a core's stable probe-error reason never carries the underlying exception message", async () => {
    const descriptor: McpToolDescriptor = {
      name: "test_probe_error",
      target: "test://probe-error",
      scope: "read",
      confirmation: null,
      classification: "pure",
      inputSchema: requireDescriptor("model_api_tokens_list").inputSchema,
      invokeCore: async () => ({
        outcome: "probe-error",
        latencyMs: 5,
        reason: "Member test failed.",
      }),
    };
    const result = await runManifestTool(descriptor, {
      dispatch: {
        orpcContext: createMcpContext({
          user: USER,
          expiresAt: new Date("2026-01-01T00:00:00Z"),
          now: new Date("2025-06-01T00:00:00Z"),
          services: undefined,
        }),
        requestId: "req-g2",
      },
      scopes: ["mcp:read"],
      client: undefined,
      args: {},
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).toContain("Member test failed.");
  });
});

describe("G8b — the composed pipeline redacts class-instance secrets", () => {
  it("a class instance with a secret field serializes REDACTED (redactor/serializer alignment)", async () => {
    class HostileRow {
      id = "row-1";
      secret = "CLASS_INSTANCE_SECRET_SENTINEL";
      label = "visible";
    }
    const descriptor: McpToolDescriptor = {
      name: "test_class_redaction",
      target: "test://class-redaction",
      scope: "read",
      confirmation: null,
      classification: "pure",
      inputSchema: requireDescriptor("model_api_tokens_list").inputSchema,
      invokeCore: async () => ({ rows: [new HostileRow()] }),
    };
    const result = await runManifestTool(descriptor, {
      dispatch: {
        orpcContext: createMcpContext({
          user: USER,
          expiresAt: new Date("2026-01-01T00:00:00Z"),
          now: new Date("2025-06-01T00:00:00Z"),
          services: undefined,
        }),
        requestId: "req-g8b",
      },
      scopes: ["mcp:read"],
      client: undefined,
      args: {},
    });
    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as { result?: { rows?: unknown[] } };
    expect(structured.result?.rows).toEqual([
      { id: "row-1", secret: "[redacted]", label: "visible" },
    ]);
    expect(JSON.stringify(result)).not.toContain("CLASS_INSTANCE_SECRET_SENTINEL");
  });
});

function requireDescriptor(name: string): McpToolDescriptor {
  const descriptor = MCP_TOOL_MANIFEST.find((tool) => tool.name === name);
  if (descriptor === undefined) throw new Error(`missing descriptor ${name}`);
  return descriptor;
}

const PAT_EXPIRES = new Date("2026-12-01T00:00:00.000Z");
const PAT_WITH_CLI = {
  kind: "pat" as const,
  tokenId: "token-pat-1",
  allowCliCommands: true,
  allowCliFileRead: false,
  scopes: ["mcp:read", "mcp:write"],
  expiresAt: PAT_EXPIRES,
};
const PAT_WITHOUT_CLI = { ...PAT_WITH_CLI, allowCliCommands: false };
const OAUTH_CREDENTIAL = { kind: "oauth" as const };

type ListedCredential =
  | {
      kind: "pat";
      tokenId: string;
      allowCliCommands: boolean;
      allowCliFileRead: boolean;
      scopes: readonly string[];
      expiresAt: Date | null;
    }
  | { kind: "oauth" };

function cliDispatch(credential: ListedCredential, signal?: AbortSignal) {
  return {
    orpcContext: createMcpContext({
      user: USER,
      expiresAt: new Date("2026-01-01T00:00:00Z"),
      now: new Date("2025-06-01T00:00:00Z"),
      services: undefined,
    }),
    requestId: "req-cli",
    credential,
    ...(signal !== undefined ? { signal } : {}),
  };
}

function streamBytes(text: string, totalBytes = text.length) {
  const head = new TextEncoder().encode(text);
  return { head, tail: new Uint8Array(), totalBytes };
}

function runningSnapshot(commandId = "cmd-1") {
  return {
    commandId,
    status: "running",
    exitCode: null,
    signal: null,
    timedOut: false,
    stdout: streamBytes("so-far"),
    stderr: streamBytes(""),
  };
}

function exitedSnapshot(commandId = "cmd-1") {
  return {
    commandId,
    status: "exited",
    exitCode: 0,
    signal: "SIGTERM",
    timedOut: false,
    stdout: streamBytes("done"),
    stderr: streamBytes("err"),
  };
}

function parsedTool(result: {
  content?: { type: string; text?: unknown }[];
}): Record<string, unknown> {
  return JSON.parse(resultText(result)) as Record<string, unknown>;
}

describe("CLI command tools", () => {
  beforeEach(() => {
    cliRuntime.startCliCommand.mockReset();
    cliRuntime.waitCliCommand.mockReset();
    cliRuntime.snapshotCliCommand.mockReset();
    cliRuntime.startSupervisedCommand.mockReset();
    cliRuntime.snapshotSupervisedCommand.mockReset();
    cliRuntime.snapshotSupervisedCommand.mockReturnValue(null);
  });

  async function listedNames(
    credential: ListedCredential | undefined,
    scopes: string[],
  ): Promise<string[]> {
    const authInfo = buildAuthInfo(scopes);
    if (credential !== undefined) bindRequest(authInfo, "req-list", credential);
    const handler = createMcpTransport();
    const response = await handler.fetch(toolsListRequest(7), { authInfo });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result?: { tools?: { name: string }[] } };
    return body.result?.tools?.map((tool) => tool.name).sort() ?? [];
  }

  it("hides the CLI tools for OAuth write and a PAT without the flag, and lists them for a flagged PAT", async () => {
    await expect(listedNames(OAUTH_CREDENTIAL, ["mcp:write"])).resolves.toEqual(
      catalogNames(false),
    );
    await expect(listedNames(PAT_WITHOUT_CLI, ["mcp:write"])).resolves.toEqual(catalogNames(false));
    const flagged = await listedNames(PAT_WITH_CLI, ["mcp:write"]);
    expect(flagged).toEqual(catalogNames(true));
    expect(flagged).toContain("forwarder_cli_command_run");
    expect(flagged).toContain("forwarder_cli_supervised_command_start");
    expect(flagged).toContain("forwarder_cli_command_result");
    expect(flagged).toContain("forwarder_cli_activity_list");
    expect(flagged).toContain("forwarder_device_metric_sources_set");
    expect(flagged).toContain("forwarder_device_engine_adapters_set");
    expect(flagged).toContain("forwarder_device_engine_adapters_clear");
    for (const hidden of [
      await listedNames(OAUTH_CREDENTIAL, ["mcp:write"]),
      await listedNames(PAT_WITHOUT_CLI, ["mcp:write"]),
    ]) {
      expect(hidden).not.toContain("forwarder_device_metric_sources_set");
      expect(hidden).not.toContain("forwarder_device_engine_adapters_set");
      expect(hidden).not.toContain("forwarder_device_engine_adapters_clear");
    }
  });

  it("the read-only activity tool follows the same PAT-only rule under mcp:read", async () => {
    for (const credential of [OAUTH_CREDENTIAL, PAT_WITHOUT_CLI]) {
      await expect(listedNames(credential, ["mcp:read"])).resolves.not.toContain(
        "forwarder_cli_activity_list",
      );
    }
    await expect(listedNames(PAT_WITH_CLI, ["mcp:read"])).resolves.toContain(
      "forwarder_cli_activity_list",
    );
  });

  it("documents supervised and headless file audit reason shapes in the activity tool", () => {
    const tool = requireDescriptor("forwarder_cli_activity_list");
    expect(tool.descriptionNote).toContain("<op>:<code>");
    expect(tool.descriptionNote).toContain("write:completed");
    expect(tool.descriptionNote).toContain("edit:conflict");
    expect(tool.descriptionNote).toContain("headless file reasons use <code>");
  });

  it("the activity tool call fails closed as not-found for OAuth and a PAT without the flag", async () => {
    const tool = requireDescriptor("forwarder_cli_activity_list");
    for (const credential of [OAUTH_CREDENTIAL, PAT_WITHOUT_CLI]) {
      const result = await runManifestTool(tool, {
        dispatch: cliDispatch(credential),
        scopes: ["mcp:read"],
        client: undefined,
        args: {},
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toBe("Tool forwarder_cli_activity_list not found");
    }
  });

  it("discloses the masked output classes and the unsupervised limitation", async () => {
    const authInfo = buildAuthInfo(["mcp:write"]);
    bindRequest(authInfo, "req-list", PAT_WITH_CLI);
    const handler = createMcpTransport();
    const response = await handler.fetch(toolsListRequest(8), { authInfo });
    const body = (await response.json()) as {
      result?: { tools?: { name: string; description?: string }[] };
    };
    const run = body.result?.tools?.find((tool) => tool.name === "forwarder_cli_command_run");
    const resultTool = body.result?.tools?.find(
      (tool) => tool.name === "forwarder_cli_command_result",
    );
    const supervised = body.result?.tools?.find(
      (tool) => tool.name === "forwarder_cli_supervised_command_start",
    );
    for (const tool of [run, resultTool, supervised]) {
      for (const phrase of [
        "private key blocks",
        "secret-name tokens",
        "scans the terminal-cleaned view",
        "retain private-key labels across piece boundaries",
        "recovery unconditionally masks non-blank output until the next blank line",
        "Normal scanning resumes after the blank unless these protections extend masking",
        "unmasked lines keep their raw bytes",
        "Terminal parser state carries across lines",
        "The server cleanText still runs afterwards",
        "following non-blank line",
        "continuation",
        "--api-key/--hf-token",
        ".cache/huggingface/token",
        "dotenv view",
        "NOT masked",
        "not a security boundary",
        "A line over 64 KiB is masked whole",
        "inside a live multi-line secret run",
        "the next non-blank line and subsequent lines indented deeper than column 0 are also protected",
        "Opaque fallbacks stay closed through EOF",
        "a PEM marker exceeding the 1 KiB recovery overlap",
        "more than 1 MiB of live masking-state input",
        "an over-long line inside such a run",
        "a cleaned LF inside an overlong terminal group",
        "including LF executed inside unfinished CSI",
      ]) {
        expect(tool?.description).toContain(phrase);
      }
      expect(tool?.description).not.toContain("A line over 64 KiB or more than 1 MiB");
    }
    expect(
      (run as { annotations?: { destructiveHint?: boolean } } | undefined)?.annotations
        ?.destructiveHint,
    ).toBe(true);
    expect(run?.description).toContain('confirm: "RUN"');
    expect(resultTool?.description).not.toContain('confirm: "RUN"');
  });

  it("fails closed at call time for OAuth and a PAT without the flag, even if the descriptor is invoked", async () => {
    const run = requireDescriptor("forwarder_cli_command_run");
    for (const credential of [OAUTH_CREDENTIAL, PAT_WITHOUT_CLI]) {
      const result = await runManifestTool(run, {
        dispatch: cliDispatch(credential),
        scopes: ["mcp:write"],
        client: undefined,
        args: { cliDeviceId: "cli-1", command: "pwd", confirm: "RUN" },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toBe("Tool forwarder_cli_command_run not found");
      expect(resultText(result).toLowerCase()).not.toContain("disabled");
      expect(cliRuntime.startCliCommand).not.toHaveBeenCalled();
    }
  });

  it("defining a device's metric sources needs the command credential, like the CLI command tools", async () => {
    const setSources = requireDescriptor("forwarder_device_metric_sources_set");
    const client = { forwarderManagement: { setCliDeviceMetricSources: vi.fn() } };
    for (const credential of [OAUTH_CREDENTIAL, PAT_WITHOUT_CLI]) {
      const result = await runManifestTool(setSources, {
        dispatch: cliDispatch(credential),
        scopes: ["mcp:write"],
        client: client as never,
        args: { cliDeviceId: "cli-1", sources: [], confirm: "RUN" },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toBe("Tool forwarder_device_metric_sources_set not found");
    }
    expect(client.forwarderManagement.setCliDeviceMetricSources).not.toHaveBeenCalled();
  });

  it("defining a device's engine adapters needs the command credential", async () => {
    const setAdapters = requireDescriptor("forwarder_device_engine_adapters_set");
    const client = { forwarderManagement: { setCliDeviceEngineAdapters: vi.fn() } };
    for (const credential of [OAUTH_CREDENTIAL, PAT_WITHOUT_CLI]) {
      const result = await runManifestTool(setAdapters, {
        dispatch: cliDispatch(credential),
        scopes: ["mcp:write"],
        client: client as never,
        args: { cliDeviceId: "cli-1", adapters: [], confirm: "RUN" },
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toBe("Tool forwarder_device_engine_adapters_set not found");
    }
    expect(client.forwarderManagement.setCliDeviceEngineAdapters).not.toHaveBeenCalled();
  });

  it("an unregistered call on the transport is the SDK not-found error", async () => {
    const authInfo = buildAuthInfo(["mcp:write"]);
    bindRequest(authInfo, "req-cli", OAUTH_CREDENTIAL);
    const { body } = await callTool(authInfo, "forwarder_cli_command_run", {
      cliDeviceId: "cli-1",
      command: "pwd",
      confirm: "RUN",
    });
    expect(JSON.stringify(body)).toContain("Tool forwarder_cli_command_run not found");
    expect(JSON.stringify(body).toLowerCase()).not.toContain("disabled");
    expect(cliRuntime.startCliCommand).not.toHaveBeenCalled();
  });

  it("requires RUN for the run tool and no confirmation for the result tool", async () => {
    const run = requireDescriptor("forwarder_cli_command_run");
    const missing = await runManifestTool(run, {
      dispatch: cliDispatch(PAT_WITH_CLI),
      scopes: ["mcp:write"],
      client: undefined,
      args: { cliDeviceId: "cli-1", command: "pwd" },
    });
    expect(missing.isError).toBe(true);
    expect(resultText(missing)).toContain('confirm="RUN"');
    expect(cliRuntime.startCliCommand).not.toHaveBeenCalled();

    cliRuntime.snapshotCliCommand.mockResolvedValue(exitedSnapshot());
    const resultTool = requireDescriptor("forwarder_cli_command_result");
    const fetched = await runManifestTool(resultTool, {
      dispatch: cliDispatch(PAT_WITH_CLI),
      scopes: ["mcp:write"],
      client: undefined,
      args: { commandId: "cmd-1" },
    });
    expect(fetched.isError).toBeUndefined();
    expect(parsedTool(fetched).commandId).toBe("cmd-1");
    expect(cliRuntime.snapshotCliCommand).toHaveBeenCalledWith("cmd-1", USER.id, "token-pat-1");
  });

  it("still requires mcp:write when the PAT flag is set", async () => {
    const run = requireDescriptor("forwarder_cli_command_run");
    const result = await runManifestTool(run, {
      dispatch: cliDispatch(PAT_WITH_CLI),
      scopes: ["mcp:read"],
      client: undefined,
      args: { cliDeviceId: "cli-1", command: "pwd", confirm: "RUN" },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("mcp:write");
    expect(cliRuntime.startCliCommand).not.toHaveBeenCalled();
  });

  it.each([
    ["not_found", "Not found"],
    [
      "grant_disabled",
      "CLI commands are disabled for this device (switch 2 of 3: its MCP commands grant on the dashboard CLIs page is Off; a person must set it to Supervised or Unsupervised)",
    ],
    [
      "offline",
      "CLI is offline or does not support this protocol (the device must be connected and running a wsmp version that supports MCP commands)",
    ],
    [
      "feature_disabled",
      "CLI has MCP commands disabled in wsmp config (switch 3 of 3: on that machine run `wsmp config set-mcp-commands supervised` or `unsupervised`, then restart wsmp; the dashboard grant already allows commands)",
    ],
    ["limit", "too many commands"],
    [
      "invalid_command",
      "command and cwd must be well-formed Unicode text (no unpaired surrogates), 1..=4096 UTF-8 bytes, and contain no NUL",
    ],
    [
      "token_inactive",
      "This MCP token was revoked, has expired, or no longer allows CLI commands, or the account no longer allows CLI effects (switch 1 of 3: mcp:write and CLI commands are required; edit the token in Settings > MCP, or check the account)",
    ],
  ] as const)("maps start error %s to a stable message", async (code, message) => {
    cliRuntime.startCliCommand.mockResolvedValue({ ok: false, error: code });
    const run = requireDescriptor("forwarder_cli_command_run");
    const result = await runManifestTool(run, {
      dispatch: cliDispatch(PAT_WITH_CLI),
      scopes: ["mcp:write"],
      client: undefined,
      args: { cliDeviceId: "cli-1", command: "UNIQUE_COMMAND_DO_NOT_LOG", confirm: "RUN" },
    });
    expect(resultText(result)).toBe(message);
    if (code === "not_found") {
      expect(resultText(result).toLowerCase()).not.toContain("disabled");
      expect(resultText(result).toLowerCase()).not.toContain("offline");
    }
    expect(cliRuntime.waitCliCommand).not.toHaveBeenCalled();
    const logged = consoleError.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).not.toContain("UNIQUE_COMMAND_DO_NOT_LOG");
  });

  it.each([
    [undefined, 15_000],
    [0, 0],
    [-4, 0],
    [15_000, 15_000],
    [15_001, 15_000],
    [1_000_000, 15_000],
  ] as const)("clamps waitMs %s to %s", async (waitMs, expected) => {
    cliRuntime.startCliCommand.mockResolvedValue({ ok: true, commandId: "cmd-1" });
    cliRuntime.waitCliCommand.mockResolvedValue(runningSnapshot());
    const run = requireDescriptor("forwarder_cli_command_run");
    await runManifestTool(run, {
      dispatch: cliDispatch(PAT_WITH_CLI),
      scopes: ["mcp:write"],
      client: undefined,
      args: {
        cliDeviceId: "cli-1",
        command: "pwd",
        confirm: "RUN",
        ...(waitMs !== undefined ? { waitMs } : {}),
      },
    });
    expect(cliRuntime.waitCliCommand).toHaveBeenCalledWith(
      "cmd-1",
      USER.id,
      "token-pat-1",
      expected,
      undefined,
    );
  });

  it("returns running output without an exit code, and the final record once the command has exited", async () => {
    vi.useFakeTimers();
    try {
      cliRuntime.startCliCommand.mockResolvedValue({ ok: true, commandId: "cmd-1" });
      cliRuntime.waitCliCommand.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve(runningSnapshot()), 15_000);
          }),
      );
      const run = requireDescriptor("forwarder_cli_command_run");
      const pending = runManifestTool(run, {
        dispatch: cliDispatch(PAT_WITH_CLI),
        scopes: ["mcp:write"],
        client: undefined,
        args: { cliDeviceId: "cli-1", command: "pwd", confirm: "RUN" },
      });
      await vi.advanceTimersByTimeAsync(15_000);
      const running = parsedTool(await pending);
      expect(running.commandId).toBe("cmd-1");
      expect(running.status).toBe("running");
      expect(running).not.toHaveProperty("exitCode");
      expect(running.stdout).toMatchObject({ text: "so-far", truncated: false });

      cliRuntime.waitCliCommand.mockResolvedValue(exitedSnapshot());
      const finished = parsedTool(
        await runManifestTool(run, {
          dispatch: cliDispatch(PAT_WITH_CLI),
          scopes: ["mcp:write"],
          client: undefined,
          args: { cliDeviceId: "cli-1", command: "pwd", confirm: "RUN" },
        }),
      );
      expect(finished).toMatchObject({
        commandId: "cmd-1",
        status: "exited",
        exitCode: 0,
        processSignal: "SIGTERM",
        timedOut: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("an already-aborted signal ends the wait and still returns commandId", async () => {
    const controller = new AbortController();
    controller.abort();
    cliRuntime.startCliCommand.mockResolvedValue({ ok: true, commandId: "cmd-abort" });
    cliRuntime.waitCliCommand.mockResolvedValue(runningSnapshot("cmd-abort"));
    const run = requireDescriptor("forwarder_cli_command_run");
    const result = await runManifestTool(run, {
      dispatch: cliDispatch(PAT_WITH_CLI, controller.signal),
      scopes: ["mcp:write"],
      client: undefined,
      args: { cliDeviceId: "cli-1", command: "pwd", confirm: "RUN" },
    });
    expect(result.isError).toBeUndefined();
    expect(parsedTool(result).commandId).toBe("cmd-abort");
    expect(parsedTool(result).status).toBe("running");
    expect(cliRuntime.startCliCommand).toHaveBeenCalledTimes(1);
    expect(cliRuntime.waitCliCommand).toHaveBeenCalledWith(
      "cmd-abort",
      USER.id,
      "token-pat-1",
      15_000,
      controller.signal,
    );
    expect(cliRuntime.snapshotCliCommand).not.toHaveBeenCalled();
  });

  it("passes the token id and expiry into startCliCommand and does not log output", async () => {
    cliRuntime.startCliCommand.mockResolvedValue({ ok: true, commandId: "cmd-1" });
    cliRuntime.waitCliCommand.mockResolvedValue({
      ...exitedSnapshot(),
      stdout: streamBytes("UNIQUE_OUTPUT_DO_NOT_LOG"),
    });
    const run = requireDescriptor("forwarder_cli_command_run");
    const result = await runManifestTool(run, {
      dispatch: cliDispatch(PAT_WITH_CLI),
      scopes: ["mcp:write"],
      client: undefined,
      args: {
        cliDeviceId: "cli-1",
        command: "echo hi",
        cwd: "/tmp",
        confirm: "RUN",
      },
    });
    expect(cliRuntime.startCliCommand).toHaveBeenCalledWith({
      userId: USER.id,
      tokenId: "token-pat-1",
      expiresAt: PAT_EXPIRES,
      cliDeviceId: "cli-1",
      command: "echo hi",
      cwd: "/tmp",
    });
    expect(parsedTool(result).stdout).toMatchObject({ text: "UNIQUE_OUTPUT_DO_NOT_LOG" });
    const logged = consoleError.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).not.toContain("UNIQUE_OUTPUT_DO_NOT_LOG");
    expect(logged).not.toContain("echo hi");
  });

  it("result progress false omits streams while running and returns the final record after exit", async () => {
    const resultTool = requireDescriptor("forwarder_cli_command_result");
    cliRuntime.snapshotCliCommand.mockResolvedValue(runningSnapshot());
    const quiet = parsedTool(
      await runManifestTool(resultTool, {
        dispatch: cliDispatch(PAT_WITH_CLI),
        scopes: ["mcp:write"],
        client: undefined,
        args: { commandId: "cmd-1", progress: false },
      }),
    );
    expect(quiet).toEqual({ commandId: "cmd-1", status: "running" });

    const loud = parsedTool(
      await runManifestTool(resultTool, {
        dispatch: cliDispatch(PAT_WITH_CLI),
        scopes: ["mcp:write"],
        client: undefined,
        args: { commandId: "cmd-1", progress: true },
      }),
    );
    expect(loud.stdout).toMatchObject({ text: "so-far" });
    expect(loud).not.toHaveProperty("exitCode");

    cliRuntime.snapshotCliCommand.mockResolvedValue(exitedSnapshot());
    const finished = parsedTool(
      await runManifestTool(resultTool, {
        dispatch: cliDispatch(PAT_WITH_CLI),
        scopes: ["mcp:write"],
        client: undefined,
        args: { commandId: "cmd-1", progress: false },
      }),
    );
    expect(finished.exitCode).toBe(0);
    expect(finished.stdout).toMatchObject({ text: "done" });
  });

  it("a null snapshot is not found for the caller and for any other user", async () => {
    cliRuntime.snapshotCliCommand.mockResolvedValue(null);
    const resultTool = requireDescriptor("forwarder_cli_command_result");
    const result = await runManifestTool(resultTool, {
      dispatch: cliDispatch(PAT_WITH_CLI),
      scopes: ["mcp:write"],
      client: undefined,
      args: { commandId: "missing" },
    });
    expect(resultText(result)).toBe("Not found");
    expect(resultText(result).toLowerCase()).not.toContain("disabled");
    expect(cliRuntime.snapshotCliCommand).toHaveBeenCalledWith("missing", USER.id, "token-pat-1");
  });

  it("a max-size stream still serializes under the MCP output cap", async () => {
    const { CLI_COMMAND_WRAPPED_OUTPUT_BUDGET } = await import("./cli-command-output");
    expect(CLI_COMMAND_WRAPPED_OUTPUT_BUDGET).toBe(
      MCP_TOOL_OUTPUT_MAX_BYTES - MCP_TOOL_OUTPUT_SDK_HEADROOM_BYTES,
    );
    const head = new Uint8Array(8192).fill(0xff);
    const tail = new Uint8Array(40960).fill(0xff);
    const stream = { head, tail, totalBytes: 5_000_000 };
    cliRuntime.startCliCommand.mockResolvedValue({ ok: true, commandId: "cmd-max" });
    cliRuntime.waitCliCommand.mockResolvedValue({
      commandId: "cmd-max",
      status: "exited",
      exitCode: 1,
      signal: "SIGKILL",
      timedOut: true,
      stdout: stream,
      stderr: stream,
    });
    const run = requireDescriptor("forwarder_cli_command_run");
    const result = await runManifestTool(run, {
      dispatch: cliDispatch(PAT_WITH_CLI),
      scopes: ["mcp:write"],
      client: undefined,
      args: { cliDeviceId: "cli-1", command: "yes", confirm: "RUN" },
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).not.toMatchObject({ error: { code: "OUTPUT_TOO_LARGE" } });
    const bytes = new TextEncoder().encode(JSON.stringify(result)).length;
    expect(bytes).toBeLessThanOrEqual(CLI_COMMAND_WRAPPED_OUTPUT_BUDGET);
  });

  describe("supervised command tool", () => {
    beforeEach(() => {
      cliRuntime.startSupervisedCommand.mockReset();
      cliRuntime.snapshotSupervisedCommand.mockReset();
      cliRuntime.snapshotSupervisedCommand.mockReturnValue(null);
      cliRuntime.snapshotCliCommand.mockReset();
    });

    const startArgs = {
      cliDeviceId: "cli-1",
      command: "sudo apt install build-essential",
      reason: "needs your sudo password",
      shareOutput: true,
      confirm: "RUN",
    };

    it("is destructive, needs RUN, and explains what the agent can learn", async () => {
      const authInfo = buildAuthInfo(["mcp:write"]);
      bindRequest(authInfo, "req-list", PAT_WITH_CLI);
      const handler = createMcpTransport();
      const response = await handler.fetch(toolsListRequest(9), { authInfo });
      const body = (await response.json()) as {
        result?: {
          tools?: {
            name: string;
            description?: string;
            annotations?: { destructiveHint?: boolean };
          }[];
        };
      };
      const tool = body.result?.tools?.find(
        (entry) => entry.name === "forwarder_cli_supervised_command_start",
      );
      expect(tool?.annotations?.destructiveHint).toBe(true);
      expect(tool?.description).toContain('confirm: "RUN"');
      expect(tool?.description).toContain("press Enter");
      expect(tool?.description).toContain("forwarder_cli_command_result");
    });

    it("fails closed for OAuth and a PAT without the flag", async () => {
      const start = requireDescriptor("forwarder_cli_supervised_command_start");
      for (const credential of [OAUTH_CREDENTIAL, PAT_WITHOUT_CLI]) {
        const result = await runManifestTool(start, {
          dispatch: cliDispatch(credential),
          scopes: ["mcp:write"],
          client: undefined,
          args: startArgs,
        });
        expect(result.isError).toBe(true);
        expect(resultText(result)).toBe("Tool forwarder_cli_supervised_command_start not found");
      }
      expect(cliRuntime.startSupervisedCommand).not.toHaveBeenCalled();
    });

    it("requires confirm RUN and the mcp:write scope", async () => {
      const start = requireDescriptor("forwarder_cli_supervised_command_start");
      const { confirm: _confirm, ...withoutConfirm } = startArgs;
      const missing = await runManifestTool(start, {
        dispatch: cliDispatch(PAT_WITH_CLI),
        scopes: ["mcp:write"],
        client: undefined,
        args: withoutConfirm,
      });
      expect(missing.isError).toBe(true);
      expect(resultText(missing)).toContain('confirm="RUN"');
      const readOnly = await runManifestTool(start, {
        dispatch: cliDispatch(PAT_WITH_CLI),
        scopes: ["mcp:read"],
        client: undefined,
        args: startArgs,
      });
      expect(readOnly.isError).toBe(true);
      expect(resultText(readOnly)).toContain("mcp:write");
      expect(cliRuntime.startSupervisedCommand).not.toHaveBeenCalled();
    });

    it("starts with the token id and returns the request id without waiting", async () => {
      cliRuntime.startSupervisedCommand.mockResolvedValue({
        ok: true,
        commandId: "sup-1",
        terminalId: "term-1",
        expiresAt: "2026-01-01T00:15:00.000Z",
      });
      const start = requireDescriptor("forwarder_cli_supervised_command_start");
      const result = await runManifestTool(start, {
        dispatch: cliDispatch(PAT_WITH_CLI),
        scopes: ["mcp:write"],
        client: undefined,
        args: startArgs,
      });
      expect(cliRuntime.startSupervisedCommand).toHaveBeenCalledWith({
        userId: USER.id,
        tokenId: "token-pat-1",
        expiresAt: PAT_EXPIRES,
        cliDeviceId: "cli-1",
        command: startArgs.command,
        reason: startArgs.reason,
        shareOutput: true,
      });
      expect(parsedTool(result)).toMatchObject({
        commandId: "sup-1",
        kind: "supervised",
        status: "awaiting_user",
        shareOutput: true,
      });
      expect(cliRuntime.waitCliCommand).not.toHaveBeenCalled();
    });

    it.each([
      ["supervised_only", "use forwarder_cli_supervised_command_start"],
      ["supervised_only", "whichever is stricter"],
      ["unsupported", "terminal support"],
      ["invalid_reason", "of at most 500 characters (Unicode code points)"],
    ] as const)("maps %s to a stable message", async (code, fragment) => {
      cliRuntime.startSupervisedCommand.mockResolvedValue({ ok: false, error: code });
      const start = requireDescriptor("forwarder_cli_supervised_command_start");
      const result = await runManifestTool(start, {
        dispatch: cliDispatch(PAT_WITH_CLI),
        scopes: ["mcp:write"],
        client: undefined,
        args: startArgs,
      });
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain(fragment);
    });

    it("the result tool reads supervised records with the caller's token and never shows held output", async () => {
      const resultTool = requireDescriptor("forwarder_cli_command_result");
      cliRuntime.snapshotSupervisedCommand.mockReturnValue({
        kind: "supervised",
        commandId: "sup-1",
        userId: USER.id,
        tokenId: "token-pat-1",
        cliDeviceId: "cli-1",
        status: "awaiting_output_review",
        exitCode: 0,
        signal: null,
        rejectionReason: null,
        waitDeadline: Date.parse("2026-01-01T00:15:00.000Z"),
        output: null,
        shared: null,
        reviewedText: null,
      });
      const held = parsedTool(
        await runManifestTool(resultTool, {
          dispatch: cliDispatch(PAT_WITH_CLI),
          scopes: ["mcp:write"],
          client: undefined,
          args: { commandId: "sup-1" },
        }),
      );
      expect(cliRuntime.snapshotSupervisedCommand).toHaveBeenCalledWith(
        "sup-1",
        USER.id,
        "token-pat-1",
      );
      expect(held).toEqual({
        commandId: "sup-1",
        kind: "supervised",
        status: "awaiting_output_review",
        waitingUntil: "2026-01-01T00:15:00.000Z",
      });
      expect(cliRuntime.snapshotCliCommand).not.toHaveBeenCalled();
    });
  });
});

function disclosurePool() {
  return {
    id: "disclosure-pool",
    userId: "owner-private",
    slug: "shared",
    name: "Shared",
    description: null,
    fallbackEnabled: true,
    fallbackForGrantees: true,
    User: { slug: "owner" },
    PoolGrants: [],
    PoolMembers: [
      {
        id: "private-member",
        tier: "PUBLIC_OVERFLOW",
        healthStatus: "UNHEALTHY",
        ExecutionTarget: {
          id: "private-target",
          providerModelId: "private-provider-model",
          ProviderModel: {
            id: "private-provider-model",
            upstreamModelId: "private-upstream",
            PricingVersions: [],
            ProviderAccount: {
              id: "private-account-id",
              label: "Owner private billing label",
              providerType: "openrouter",
              baseUrl: "https://owner-private.example.test",
              credentialMetadata: "private-credential",
            },
          },
        },
      },
    ],
  };
}

describe("MCP preview provider disclosure", () => {
  for (const toolName of ["model_api_tokens_preview", "forwarder_models_visible_list"] as const)
    it.each([
      ["owner", true, true, true, true],
      ["eligible grantee", false, true, true, true],
      ["grantee coverage off", false, true, true, false],
      ["deployment off", false, false, true, true],
      ["fallback off", false, true, false, true],
    ] as const)("%s", async (_case, owner, enabled, fallbackEnabled, fallbackForGrantees) => {
      providerGate.enabled = enabled;
      const row = {
        ...disclosurePool(),
        fallbackEnabled,
        fallbackForGrantees,
        userId: owner ? USER.id : "owner-private",
      };
      const queries = prisma as unknown as {
        discoveredModel: { findMany: MockInstance };
        poolMember: { findMany: MockInstance };
        modelPool: { findMany: MockInstance };
        poolGrant: { findMany: MockInstance };
        appSetting: { findUnique: MockInstance };
      };
      queries.appSetting.findUnique.mockResolvedValue(null);
      queries.discoveredModel.findMany.mockResolvedValue([]);
      queries.modelPool.findMany.mockImplementation(
        async (args: { where?: { userId?: string } }) =>
          args.where?.userId ? (owner ? [row] : []) : [row],
      );
      queries.poolMember.findMany.mockResolvedValue([]);
      queries.poolGrant.findMany.mockResolvedValue(
        owner ? [] : [{ id: "live-grant", ModelPool: row }],
      );
      try {
        const authInfo = buildAuthInfo(["mcp:read"]);
        bindRequest(authInfo);
        const { body } = await callTool(authInfo, toolName, { scopeMode: "ALL_VISIBLE" });
        expect(body.result?.isError).toBeUndefined();
        const result = body.result?.structuredContent?.result as {
          modelPools: Array<{ providerAccountLabels: string[]; providerTypes: string[] }>;
        };
        expect(result.modelPools[0]?.providerAccountLabels).toEqual(
          owner && fallbackEnabled ? ["Owner private billing label"] : [],
        );
        const eligible = enabled && fallbackEnabled && (owner || fallbackForGrantees);
        expect(result.modelPools[0]?.providerTypes).toEqual(eligible ? ["openrouter"] : []);
        if (!owner) {
          // Both MCP text and structured content must be safe.
          const wire = JSON.stringify(body);
          expect(wire).not.toMatch(
            /Owner private billing label|private-account-id|owner-private\.example|private-credential|private-provider-model/,
          );
          if (!eligible) expect(wire).not.toContain("openrouter");
        }
      } finally {
        providerGate.enabled = true;
      }
    });
});

describe("CLI file tools", () => {
  const READ_RESULT = {
    etag: "h:AAAAAAAAAAAAAAAAAAAAAA",
    size: 12,
    mtime: "2026-01-01T00:00:00Z",
    mode: "0644",
    totalLines: 1,
    startLine: 1,
    endLine: 1,
    eol: "lf",
    text: "1|KEY=⟦redacted:12⟧",
    redactions: 1,
    more: null,
    secretFile: true,
  };

  beforeEach(() => {
    fileRuntime.runFileOp.mockReset();
  });

  async function listedTools(
    credential: ListedCredential | undefined,
    scopes: string[],
  ): Promise<Array<{ name: string; description?: string; annotations?: Record<string, unknown> }>> {
    const authInfo = buildAuthInfo(scopes);
    if (credential !== undefined) bindRequest(authInfo, "req-list", credential);
    const handler = createMcpTransport();
    const response = await handler.fetch(toolsListRequest(9), { authInfo });
    const body = (await response.json()) as {
      result?: { tools?: Array<{ name: string; description?: string }> };
    };
    return body.result?.tools ?? [];
  }

  async function call(
    name: string,
    args: unknown,
    options: { credential?: ListedCredential; scopes?: string[]; signal?: AbortSignal } = {},
  ) {
    return runManifestTool(requireDescriptor(name), {
      dispatch: cliDispatch(options.credential ?? PAT_WITH_CLI, options.signal),
      scopes: options.scopes ?? ["mcp:write"],
      client: undefined,
      args,
    });
  }

  function structured(result: { structuredContent?: unknown }) {
    return result.structuredContent as {
      result?: Record<string, unknown>;
      error?: Record<string, unknown>;
    };
  }

  it("registers 4 read-class and 5 write-class descriptors with the documented policy", () => {
    const table: Array<[string, "read" | "write", "DELETE" | "RUN" | null, string]> = [
      ["forwarder_cli_file_read", "read", null, "pure"],
      ["forwarder_cli_file_stat", "read", null, "pure"],
      ["forwarder_cli_dir_list", "read", null, "pure"],
      ["forwarder_cli_file_search", "read", null, "pure"],
      ["forwarder_cli_file_edit", "write", "RUN", "external"],
      ["forwarder_cli_file_write", "write", "RUN", "external"],
      ["forwarder_cli_file_rename", "write", "RUN", "external"],
      ["forwarder_cli_dir_create", "write", "RUN", "external"],
      ["forwarder_cli_file_delete", "write", "DELETE", "destructive"],
    ];
    for (const [name, scope, confirmation, classification] of table) {
      const descriptor = requireDescriptor(name);
      expect(
        `${name} ${descriptor.scope} ${descriptor.confirmation} ${descriptor.classification}`,
      ).toBe(`${name} ${scope} ${confirmation} ${classification}`);
      expect(descriptor.target).toMatch(/^core:forwarderCliFile/);
      if (scope === "read") expect(descriptor.deliverDespiteAbort).not.toBe(true);
      else {
        expect(descriptor.deliverDespiteAbort).toBe(true);
        expect(descriptor.deliverDespiteAbortWhen?.({ kind: "supervised", commandId: "id" })).toBe(
          true,
        );
        expect(descriptor.deliverDespiteAbortWhen?.({ ok: true, op: "write", result: {} })).toBe(
          false,
        );
      }
    }
  });

  it("hides all nine tools from OAuth and from a PAT without the flag, and lists them for a flagged PAT with mcp:write", async () => {
    for (const [credential, scopes] of [
      [OAUTH_CREDENTIAL, ["mcp:write"]],
      [OAUTH_CREDENTIAL, ["mcp:read"]],
      [PAT_WITHOUT_CLI, ["mcp:write"]],
      [undefined, ["mcp:write"]],
    ] as const) {
      const names = (await listedTools(credential, [...scopes])).map((tool) => tool.name);
      for (const name of CLI_FILE_TOOL_NAMES) expect(names).not.toContain(name);
    }
    const flagged = (await listedTools(PAT_WITH_CLI, ["mcp:write"])).map((tool) => tool.name);
    for (const name of CLI_FILE_TOOL_NAMES) expect(flagged).toContain(name);
    // A flagged PAT that only holds mcp:read does not get the file tools in this phase.
    const readOnly = (await listedTools(PAT_WITH_CLI, ["mcp:read"])).map((tool) => tool.name);
    for (const name of CLI_FILE_TOOL_NAMES) expect(readOnly).not.toContain(name);
  });

  it("read-only PAT consent exposes and calls exactly four read file tools; every write/command remains unknown", async () => {
    const credential = {
      ...PAT_WITH_CLI,
      allowCliCommands: false,
      allowCliFileRead: true,
      scopes: ["mcp:read"],
    };
    const names = (await listedTools(credential, ["mcp:read"]))
      .map((tool) => tool.name)
      .filter(
        (name) =>
          CLI_FILE_TOOL_NAMES.some((file) => file === name) ||
          [
            "forwarder_cli_command_run",
            "forwarder_cli_supervised_command_start",
            "forwarder_cli_command_result",
          ].includes(name),
      );
    expect(names.sort()).toEqual(
      [
        "forwarder_cli_file_read",
        "forwarder_cli_file_stat",
        "forwarder_cli_dir_list",
        "forwarder_cli_file_search",
      ].sort(),
    );
    fileRuntime.runFileOp.mockResolvedValue({ ok: true, op: "read", result: READ_RESULT });
    const read = await call(
      "forwarder_cli_file_read",
      { cliDeviceId: "cli-1", path: "~/a" },
      { credential, scopes: ["mcp:read"] },
    );
    expect(read.isError).not.toBe(true);
    expect(fileRuntime.runFileOp).toHaveBeenCalledOnce();
    for (const name of [
      ...CLI_FILE_TOOL_NAMES.slice(4),
      "forwarder_cli_command_run",
      "forwarder_cli_supervised_command_start",
      "forwarder_cli_command_result",
    ]) {
      const result = await call(
        name,
        { cliDeviceId: "cli-1", path: "~/a", confirm: "RUN" },
        { credential, scopes: ["mcp:read"] },
      );
      expect(resultText(result)).toBe(`Tool ${name} not found`);
    }
    expect(fileRuntime.runFileOp).toHaveBeenCalledOnce();
    for (const flags of [
      { allowCliCommands: false, allowCliFileRead: false, scopes: ["mcp:read"] },
      { allowCliCommands: false, allowCliFileRead: true, scopes: [] },
      { allowCliCommands: true, allowCliFileRead: false, scopes: ["mcp:read"] },
    ]) {
      const tools = await listedTools({ ...PAT_WITH_CLI, ...flags }, flags.scopes);
      expect(
        tools.filter((tool) => CLI_FILE_TOOL_NAMES.some((name) => name === tool.name)),
      ).toEqual([]);
    }
  });

  it("answers an unknown-tool error at call time to OAuth, a PAT without the flag, and a read-only PAT", async () => {
    for (const [credential, scopes] of [
      [OAUTH_CREDENTIAL, ["mcp:write"]],
      [PAT_WITHOUT_CLI, ["mcp:write"]],
      [PAT_WITH_CLI, ["mcp:read"]],
    ] as const) {
      for (const name of CLI_FILE_TOOL_NAMES) {
        const result = await call(
          name,
          { cliDeviceId: "cli-1", path: "~/a", confirm: "RUN" },
          { credential, scopes: [...scopes] },
        );
        expect(result.isError).toBe(true);
        expect(resultText(result)).toBe(`Tool ${name} not found`);
      }
    }
    expect(fileRuntime.runFileOp).not.toHaveBeenCalled();
  });

  it("requires the confirmation literal on write-class tools before anything runs", async () => {
    for (const [name, literal] of [
      ["forwarder_cli_file_edit", "RUN"],
      ["forwarder_cli_file_write", "RUN"],
      ["forwarder_cli_file_rename", "RUN"],
      ["forwarder_cli_dir_create", "RUN"],
      ["forwarder_cli_file_delete", "DELETE"],
    ] as const) {
      const result = await call(name, { cliDeviceId: "cli-1", path: "~/a" });
      expect(resultText(result)).toContain(`confirm="${literal}"`);
      const wrong = await call(name, {
        cliDeviceId: "cli-1",
        path: "~/a",
        confirm: literal === "RUN" ? "DELETE" : "RUN",
      });
      expect(resultText(wrong)).toContain(`confirm="${literal}"`);
    }
    expect(fileRuntime.runFileOp).not.toHaveBeenCalled();
  });

  it("advertises strict inputs and states the masking boundary, the ETag workflow, and the unknown-outcome recovery", async () => {
    const tools = await listedTools(PAT_WITH_CLI, ["mcp:write"]);
    const read = tools.find((tool) => tool.name === "forwarder_cli_file_read");
    const edit = tools.find((tool) => tool.name === "forwarder_cli_file_edit");
    expect(read?.description).toContain("NOT a security boundary");
    expect(read?.description).toContain("⟦redacted:N⟧");
    expect(read?.description).toContain("private-key blocks");
    expect(read?.description).toContain("ifNoneMatch");
    expect(edit?.description).toContain("expectedEtag");
    expect(edit?.description).toContain("forwarder_cli_file_stat");
    expect(edit?.description).toContain("io_error");
    expect(edit?.description).toContain("NOT idempotent");
    const commandResult = tools.find((tool) => tool.name === "forwarder_cli_command_result");
    expect(commandResult?.description).toContain("Every non-success after acceptance");
    expect(edit?.description).toContain('confirm: "RUN"');
    const remove = tools.find((tool) => tool.name === "forwarder_cli_file_delete");
    expect(remove?.description).toContain(
      "successful headless edit/write/rename/delete results may include recovered",
    );
    expect(remove?.description).toContain("Headless unsafe_filesystem is a definitive refusal");
    expect(remove?.description).toContain(
      "a supervised unsafe_filesystem error after acceptance remains unknown",
    );
    expect(remove?.description).toContain("mkdir/rmdir pair");
    expect(remove?.description).toContain("free space with the shell");
    expect(remove?.description).toContain("rmdir by name");
    expect(edit?.description).toContain("hard_linked until manual cleanup");
    // G3: the 64 KiB request-fit rule is stated on the tools whose advertised
    // maxima can exceed it (stat's 50 paths, list/search patterns), and the
    // read note names the escape-dense too_large case.
    const stat = tools.find((tool) => tool.name === "forwarder_cli_file_stat");
    const list = tools.find((tool) => tool.name === "forwarder_cli_dir_list");
    const search = tools.find((tool) => tool.name === "forwarder_cli_file_search");
    for (const tool of [stat, list, search, edit]) {
      expect(tool?.description).toContain("64 KiB relay frame");
    }
    expect(read?.description).toContain("escape-dense");
    expect(read?.annotations?.readOnlyHint).toBe(true);
    expect(edit?.annotations?.readOnlyHint).toBe(false);
    const listing = await (async () => {
      const authInfo = buildAuthInfo(["mcp:write"]);
      bindRequest(authInfo, "req-schema", PAT_WITH_CLI);
      const response = await createMcpTransport().fetch(toolsListRequest(10), { authInfo });
      return (await response.json()) as {
        result?: {
          tools?: Array<{
            name: string;
            inputSchema?: { properties?: Record<string, unknown>; additionalProperties?: unknown };
          }>;
        };
      };
    })();
    const schema = listing.result?.tools?.find(
      (tool) => tool.name === "forwarder_cli_file_read",
    )?.inputSchema;
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(
      [
        "byteOffset",
        "cliDeviceId",
        "ifNoneMatch",
        "lineNumbers",
        "maxBytes",
        "maxLines",
        "path",
        "startLine",
      ].sort(),
    );
    // The generated schema is advisory and loose (#117); the core enforces the strict shape.
    expect(schema?.additionalProperties).toEqual({});
  });

  it("runs a read with exactly the documented arguments, and projects only documented fields", async () => {
    fileRuntime.runFileOp.mockResolvedValue({
      ok: true,
      op: "read",
      result: { ...READ_RESULT, leaked: "SHOULD_NOT_APPEAR", nested: { more: 1 } },
    });
    const result = await call("forwarder_cli_file_read", {
      cliDeviceId: "cli-1",
      path: "~/.env",
      startLine: 1,
      maxLines: 10,
    });
    expect(result.isError).toBeUndefined();
    expect(fileRuntime.runFileOp).toHaveBeenCalledWith({
      userId: USER.id,
      tokenId: "token-pat-1",
      expiresAt: PAT_EXPIRES,
      cliDeviceId: "cli-1",
      op: "read",
      args: { path: "~/.env", startLine: 1, maxLines: 10 },
      signal: undefined,
    });
    const payload = structured(result).result;
    expect(payload).toEqual(READ_RESULT);
    expect(JSON.stringify(result)).not.toContain("SHOULD_NOT_APPEAR");
    // The boolean secretFile flag survives the generic key redactor.
    expect(payload?.secretFile).toBe(true);
    expect(resultText(result)).toContain("⟦redacted:12⟧");
  });

  it("audits and names fields for shape errors even through the real SDK transport", async () => {
    const bad: Array<Record<string, unknown>> = [
      { path: 42 },
      { path: "~/a", maxLines: 5000 },
      { path: "~/a", nested: { edits: 1 } },
    ];
    for (const extra of bad) {
      fileRuntime.auditRefusedFileInput.mockClear();
      const authInfo = buildAuthInfo(["mcp:write"]);
      bindRequest(authInfo, "req-sdk", PAT_WITH_CLI);
      const { body } = await callTool(authInfo, "forwarder_cli_file_read", {
        cliDeviceId: "cli-1",
        ...extra,
      });
      expect(body.result?.isError).toBe(true);
      expect(body.result?.structuredContent?.error?.code).toBe("invalid_input");
      expect(fileRuntime.auditRefusedFileInput).toHaveBeenCalledTimes(1);
    }
    expect(fileRuntime.runFileOp).not.toHaveBeenCalled();
  });

  it.each([
    ["forwarder_cli_file_write", "write", { path: 42, content: "private body", confirm: "RUN" }],
    [
      "forwarder_cli_file_edit",
      "edit",
      { path: "~/a", edits: [{ oldText: 42, newText: "private edit" }], confirm: "RUN" },
    ],
    ["forwarder_cli_file_rename", "rename", { from: 42, to: "~/b", confirm: "RUN" }],
    ["forwarder_cli_dir_create", "mkdir", { path: "~/a", parents: "yes", confirm: "RUN" }],
    ["forwarder_cli_file_delete", "delete", { path: 42, confirm: "DELETE" }],
  ] as const)(
    "audits a %s shape refusal once before any supervised start",
    async (name, op, args) => {
      const authInfo = buildAuthInfo(["mcp:write"]);
      bindRequest(authInfo, "req-sdk-file-refusal", PAT_WITH_CLI);
      const { body } = await callTool(authInfo, name, { cliDeviceId: "cli-1", ...args });
      expect(body.result?.isError).toBe(true);
      expect(body.result?.structuredContent?.error?.code).toBe("invalid_input");
      expect(fileRuntime.auditRefusedFileInput).toHaveBeenCalledOnce();
      expect(fileRuntime.auditRefusedFileInput).toHaveBeenCalledWith(
        expect.objectContaining({ op, cliDeviceId: "" }),
      );
      expect(JSON.stringify(fileRuntime.auditRefusedFileInput.mock.calls)).not.toContain("private");
      expect(fileRuntime.runFileOp).not.toHaveBeenCalled();
    },
  );

  it("audits missing confirmation and oversized input through the real SDK transport (#104)", async () => {
    const confirmed: Array<[string, Record<string, unknown>]> = [
      ["forwarder_cli_file_write", { path: "~/n", content: "x" }],
      ["forwarder_cli_file_edit", { path: "~/a", oldString: "a", newString: "b" }],
      ["forwarder_cli_file_rename", { from: "~/a", to: "~/b" }],
      ["forwarder_cli_dir_create", { path: "~/n" }],
      ["forwarder_cli_file_delete", { path: "~/a" }],
      ["forwarder_cli_dir_create", { path: "~/a" }],
    ];
    const cases: Array<[string, Record<string, unknown>, string]> = [];
    for (const [name, args] of confirmed) {
      cases.push([name, args, "CONFIRMATION_REQUIRED"]);
      cases.push([name, { ...args, confirm: "NOPE" }, "CONFIRMATION_REQUIRED"]);
    }
    cases.push([
      "forwarder_cli_file_read",
      { path: "~/a", pad: "x".repeat(70_000) },
      "invalid_input",
    ]);
    for (const [name, args, code] of cases) {
      fileRuntime.auditRefusedFileInput.mockClear();
      const authInfo = buildAuthInfo(["mcp:write"]);
      bindRequest(authInfo, "req-sdk-c", PAT_WITH_CLI);
      const { body } = await callTool(authInfo, name, { cliDeviceId: "cli-1", ...args });
      expect(body.error).toBeUndefined();
      expect(body.result?.isError).toBe(true);
      expect(body.result?.structuredContent?.error?.code).toBe(code);
      expect(fileRuntime.auditRefusedFileInput).toHaveBeenCalledTimes(1);
      expect(fileRuntime.auditRefusedFileInput.mock.calls[0]?.[0]).toMatchObject({
        cliDeviceId: "",
        userId: USER.id,
        tokenId: "token-pat-1",
      });
    }
    expect(fileRuntime.runFileOp).not.toHaveBeenCalled();
  });

  it("audits deeply nested invalid JSON without echoing values through the SDK", async () => {
    const authInfo = buildAuthInfo(["mcp:write"]);
    bindRequest(authInfo, "req-sdk-deep", PAT_WITH_CLI);
    const request = toolCallRequest(1, "forwarder_cli_file_read");
    // Send the nested value as raw JSON, without pre-processing it through
    // the test client's serializer. The request stays under the size bound.
    const nested = `${'{"x":'.repeat(10_000)}"SECRET-DEEP-VALUE"${"}".repeat(10_000)}`;
    const rawArgs = `{"cliDeviceId":"cli-1","path":"~/a","extra":${nested}}`;
    const body = (await request.text()).replace('"arguments":{}', `"arguments":${rawArgs}`);
    const response = await createMcpTransport().fetch(
      new Request(request.url, { method: request.method, headers: request.headers, body }),
      { authInfo },
    );
    const result = (await response.json()) as Awaited<ReturnType<typeof callTool>>["body"];
    expect(result.error).toBeUndefined();
    expect(result.result?.isError).toBe(true);
    expect(result.result?.structuredContent?.error?.code).toBe("invalid_input");
    expect(fileRuntime.auditRefusedFileInput).toHaveBeenCalledTimes(1);
    expect(fileRuntime.runFileOp).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(/SECRET-DEEP-VALUE|stack|RangeError/);
  });

  it.each(["sync", "async"])(
    "audits a %s validator exception without SDK message echo",
    async (mode) => {
      const validate = vi
        .spyOn(requireDescriptor("forwarder_cli_file_read").inputSchema["~standard"], "validate")
        .mockImplementationOnce(() => {
          const error = new Error("SECRET-VALIDATOR-VALUE");
          if (mode === "async") return Promise.reject(error);
          throw error;
        });
      try {
        const authInfo = buildAuthInfo(["mcp:write"]);
        bindRequest(authInfo, "req-sdk-validator", PAT_WITH_CLI);
        const { body } = await callTool(authInfo, "forwarder_cli_file_read", {
          cliDeviceId: "cli-1",
          path: "~/a",
        });
        expect(body.error).toBeUndefined();
        expect(body.result?.isError).toBe(true);
        expect(body.result?.structuredContent?.error?.code).toBe("invalid_input");
        expect(fileRuntime.auditRefusedFileInput).toHaveBeenCalledTimes(1);
        expect(fileRuntime.runFileOp).not.toHaveBeenCalled();
        expect(JSON.stringify(body)).not.toContain("SECRET-VALIDATOR-VALUE");
      } finally {
        validate.mockRestore();
      }
    },
  );

  it("names the failing fields of an invalid input without echoing values (#117)", async () => {
    const cases: Array<[Record<string, unknown>, RegExp, string]> = [
      [{ path: "~/a", surprise: "SECRET-VALUE-XYZ" }, /Unrecognized field/, "(input)"],
      [{ path: "~/a", maxLines: 5000 }, /maxLines/, "maxLines"],
      [{ path: 42 }, /path/, "path"],
      [{}, /path/, "path"],
    ];
    for (const [extra, pattern, field] of cases) {
      const result = await call("forwarder_cli_file_read", { cliDeviceId: "cli-1", ...extra });
      expect(result.isError).toBe(true);
      expect(structured(result).error?.code).toBe("invalid_input");
      const issues = structured(result).error?.issues as Array<{ path: unknown[] }> | undefined;
      expect(issues?.length).toBeGreaterThan(0);
      expect(resultText(result)).toMatch(pattern);
      expect(JSON.stringify(result)).not.toContain("SECRET-VALUE-XYZ");
      if (field !== "(input)") expect(issues?.some((i) => i.path.join(".") === field)).toBe(true);
    }
    expect(fileRuntime.runFileOp).not.toHaveBeenCalled();
  });

  it("audits an input refused in the MCP layer as a refusal (#104)", async () => {
    fileRuntime.auditRefusedFileInput.mockClear();
    await call("forwarder_cli_file_read", { cliDeviceId: "cli-1", path: "~/a", surprise: 1 });
    await call("forwarder_cli_file_write", {
      cliDeviceId: "cli-1",
      path: "~/n",
      content: "not base64!!",
      encoding: "base64",
      confirm: "RUN",
    });
    expect(fileRuntime.auditRefusedFileInput).toHaveBeenCalledTimes(2);
    expect(fileRuntime.auditRefusedFileInput.mock.calls[1]?.[0]).toMatchObject({
      op: "write",
      userId: USER.id,
      tokenId: "token-pat-1",
    });
    expect(JSON.stringify(fileRuntime.auditRefusedFileInput.mock.calls)).not.toContain(
      "not base64",
    );
  });

  it("scrubs credential substrings from a CLI-supplied error detail", async () => {
    fileRuntime.runFileOp.mockResolvedValueOnce({
      ok: false,
      code: "conflict",
      detail: { currentEtag: "h:wsmp_cli_abcdef0123456789xyz" },
    });
    const result = await call("forwarder_cli_file_edit", {
      cliDeviceId: "cli-1",
      path: "~/a",
      edits: [{ oldText: "a", newText: "b" }],
      confirm: "RUN",
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/wsmp_cli_[A-Za-z0-9]{6,}/);
    expect(structured(result).error?.code).toBe("conflict");
  });

  it("reports uncertain recovery with a fixed message and scrubs every path", async () => {
    fileRuntime.runFileOp.mockResolvedValueOnce({
      ok: false,
      code: "uncertain_outcome",
      outcome: "unknown",
      detail: {
        recovery: "/workspace/.wsmp-recover-a1b2c3d4e5",
        kept: ["/workspace/wsmp_cli_abcdef0123456789xyz/slot-1"],
      },
    });
    const result = await call("forwarder_cli_file_edit", {
      cliDeviceId: "cli-1",
      path: "~/a",
      edits: [{ oldText: "a", newText: "b" }],
      confirm: "RUN",
    });
    expect(result.isError).toBe(true);
    expect(structured(result).error).toMatchObject({
      code: "uncertain_outcome",
      outcome: "unknown",
      recovery: "/workspace/.wsmp-recover-a1b2c3d4e5",
    });
    expect(resultText(result)).toContain("The file outcome is uncertain; inspect recovery");
    expect(JSON.stringify(result)).not.toMatch(/wsmp_cli_[A-Za-z0-9]{6,}/);
    expect(structured(result).error?.kept).toHaveLength(1);
  });

  it("reports unsafe_filesystem as a definitive refusal with the generic fixed message", async () => {
    fileRuntime.runFileOp.mockResolvedValueOnce({
      ok: false,
      code: "unsafe_filesystem",
      message: "PRIVATE CLI MESSAGE",
    });
    const result = await call("forwarder_cli_file_rename", {
      cliDeviceId: "cli-1",
      from: "~/a",
      to: "~/b",
      confirm: "RUN",
    });
    expect(result.isError).toBe(true);
    expect(structured(result).error).toEqual({
      code: "unsafe_filesystem",
    });
    expect(resultText(result)).toContain(
      "This filesystem lacks the atomic primitives to change this path without risking a concurrent save; nothing was changed",
    );
    expect(JSON.stringify(result)).not.toContain("PRIVATE CLI MESSAGE");
  });

  it("passes recovered paths through edit, write, rename and delete success projections", async () => {
    const recovered = ["/workspace/.wsmp-recover-a1b2c3d4e5/slot-1"];
    const etag = "h:AAAAAAAAAAAAAAAAAAAAAA";
    const cases = [
      [
        "edit",
        "forwarder_cli_file_edit",
        { path: "~/a", edits: [{ oldText: "a", newText: "b" }], confirm: "RUN" },
        { etag, previousEtag: etag, added: 1, removed: 1, applied: true, recovered },
      ],
      [
        "write",
        "forwarder_cli_file_write",
        { path: "~/a", content: "b", confirm: "RUN" },
        { etag, size: 1, created: true, recovered },
      ],
      [
        "rename",
        "forwarder_cli_file_rename",
        { from: "~/a", to: "~/b", confirm: "RUN" },
        { etag, recovered },
      ],
      [
        "delete",
        "forwarder_cli_file_delete",
        { path: "~/a", confirm: "DELETE" },
        { deleted: true, type: "file", recovered },
      ],
    ] as const;
    for (const [op, tool, args, result] of cases) {
      fileRuntime.runFileOp.mockResolvedValueOnce({ ok: true, op, result });
      const response = await call(tool, { cliDeviceId: "cli-1", ...args });
      expect(response.isError).not.toBe(true);
      expect(structured(response).result?.recovered).toEqual(recovered);
    }
  });

  it("keeps unchanged:true in the ifNoneMatch answer", async () => {
    fileRuntime.runFileOp.mockResolvedValue({
      ok: true,
      op: "read",
      result: { unchanged: true, etag: "h:AAAAAAAAAAAAAAAAAAAAAA", junk: 1 },
    });
    const result = await call("forwarder_cli_file_read", {
      cliDeviceId: "cli-1",
      path: "~/a",
      ifNoneMatch: "h:AAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(structured(result).result).toEqual({
      unchanged: true,
      etag: "h:AAAAAAAAAAAAAAAAAAAAAA",
    });
  });

  it("clamps a read window to the MCP output budget", async () => {
    fileRuntime.runFileOp.mockResolvedValue({ ok: true, op: "read", result: READ_RESULT });
    await call("forwarder_cli_file_read", { cliDeviceId: "cli-1", path: "~/a", maxBytes: 131072 });
    expect(fileRuntime.runFileOp.mock.calls[0]?.[0]).toMatchObject({ args: { maxBytes: 98304 } });
  });

  it("projects stat entries, list, search, and the write-class results field by field", async () => {
    fileRuntime.runFileOp.mockResolvedValueOnce({
      ok: true,
      op: "stat",
      result: { entries: [{ path: "~/a", type: "file", size: 1, junk: true }], junk: 1 },
    });
    expect(
      structured(await call("forwarder_cli_file_stat", { cliDeviceId: "cli-1", paths: ["~/a"] }))
        .result,
    ).toEqual({ entries: [{ path: "~/a", type: "file", size: 1 }] });
    fileRuntime.runFileOp.mockResolvedValueOnce({
      ok: true,
      op: "list",
      result: { entries: "f 1B ~/a", count: 1, more: { cursor: "c", junk: 1 }, junk: 1 },
    });
    expect(
      structured(await call("forwarder_cli_dir_list", { cliDeviceId: "cli-1", path: "~/" })).result,
    ).toEqual({ entries: "f 1B ~/a", count: 1, more: { cursor: "c" } });
    fileRuntime.runFileOp.mockResolvedValueOnce({
      ok: true,
      op: "search",
      result: { matches: "a:1|x", files: 1, count: 1, scannedFiles: 3, more: null, junk: 1 },
    });
    expect(
      structured(
        await call("forwarder_cli_file_search", { cliDeviceId: "cli-1", root: "~/", pattern: "x" }),
      ).result,
    ).toEqual({ matches: "a:1|x", files: 1, count: 1, scannedFiles: 3, more: null });
    fileRuntime.runFileOp.mockResolvedValueOnce({
      ok: true,
      op: "edit",
      result: {
        etag: "h:AAAAAAAAAAAAAAAAAAAAAA",
        previousEtag: "h:BBBBBBBBBBBBBBBBBBBBBB",
        added: 1,
        removed: 1,
        applied: true,
        junk: 1,
      },
    });
    const edited = await call("forwarder_cli_file_edit", {
      cliDeviceId: "cli-1",
      path: "~/a",
      expectedEtag: "h:BBBBBBBBBBBBBBBBBBBBBB",
      edits: [{ oldText: "a", newText: "b" }],
      reason: "why",
      confirm: "RUN",
    });
    expect(structured(edited).result).toEqual({
      etag: "h:AAAAAAAAAAAAAAAAAAAAAA",
      previousEtag: "h:BBBBBBBBBBBBBBBBBBBBBB",
      added: 1,
      removed: 1,
      applied: true,
    });
    // The optional reason and the confirm-stripped arguments reach the op.
    expect(fileRuntime.runFileOp.mock.calls.at(-1)?.[0]).toMatchObject({
      op: "edit",
      args: {
        path: "~/a",
        expectedEtag: "h:BBBBBBBBBBBBBBBBBBBBBB",
        edits: [{ oldText: "a", newText: "b" }],
        reason: "why",
      },
    });
    expect(fileRuntime.runFileOp.mock.calls.at(-1)?.[0].args).not.toHaveProperty("confirm");
  });

  it("decodes write content into the binary body and keeps it out of the args", async () => {
    fileRuntime.runFileOp.mockResolvedValue({
      ok: true,
      op: "write",
      result: { etag: "h:AAAAAAAAAAAAAAAAAAAAAA", size: 5, created: true },
    });
    const text = await call("forwarder_cli_file_write", {
      cliDeviceId: "cli-1",
      path: "~/n.txt",
      content: "héllo",
      confirm: "RUN",
    });
    expect(text.isError).toBeUndefined();
    const first = fileRuntime.runFileOp.mock.calls[0]?.[0];
    expect(Buffer.from(first.body).toString("utf8")).toBe("héllo");
    expect(first.args).toEqual({ path: "~/n.txt" });
    await call("forwarder_cli_file_write", {
      cliDeviceId: "cli-1",
      path: "~/n.bin",
      content: Buffer.from([0, 255, 1]).toString("base64"),
      encoding: "base64",
      ifExists: "replace",
      expectedEtag: "h:BBBBBBBBBBBBBBBBBBBBBB",
      confirm: "RUN",
    });
    const second = fileRuntime.runFileOp.mock.calls[1]?.[0];
    expect([...second.body]).toEqual([0, 255, 1]);
    expect(second.args).toEqual({
      path: "~/n.bin",
      ifExists: "replace",
      expectedEtag: "h:BBBBBBBBBBBBBBBBBBBBBB",
    });
  });

  it("refuses content the relay cannot carry as invalid_input without calling the op", async () => {
    for (const content of [
      { content: "\ud800", encoding: "utf-8" },
      { content: "not base64!!", encoding: "base64" },
      { content: "QQ=x", encoding: "base64" },
      { content: "x".repeat(1024 * 1024 + 1) },
    ]) {
      const result = await call("forwarder_cli_file_write", {
        cliDeviceId: "cli-1",
        path: "~/n",
        confirm: "RUN",
        ...content,
      });
      expect(result.isError).toBe(true);
      expect(structured(result).error?.code).toBe("invalid_input");
    }
    expect(fileRuntime.runFileOp).not.toHaveBeenCalled();
  });

  it("removes wsmp_ credential substrings from every string, not only whole values", async () => {
    fileRuntime.runFileOp.mockResolvedValue({
      ok: true,
      op: "read",
      result: {
        ...READ_RESULT,
        secretFile: false,
        text: "1|export T=wsmp_mcp_abcdef0123456789 # and wsmp_cli_zzzzzzzz\n2|wsmp_model_qqqqqqqq",
        resolvedPath: "/home/u/wsmp_device_abcdefabcdef",
      },
    });
    const result = await call("forwarder_cli_file_read", { cliDeviceId: "cli-1", path: "~/a" });
    const wire = JSON.stringify(result);
    expect(wire).not.toMatch(/wsmp_(mcp|cli|model|device)_[A-Za-z0-9]{6,}/);
    expect(resultText(result)).toContain("export T=");
    expect(structured(result).result?.secretFile).toBe(false);
  });

  it("refuses a result that does not fit twice into the 256 KiB output cap with too_large", async () => {
    fileRuntime.runFileOp.mockResolvedValue({
      ok: true,
      op: "list",
      result: { entries: "f 1B ~/a\n".repeat(30_000), count: 30_000, more: null },
    });
    const result = await call("forwarder_cli_dir_list", { cliDeviceId: "cli-1", path: "~/" });
    expect(result.isError).toBe(true);
    expect(structured(result).error?.code).toBe("too_large");
    expect(JSON.stringify(result).length).toBeLessThan(1024);
  });

  it("returns failures in-band with a stable code and the small documented facts", async () => {
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [
        { ok: false, code: "conflict", detail: { currentEtag: "h:CCCCCCCCCCCCCCCCCCCCCC" } },
        { code: "conflict", currentEtag: "h:CCCCCCCCCCCCCCCCCCCCCC" },
      ],
      [
        { ok: false, code: "limit", retryAfterMs: 1500 },
        { code: "limit", retryAfterMs: 1500 },
      ],
      [
        { ok: false, code: "timeout", outcome: "unknown" },
        { code: "timeout", outcome: "unknown" },
      ],
      [
        { ok: false, code: "offline", outcome: "unknown" },
        { code: "offline", outcome: "unknown" },
      ],
      [
        { ok: false, code: "io_error", outcome: "unknown" },
        { code: "io_error", outcome: "unknown" },
      ],
      [
        { ok: false, code: "upgrade_required", rejectedProtocolVersion: "2.7" },
        { code: "upgrade_required", relayProtocolVersion: "2.7" },
      ],
      [{ ok: false, code: "supervised_only" }, { code: "supervised_only" }],
      [{ ok: false, code: "grant_disabled" }, { code: "grant_disabled" }],
      [{ ok: false, code: "token_inactive" }, { code: "token_inactive" }],
      [
        {
          ok: false,
          code: "match_count",
          detail: { edit: 0, expected: 1, found: 3, lines: [1, 2, 3] },
        },
        { code: "match_count", edit: 0, expected: 1, found: 3, lines: [1, 2, 3] },
      ],
    ];
    for (const [failure, expected] of cases) {
      fileRuntime.runFileOp.mockResolvedValueOnce(failure);
      const result = await call("forwarder_cli_file_edit", {
        cliDeviceId: "cli-1",
        path: "~/a",
        edits: [{ oldText: "a", newText: "b" }],
        confirm: "RUN",
      });
      expect(result.isError).toBe(true);
      expect(structured(result).error).toEqual(expected);
      expect(resultText(result).length).toBeGreaterThan(0);
      expect(resultText(result)).not.toContain("~/a");
    }
  });

  it("tells the agent that secret files are read-only masked views (secret_file)", async () => {
    for (const [tool, args] of [
      ["forwarder_cli_file_write", { path: "~/.env", content: "A=1", confirm: "RUN" }],
      [
        "forwarder_cli_file_edit",
        { path: "~/.env", edits: [{ oldText: "a", newText: "b" }], confirm: "RUN" },
      ],
      ["forwarder_cli_file_rename", { from: "~/.env", to: "~/x", confirm: "RUN" }],
      ["forwarder_cli_file_delete", { path: "~/.env", confirm: "DELETE" }],
      ["forwarder_cli_dir_create", { path: "~/.ssh/new", confirm: "RUN" }],
    ] as const) {
      fileRuntime.runFileOp.mockResolvedValueOnce({ ok: false, code: "secret_file" });
      const result = await call(tool, { cliDeviceId: "cli-1", ...args });
      expect(result.isError).toBe(true);
      expect(structured(result).error?.code).toBe("secret_file");
      expect(resultText(result)).toContain("read-only masked views");
    }
    const tools = await listedTools(PAT_WITH_CLI, ["mcp:write"]);
    for (const name of [
      "forwarder_cli_file_edit",
      "forwarder_cli_file_write",
      "forwarder_cli_file_rename",
      "forwarder_cli_dir_create",
      "forwarder_cli_file_delete",
    ]) {
      expect(tools.find((tool) => tool.name === name)?.description, name).toContain("secret_file");
    }
  });

  it("names the old protocol for upgrade_required and says the device, not a file, was not found", async () => {
    fileRuntime.runFileOp.mockResolvedValueOnce({
      ok: false,
      code: "upgrade_required",
      rejectedProtocolVersion: "2.7",
    });
    const upgrade = await call("forwarder_cli_file_read", { cliDeviceId: "cli-1", path: "~/a" });
    expect(resultText(upgrade)).toBe("This CLI speaks relay 2.7; upgrade wsmp");
    fileRuntime.runFileOp.mockResolvedValueOnce({ ok: false, code: "not_found", scope: "device" });
    const device = await call("forwarder_cli_file_read", { cliDeviceId: "nope", path: "~/a" });
    expect(resultText(device)).toBe("CLI device not found");
    fileRuntime.runFileOp.mockResolvedValueOnce({ ok: false, code: "not_found" });
    const missing = await call("forwarder_cli_file_read", { cliDeviceId: "cli-1", path: "~/a" });
    expect(resultText(missing)).toBe("No such file or directory");
  });

  it("does not deliver a result after the request aborts", async () => {
    const controller = new AbortController();
    fileRuntime.runFileOp.mockImplementation(async () => {
      controller.abort();
      return { ok: true, op: "read", result: READ_RESULT };
    });
    const result = await call(
      "forwarder_cli_file_read",
      { cliDeviceId: "cli-1", path: "~/a" },
      { signal: controller.signal },
    );
    expect(result.isError).toBe(true);
    expect(structured(result).error?.code).toBe("REQUEST_ABORTED");
  });

  it.each([true, false])(
    "delivers an aborted write only for a supervised start (%s)",
    async (supervised) => {
      const controller = new AbortController();
      fileRuntime.runFileOp.mockImplementationOnce(
        async (input: { onSupervisedStart?: () => void }) => {
          input.onSupervisedStart?.();
          controller.abort();
          return supervised
            ? {
                ok: true,
                kind: "supervised",
                commandId: "file-1",
                terminalId: "term-1",
                status: "awaiting_user",
                waitingUntil: "2026-01-01T00:15:00Z",
                next: "poll",
              }
            : { ok: true, op: "write", result: { etag: "h:aaa", size: 1, created: true } };
        },
      );
      const result = await call(
        "forwarder_cli_file_write",
        { cliDeviceId: "cli-1", path: "~/a", content: "x", confirm: "RUN" },
        { signal: controller.signal },
      );
      if (supervised)
        expect(structured(result).result).toMatchObject({
          commandId: "file-1",
          status: "awaiting_user",
          next: "poll",
        });
      else expect(structured(result).error?.code).toBe("REQUEST_ABORTED");
    },
  );

  it("aborts promptly before file registration even while admission is pending", async () => {
    const controller = new AbortController();
    let release!: (result: unknown) => void;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    fileRuntime.runFileOp.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
          entered();
        }),
    );
    const pending = call(
      "forwarder_cli_file_write",
      { cliDeviceId: "cli-1", path: "~/a", content: "x", confirm: "RUN" },
      { signal: controller.signal },
    );
    await reached;
    controller.abort();
    const result = await pending;
    expect(structured(result).error?.code).toBe("REQUEST_ABORTED");
    release({ ok: false, code: "cancelled" });
  });

  it("preserves abort semantics when a headless file core refuses after abort", async () => {
    const controller = new AbortController();
    fileRuntime.runFileOp.mockImplementationOnce(
      async (input: { onSupervisedStart?: () => void }) => {
        input.onSupervisedStart?.();
        controller.abort();
        return { ok: false, code: "cancelled", outcome: "unknown" };
      },
    );
    const result = await call(
      "forwarder_cli_file_write",
      { cliDeviceId: "cli-1", path: "~/a", content: "x", confirm: "RUN" },
      { signal: controller.signal },
    );
    expect(structured(result).error?.code).toBe("REQUEST_ABORTED");
  });

  it.each(["commandId", "terminalId", "next"] as const)(
    "scrubs credential substrings from supervised start field %s",
    (field) => {
      const credential = `wsmp_mcp_${crypto.randomUUID().replaceAll("-", "")}`;
      const start = {
        commandId: "file-1",
        terminalId: "terminal-1",
        kind: "supervised",
        status: "awaiting_user",
        waitingUntil: "2026-01-01T00:15:00.000Z",
        next: "Poll forwarder_cli_command_result",
        [field]: `before (${credential}) after`,
      };
      expect(projectFileToolOutput(start)).toEqual({
        ...start,
        [field]: "before ([redacted]) after",
      });
    },
  );

  it.each([
    ["conflict", "The file changed since it was read; re-read it and retry with the new etag"],
    ["declined", "The person declined the file operation; nothing was applied"],
    ["timeout", "The file operation timed out"],
    ["offline", "The CLI is offline or does not support file tools"],
    ["io_error", "The file operation failed"],
    [
      "uncertain_outcome",
      "The file outcome is uncertain; ask the person to check the wsmp daemon log for recovery locations",
    ],
    [
      "unsafe_filesystem",
      "This filesystem lacks the atomic primitives to change this path without risking a concurrent save; ask the person to check the file",
    ],
    ["limit", "Too many file operations; wait for an active request to finish or retry later"],
    [
      "secret_file",
      "Secret files are read-only masked views: edit, write, rename, delete and mkdir are refused on them and on their directories",
    ],
  ] as const)(
    "polls supervised file error %s with its exact documented message",
    async (code, message) => {
      const unknown =
        code === "timeout" ||
        code === "offline" ||
        code === "io_error" ||
        code === "uncertain_outcome" ||
        code === "unsafe_filesystem";
      cliRuntime.snapshotSupervisedCommand.mockReturnValueOnce({
        kind: "supervised",
        requestKind: "file",
        commandId: "file-1",
        status: code === "declined" ? "declined" : unknown ? "cancelled" : "rejected",
        started: unknown,
        waitDeadline: null,
        file: null,
        fileError: { code, ...(unknown ? { outcome: "unknown" } : {}) },
      });
      const result = await call("forwarder_cli_command_result", { commandId: "file-1" });
      expect(result.isError).toBeUndefined();
      expect(structured(result).result?.error).toEqual({
        code,
        message,
        ...(unknown ? { outcome: "unknown" } : {}),
      });
    },
  );

  it.each([
    "conflict",
    "not_found",
    "cancelled",
    "token_inactive",
    "grant_disabled",
    "feature_disabled",
  ] as const)("preserves the unknown outcome of an accepted supervised %s", async (code) => {
    cliRuntime.snapshotSupervisedCommand.mockReturnValueOnce({
      kind: "supervised",
      requestKind: "file",
      commandId: "file-1",
      status: "rejected",
      started: true,
      waitDeadline: null,
      file: null,
      fileError: { code, outcome: "unknown" },
    });
    const result = await call("forwarder_cli_command_result", { commandId: "file-1" });
    expect(structured(result).result?.error).toMatchObject({ code, outcome: "unknown" });
  });

  it.each(["success", "declined", "timeout"] as const)(
    "polls file %s through command_result with a bounded documented projection",
    async (outcome) => {
      // Ephemeral credential, generated rather than stored as a secret fixture.
      const credential = `wsmp_mcp_${crypto.randomUUID().replaceAll("-", "")}`;
      cliRuntime.snapshotSupervisedCommand.mockReturnValueOnce({
        kind: "supervised",
        requestKind: "file",
        commandId: "file-1",
        status: outcome === "success" ? "exited" : "cancelled",
        started: outcome !== "declined",
        waitDeadline: null,
        file:
          outcome === "success"
            ? {
                op: "write",
                result: {
                  etag: "h:aaa",
                  size: 1,
                  created: true,
                  resolvedPath: `/tmp/${credential}`,
                  extra: "forged",
                },
              }
            : null,
        fileError:
          outcome === "success"
            ? null
            : { code: outcome, ...(outcome === "timeout" ? { outcome: "unknown" } : {}) },
      });
      const result = await call("forwarder_cli_command_result", { commandId: "file-1" });
      const projected = structured(result).result;
      if (outcome === "success") {
        expect(projected?.file).toMatchObject({
          op: "write",
          result: { etag: "h:aaa", size: 1, created: true },
        });
        expect(JSON.stringify(projected)).not.toContain(credential);
        expect(JSON.stringify(projected)).not.toContain("forged");
      } else
        expect(projected?.error).toMatchObject({
          code: outcome,
          message: expect.any(String),
          ...(outcome === "timeout" ? { outcome: "unknown" } : {}),
        });
    },
  );

  it("accepts a base64 write at the 1 MiB decoded cap through the advertised schema (G2)", async () => {
    // The base64 text of a 1 MiB body is ~1.4 MiB, so the schema's
    // first-stage input bound must be sized for the ENCODED form. The row
    // below is exactly what the old `FILE_BODY_MAX_BYTES + 16 KiB` bound
    // refused before `adaptFileToolInput` ever decoded it. (The matching
    // JSON-RPC request then exceeds the 1 MB /mcp body cap, so on the real
    // wire this size is refused in transport, not by this guard; the guard
    // must not be the thing that refuses a body the tool advertises.)
    const schema = requireDescriptor("forwarder_cli_file_write").inputSchema;
    const argsFor = (content: string) => ({
      cliDeviceId: "cli-1",
      path: "~/big.bin",
      encoding: "base64",
      confirm: "RUN",
      content,
    });
    const full = Buffer.alloc(1024 * 1024, 0x41).toString("base64");
    expect(Buffer.from(full, "base64").length).toBe(1024 * 1024);
    const fullValidated = (await schema["~standard"].validate(argsFor(full))) as {
      issues?: unknown[];
    };
    expect(fullValidated.issues).toBeUndefined();

    // The largest request that can actually arrive under the 1 MB /mcp body
    // cap still round-trips end to end: decode → body → relay op.
    const overhead = new TextEncoder().encode(
      toolCallBody("forwarder_cli_file_write", argsFor("")),
    ).length;
    const contentLength = Math.floor((1024 * 1024 - overhead) / 4) * 4;
    const content = "A".repeat(contentLength);
    const args = argsFor(content);
    expect(
      new TextEncoder().encode(toolCallBody("forwarder_cli_file_write", args)).length,
    ).toBeLessThanOrEqual(1024 * 1024);
    const decoded = (contentLength / 4) * 3;
    expect(decoded).toBeGreaterThan(700 * 1024);
    expect(decoded).toBeLessThanOrEqual(1024 * 1024);

    fileRuntime.runFileOp.mockResolvedValueOnce({
      ok: true,
      op: "write",
      result: { etag: "h:AAAAAAAAAAAAAAAAAAAAAA", size: decoded, created: true },
    });
    const result = await call("forwarder_cli_file_write", args);
    expect(result.isError).toBeUndefined();
    expect(fileRuntime.runFileOp.mock.calls.at(-1)?.[0].body?.byteLength).toBe(decoded);
  });

  it("refuses a base64 write whose body would decode past the decoded cap (G2 inverse)", async () => {
    const schema = requireDescriptor("forwarder_cli_file_write").inputSchema;
    // A JSON input far above the first-stage bound is refused there (one size issue).
    const oversized = {
      cliDeviceId: "cli-1",
      path: "~/big.bin",
      encoding: "base64",
      confirm: "RUN",
      content: "A".repeat(1500 * 1024),
    };
    const guarded = (await schema["~standard"].validate(oversized)) as {
      issues?: { message: string }[];
    };
    expect(guarded.issues).toHaveLength(1);
    expect(guarded.issues?.[0]?.message).toContain("input exceeds the maximum size");

    // And an input UNDER the guard whose decoded body exceeds 1 MiB is refused
    // as invalid_input by the decoded-body cap, before any op runs.
    fileRuntime.runFileOp.mockClear();
    const decoded = Buffer.alloc(1024 * 1024 + 1, 1).toString("base64");
    const result = await call("forwarder_cli_file_write", {
      cliDeviceId: "cli-1",
      path: "~/big.bin",
      encoding: "base64",
      confirm: "RUN",
      content: decoded,
    });
    expect(result.isError).toBe(true);
    expect(structured(result).error?.code).toBe("invalid_input");
    expect(fileRuntime.runFileOp).not.toHaveBeenCalled();
  });
});
