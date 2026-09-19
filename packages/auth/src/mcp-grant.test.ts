import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock Prisma at the module boundary like the other server-side suites —
// these tests must never touch a real database.
const mcpGrantTable = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@ws-model-proxy/db", () => ({
  default: { mcpGrant: mcpGrantTable },
}));

// mcp-grant reads no env at module load (the secret is always an explicit
// argument), but the transitive mcp-config import validates env — keep the
// same minimal mock the sibling suites use.
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://proxy.example.com",
    CORS_ORIGIN: undefined,
    BETTER_AUTH_SECRET: "test-secret",
  },
}));

import {
  createMcpPostLoginOptions,
  deriveMcpConsentReferenceId,
  isMcpGrantGenerationTombstoned,
  issueMcpGrantClaims,
  MCP_CONSENT_REFERENCE_LENGTH,
  MCP_GRANT_ID_CLAIM,
  McpGrantError,
  resolveMcpGrantDecision,
} from "./mcp-grant";

const SECRET = "unit-test-secret";
const USER = "user_1";
const CLIENT = "https://client.example.com";
const SESSION = "session_1";
const REFERENCE = deriveMcpConsentReferenceId({
  secret: SECRET,
  sessionId: SESSION,
  clientId: CLIENT,
});

function grantRow(overrides: Partial<{ id: string; revokedAt: Date | null }> = {}) {
  return {
    id: overrides.id ?? "grant_1",
    userId: USER,
    clientId: CLIENT,
    referenceId: REFERENCE,
    revokedAt: overrides.revokedAt ?? null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("deriveMcpConsentReferenceId", () => {
  it("is deterministic for the same secret/session/client", () => {
    const a = deriveMcpConsentReferenceId({ secret: SECRET, sessionId: SESSION, clientId: CLIENT });
    const b = deriveMcpConsentReferenceId({ secret: SECRET, sessionId: SESSION, clientId: CLIENT });
    expect(a).toBe(b);
  });

  it("is fixed-length lowercase hex", () => {
    const reference = deriveMcpConsentReferenceId({
      secret: SECRET,
      sessionId: SESSION,
      clientId: CLIENT,
    });
    expect(reference).toHaveLength(MCP_CONSENT_REFERENCE_LENGTH);
    expect(reference).toMatch(/^[0-9a-f]+$/);
  });

  it("binds to the session ID and the client ID", () => {
    const base = deriveMcpConsentReferenceId({
      secret: SECRET,
      sessionId: SESSION,
      clientId: CLIENT,
    });
    expect(
      deriveMcpConsentReferenceId({ secret: SECRET, sessionId: "session_2", clientId: CLIENT }),
    ).not.toBe(base);
    expect(
      deriveMcpConsentReferenceId({
        secret: SECRET,
        sessionId: SESSION,
        clientId: "https://other.example.com",
      }),
    ).not.toBe(base);
  });

  it("is keyed by the secret", () => {
    expect(
      deriveMcpConsentReferenceId({ secret: "other-secret", sessionId: SESSION, clientId: CLIENT }),
    ).not.toBe(REFERENCE);
  });
});

describe("resolveMcpGrantDecision (pure decision logic)", () => {
  it("authorization_code: creates when absent", () => {
    expect(
      resolveMcpGrantDecision({
        grantType: "authorization_code",
        userId: USER,
        referenceId: REFERENCE,
        existing: null,
      }),
    ).toEqual({ action: "create" });
  });

  it("authorization_code: reuses when active", () => {
    const grant = grantRow();
    expect(
      resolveMcpGrantDecision({
        grantType: "authorization_code",
        userId: USER,
        referenceId: REFERENCE,
        existing: grant,
      }),
    ).toEqual({ action: "reuse", grant });
  });

  it("authorization_code: rejects an existing tombstone", () => {
    expect(
      resolveMcpGrantDecision({
        grantType: "authorization_code",
        userId: USER,
        referenceId: REFERENCE,
        existing: grantRow({ revokedAt: new Date("2026-01-01T00:00:00Z") }),
      }),
    ).toEqual({ action: "reject", reason: "tombstone" });
  });

  it("refresh_token: requires the exact existing grant to be active", () => {
    const grant = grantRow();
    expect(
      resolveMcpGrantDecision({
        grantType: "refresh_token",
        userId: USER,
        referenceId: REFERENCE,
        existing: grant,
      }),
    ).toEqual({ action: "reuse", grant });
  });

  it("refresh_token: rejects when the grant is missing", () => {
    expect(
      resolveMcpGrantDecision({
        grantType: "refresh_token",
        userId: USER,
        referenceId: REFERENCE,
        existing: null,
      }),
    ).toEqual({ action: "reject", reason: "inactive-on-refresh" });
  });

  it("refresh_token: rejects a tombstoned grant", () => {
    expect(
      resolveMcpGrantDecision({
        grantType: "refresh_token",
        userId: USER,
        referenceId: REFERENCE,
        existing: grantRow({ revokedAt: new Date("2026-01-01T00:00:00Z") }),
      }),
    ).toEqual({ action: "reject", reason: "tombstone" });
  });

  it("fails closed without a user or a derivable reference", () => {
    expect(
      resolveMcpGrantDecision({
        grantType: "authorization_code",
        userId: undefined,
        referenceId: REFERENCE,
        existing: null,
      }),
    ).toEqual({ action: "reject", reason: "missing-user" });
    expect(
      resolveMcpGrantDecision({
        grantType: "authorization_code",
        userId: USER,
        referenceId: undefined,
        existing: null,
      }),
    ).toEqual({ action: "reject", reason: "missing-session" });
  });
});

describe("issueMcpGrantClaims (Prisma-backed)", () => {
  const codeInput = {
    grantType: "authorization_code",
    userId: USER,
    clientId: CLIENT,
    referenceId: REFERENCE,
    sessionId: SESSION,
    secret: SECRET,
  };

  it("creates the grant when absent and stamps mcp_grant_id; create data never touches revokedAt", async () => {
    mcpGrantTable.findUnique.mockResolvedValue(null);
    mcpGrantTable.create.mockResolvedValue(grantRow());

    const claims = await issueMcpGrantClaims(codeInput);

    expect(claims).toEqual({ [MCP_GRANT_ID_CLAIM]: "grant_1" });
    expect(mcpGrantTable.findUnique).toHaveBeenCalledWith({
      where: {
        userId_clientId_referenceId: { userId: USER, clientId: CLIENT, referenceId: REFERENCE },
      },
      select: expect.anything(),
    });
    expect(mcpGrantTable.create).toHaveBeenCalledTimes(1);
    const createCall = mcpGrantTable.create.mock.calls[0];
    expect(createCall).toBeDefined();
    const createArgs = createCall![0] as { data: Record<string, unknown> };
    expect(createArgs.data).toEqual({ userId: USER, clientId: CLIENT, referenceId: REFERENCE });
    expect("revokedAt" in createArgs.data).toBe(false);
  });

  it("reuses the active grant without any write (never clears revokedAt)", async () => {
    mcpGrantTable.findUnique.mockResolvedValue(grantRow());

    const claims = await issueMcpGrantClaims(codeInput);

    expect(claims).toEqual({ [MCP_GRANT_ID_CLAIM]: "grant_1" });
    expect(mcpGrantTable.create).not.toHaveBeenCalled();
  });

  it("rejects a tombstoned grant on authorization-code exchange", async () => {
    mcpGrantTable.findUnique.mockResolvedValue(
      grantRow({ revokedAt: new Date("2026-01-01T00:00:00Z") }),
    );

    await expect(issueMcpGrantClaims(codeInput)).rejects.toBeInstanceOf(McpGrantError);
    expect(mcpGrantTable.create).not.toHaveBeenCalled();
  });

  it("requires the exact active grant on refresh", async () => {
    mcpGrantTable.findUnique.mockResolvedValue(grantRow());
    await expect(
      issueMcpGrantClaims({ ...codeInput, grantType: "refresh_token" }),
    ).resolves.toEqual({ [MCP_GRANT_ID_CLAIM]: "grant_1" });

    mcpGrantTable.findUnique.mockResolvedValue(null);
    await expect(
      issueMcpGrantClaims({ ...codeInput, grantType: "refresh_token" }),
    ).rejects.toBeInstanceOf(McpGrantError);
    expect(mcpGrantTable.create).not.toHaveBeenCalled();
  });

  it("refresh-after-logout: referenceId alone (sessionId undefined or null) still reuses the exact grant", async () => {
    mcpGrantTable.findUnique.mockResolvedValue(grantRow());
    await expect(
      issueMcpGrantClaims({ ...codeInput, grantType: "refresh_token", sessionId: undefined }),
    ).resolves.toEqual({ [MCP_GRANT_ID_CLAIM]: "grant_1" });
    await expect(
      issueMcpGrantClaims({ ...codeInput, grantType: "refresh_token", sessionId: null }),
    ).resolves.toEqual({ [MCP_GRANT_ID_CLAIM]: "grant_1" });
    expect(mcpGrantTable.findUnique).toHaveBeenCalledWith({
      where: {
        userId_clientId_referenceId: { userId: USER, clientId: CLIENT, referenceId: REFERENCE },
      },
      select: expect.anything(),
    });
  });

  it("authorization_code without referenceId falls back to the session-derived HMAC (mint path only)", async () => {
    mcpGrantTable.findUnique.mockResolvedValue(null);
    mcpGrantTable.create.mockResolvedValue(grantRow());

    await expect(issueMcpGrantClaims({ ...codeInput, referenceId: undefined })).resolves.toEqual({
      [MCP_GRANT_ID_CLAIM]: "grant_1",
    });

    // The derived fallback equals the consent HMAC: lookup AND create keyed
    // by the derived reference.
    expect(mcpGrantTable.findUnique).toHaveBeenCalledWith({
      where: {
        userId_clientId_referenceId: { userId: USER, clientId: CLIENT, referenceId: REFERENCE },
      },
      select: expect.anything(),
    });
    const createCall = mcpGrantTable.create.mock.calls[0];
    expect(createCall).toBeDefined();
    const createArgs = createCall![0] as { data: Record<string, unknown> };
    expect(createArgs.data).toEqual({ userId: USER, clientId: CLIENT, referenceId: REFERENCE });
  });

  it("fails closed when neither referenceId nor a session is available (no sibling fallback)", async () => {
    await expect(
      issueMcpGrantClaims({ ...codeInput, referenceId: undefined, sessionId: undefined }),
    ).rejects.toBeInstanceOf(McpGrantError);
    expect(mcpGrantTable.findUnique).not.toHaveBeenCalled();
    expect(mcpGrantTable.findFirst).not.toHaveBeenCalled();
  });

  it("refresh without referenceId fails closed — session derivation is NOT a refresh fallback", async () => {
    await expect(
      issueMcpGrantClaims({
        ...codeInput,
        grantType: "refresh_token",
        referenceId: undefined,
        sessionId: SESSION,
      }),
    ).rejects.toBeInstanceOf(McpGrantError);
    expect(mcpGrantTable.findUnique).not.toHaveBeenCalled();
    expect(mcpGrantTable.findFirst).not.toHaveBeenCalled();
  });

  it("read-only path (grantType undefined): exact referenceId stamps the active grant, never creates", async () => {
    mcpGrantTable.findUnique.mockResolvedValue(grantRow());
    await expect(issueMcpGrantClaims({ ...codeInput, grantType: undefined })).resolves.toEqual({
      [MCP_GRANT_ID_CLAIM]: "grant_1",
    });
    expect(mcpGrantTable.create).not.toHaveBeenCalled();
  });

  it("read-only path: tombstoned exact reference REJECTS even when an active sibling generation exists", async () => {
    mcpGrantTable.findUnique.mockResolvedValue(
      grantRow({ revokedAt: new Date("2026-01-01T00:00:00Z") }),
    );
    // An active sibling for the same user/client exists and WOULD be found
    // by any-active-generation substitution — it must never be consulted.
    mcpGrantTable.findFirst.mockResolvedValue(grantRow({ id: "grant_2" }));
    const error = await issueMcpGrantClaims({ ...codeInput, grantType: undefined }).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(McpGrantError);
    expect(mcpGrantTable.findFirst).not.toHaveBeenCalled();
    expect(mcpGrantTable.create).not.toHaveBeenCalled();
  });

  it("read-only path without referenceId fails closed before any DB access", async () => {
    await expect(
      issueMcpGrantClaims({
        ...codeInput,
        grantType: undefined,
        referenceId: undefined,
        sessionId: undefined,
      }),
    ).rejects.toBeInstanceOf(McpGrantError);
    expect(mcpGrantTable.findUnique).not.toHaveBeenCalled();
    expect(mcpGrantTable.findFirst).not.toHaveBeenCalled();
  });

  describe("grant storage failure sanitization (invariant 10)", () => {
    const sentinelMessage = "sentinel-prisma-query-params-must-not-leak";
    const sentinel = new Error(sentinelMessage);

    function capturedConsole(): { lines: string[]; restore: () => void } {
      const lines: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      };
      return { lines, restore: () => (console.error = original) };
    }

    it("replaces a findUnique rejection with the generic storage failure and one sanitized line", async () => {
      mcpGrantTable.findUnique.mockRejectedValue(sentinel);
      const capture = capturedConsole();
      try {
        const error = await issueMcpGrantClaims(codeInput).catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(McpGrantError);
        expect((error as Error).message).toBe("MCP grant storage failure");
        expect((error as Error).message).not.toContain(sentinelMessage);
        expect(capture.lines).toHaveLength(1);
        expect(capture.lines[0]).toContain("[mcp-grant]");
        expect(capture.lines[0]).toContain("findGrantByReference");
        expect(capture.lines.join("\n")).not.toContain(sentinelMessage);
        // The original error object itself never escapes either.
        expect(error).not.toBe(sentinel);
      } finally {
        capture.restore();
      }
    });

    it("replaces a create rejection with the generic storage failure and one sanitized line", async () => {
      mcpGrantTable.findUnique.mockResolvedValue(null);
      mcpGrantTable.create.mockRejectedValue(sentinel);
      const capture = capturedConsole();
      try {
        const error = await issueMcpGrantClaims(codeInput).catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBe(sentinel);
        expect((error as Error).message).toBe("MCP grant storage failure");
        expect(capture.lines).toHaveLength(1);
        expect(capture.lines[0]).toContain("[mcp-grant]");
        expect(capture.lines[0]).toContain("createMcpGrant");
        expect(capture.lines.join("\n")).not.toContain(sentinelMessage);
      } finally {
        capture.restore();
      }
    });
  });
});

describe("createMcpPostLoginOptions", () => {
  const postLogin = createMcpPostLoginOptions({ secret: SECRET, loginPage: "/en-US/mcp-login" });

  it("configures page + both callbacks together", () => {
    expect(postLogin.page).toBe("/en-US/mcp-login");
    expect(typeof postLogin.consentReferenceId).toBe("function");
    expect(typeof postLogin.shouldRedirect).toBe("function");
  });

  it("consentReferenceId fails closed when the OAuth state is underivable (no request context)", async () => {
    // Outside a Better Auth authorize/consent request the request-local
    // signed-query store is empty — the callback must throw, not return a
    // reference derived from unvalidated input.
    await expect(postLogin.consentReferenceId({ session: { id: SESSION } })).rejects.toThrow(
      /consent reference unavailable/i,
    );
  });

  it("consentReferenceId fails closed without a session even though state may exist", async () => {
    await expect(postLogin.consentReferenceId({})).rejects.toThrow(
      /consent reference unavailable/i,
    );
  });

  it("shouldRedirect returns false when the reference is underivable", async () => {
    await expect(
      postLogin.shouldRedirect({ user: { id: USER }, session: { id: SESSION } }),
    ).resolves.toBe(false);
    // Underivable state short-circuits before any lookup.
    expect(mcpGrantTable.findUnique).not.toHaveBeenCalled();
  });
});

describe("isMcpGrantGenerationTombstoned (shouldRedirect decision)", () => {
  it("redirects exactly when the exact generation is tombstoned", async () => {
    mcpGrantTable.findUnique.mockResolvedValue(
      grantRow({ revokedAt: new Date("2026-01-01T00:00:00Z") }),
    );
    await expect(
      isMcpGrantGenerationTombstoned({ userId: USER, clientId: CLIENT, referenceId: REFERENCE }),
    ).resolves.toBe(true);

    mcpGrantTable.findUnique.mockResolvedValue(grantRow());
    await expect(
      isMcpGrantGenerationTombstoned({ userId: USER, clientId: CLIENT, referenceId: REFERENCE }),
    ).resolves.toBe(false);

    mcpGrantTable.findUnique.mockResolvedValue(null);
    await expect(
      isMcpGrantGenerationTombstoned({ userId: USER, clientId: CLIENT, referenceId: REFERENCE }),
    ).resolves.toBe(false);
  });
});
