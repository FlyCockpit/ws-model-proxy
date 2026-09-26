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

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_SECRET: "test-better-auth-secret",
    BETTER_AUTH_URL: "https://proxy.example.com",
    WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: true,
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
const { createMcpContext } = await import("./context");
const { default: prisma } = await import("@ws-model-proxy/db");
type McpToolDescriptor = (typeof MCP_TOOL_MANIFEST)[number];

const db = prisma as unknown as {
  modelApiToken: { findMany: MockInstance; findUnique: MockInstance; update: MockInstance };
  relayRequest: { findMany: MockInstance };
  providerAccount: { findFirst: MockInstance };
  providerCredential: { findMany: MockInstance };
  mcpGrant: { findUnique: MockInstance };
  user: { findUnique: MockInstance };
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
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: tool, arguments: args, _meta: ENVELOPE },
    }),
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

const CLI_COMMAND_TOOL_NAMES = new Set<string>([
  "forwarder_cli_command_run",
  "forwarder_cli_supervised_command_start",
  "forwarder_cli_command_result",
]);

function catalogNames(includeCliCommands: boolean): string[] {
  return MCP_TOOL_MANIFEST.map((tool) => tool.name)
    .filter((name) => includeCliCommands || !CLI_COMMAND_TOOL_NAMES.has(name))
    .sort();
}

interface WireResult {
  content?: { type: string; text: string }[];
  structuredContent?: { result?: unknown; error?: { code?: string }; requestId?: string };
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
      error: { code: "INVALID_INPUT", field: "createdAfter" },
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
    // The procedure ran (some downstream outcome), NOT an INVALID_INPUT
    // adapter error — the Date conversion satisfied z.date().
    expect(body.result?.structuredContent).not.toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
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
  expiresAt: PAT_EXPIRES,
};
const PAT_WITHOUT_CLI = { ...PAT_WITH_CLI, allowCliCommands: false };
const OAUTH_CREDENTIAL = { kind: "oauth" as const };

type ListedCredential =
  | {
      kind: "pat";
      tokenId: string;
      allowCliCommands: boolean;
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
  });

  it("tells the model that other secrets in command output are NOT redacted", async () => {
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
    expect(run?.description).toContain("NOT redacted");
    expect(
      (run as { annotations?: { destructiveHint?: boolean } } | undefined)?.annotations
        ?.destructiveHint,
    ).toBe(true);
    expect(resultTool?.description).toContain("NOT redacted");
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
    ["grant_disabled", "CLI commands are disabled for this device"],
    ["offline", "CLI is offline or does not support this protocol"],
    ["feature_disabled", "CLI has MCP commands disabled in wsmp config"],
    ["limit", "too many commands"],
    [
      "invalid_command",
      "command and cwd must be well-formed Unicode text (no unpaired surrogates), 1..=4096 UTF-8 bytes, and contain no NUL",
    ],
    [
      "token_inactive",
      "This MCP token was revoked, has expired, or no longer allows CLI commands (mcp:write and CLI commands are required)",
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
