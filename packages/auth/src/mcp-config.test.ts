import { beforeEach, describe, expect, it, vi } from "vitest";

// mcp-config binds its env-derived constants at module load, so mock the env
// module (same pattern as apps/server/src/client-ip.test.ts) with a mutable
// env object each test can tune before importing.
const mockEnv: {
  BETTER_AUTH_URL: string;
  CORS_ORIGIN: string | undefined;
} = {
  BETTER_AUTH_URL: "https://proxy.example.com",
  CORS_ORIGIN: undefined,
};
vi.mock("@ws-model-proxy/env/server", () => ({ env: mockEnv }));

const mcpConfig = await import("./mcp-config");
// Prove the "./mcp-config" subpath of this package's export map resolves to
// the same module (self-reference through package.json exports).
const viaSubpath = await import("@ws-model-proxy/auth/mcp-config");

describe("canonical URL derivation (invariant 1)", () => {
  it("derives the issuer from BETTER_AUTH_URL plus /api/auth", () => {
    expect(mcpConfig.canonicalMcpIssuer("https://proxy.example.com")).toBe(
      "https://proxy.example.com/api/auth",
    );
  });

  it("derives the resource from BETTER_AUTH_URL plus /mcp", () => {
    expect(mcpConfig.canonicalMcpResource("https://proxy.example.com")).toBe(
      "https://proxy.example.com/mcp",
    );
    expect(mcpConfig.canonicalMcpResource("http://localhost:3000")).toBe(
      "http://localhost:3000/mcp",
    );
  });

  it("replaces a root path instead of appending (URL-resolution semantics)", () => {
    // BETTER_AUTH_URL is validated origin-only, but the derivation must never
    // naively concatenate: new URL("/mcp", <any base>) always lands on /mcp.
    expect(mcpConfig.canonicalMcpResource("https://proxy.example.com/some/path")).toBe(
      "https://proxy.example.com/mcp",
    );
  });
});

describe("web origin resolution", () => {
  it("prefers CORS_ORIGIN when set (split-origin deploy)", () => {
    expect(
      mcpConfig.resolveMcpWebOrigin({
        corsOrigin: "https://app.example.com",
        baseUrl: "https://proxy.example.com",
      }),
    ).toBe("https://app.example.com");
  });

  it("falls back to BETTER_AUTH_URL (same-origin deploy)", () => {
    expect(
      mcpConfig.resolveMcpWebOrigin({
        corsOrigin: undefined,
        baseUrl: "https://proxy.example.com",
      }),
    ).toBe("https://proxy.example.com");
  });
});

describe("login/consent URLs", () => {
  it("builds locale-prefixed paths", () => {
    expect(mcpConfig.mcpLoginPagePath()).toBe("/en-US/mcp-login");
    expect(mcpConfig.mcpConsentPagePath()).toBe("/en-US/mcp-consent");
    expect(mcpConfig.mcpLoginPagePath("es-MX")).toBe("/es-MX/mcp-login");
    expect(mcpConfig.mcpConsentPagePath("es-MX")).toBe("/es-MX/mcp-consent");
  });

  it("builds absolute URLs on the configured web origin", () => {
    expect(mcpConfig.mcpLoginUrl("https://app.example.com")).toBe(
      "https://app.example.com/en-US/mcp-login",
    );
    expect(mcpConfig.mcpConsentUrl("https://app.example.com", "es-MX")).toBe(
      "https://app.example.com/es-MX/mcp-consent",
    );
  });
});

describe("env-bound constants", () => {
  beforeEach(() => {
    mockEnv.BETTER_AUTH_URL = "https://proxy.example.com";
    mockEnv.CORS_ORIGIN = undefined;
  });

  it("binds issuer/resource/web origin from BETTER_AUTH_URL (no CORS_ORIGIN)", async () => {
    vi.resetModules();
    const fresh = await import("./mcp-config");
    expect(fresh.MCP_ISSUER).toBe("https://proxy.example.com/api/auth");
    expect(fresh.MCP_RESOURCE_URL).toBe("https://proxy.example.com/mcp");
    expect(fresh.MCP_WEB_ORIGIN).toBe("https://proxy.example.com");
    expect(fresh.MCP_LOGIN_PAGE_URL).toBe("https://proxy.example.com/en-US/mcp-login");
    expect(fresh.MCP_CONSENT_PAGE_URL).toBe("https://proxy.example.com/en-US/mcp-consent");
  });

  it("binds the web origin to CORS_ORIGIN when set", async () => {
    mockEnv.CORS_ORIGIN = "https://app.example.com";
    vi.resetModules();
    const fresh = await import("./mcp-config");
    expect(fresh.MCP_WEB_ORIGIN).toBe("https://app.example.com");
    expect(fresh.MCP_LOGIN_PAGE_URL).toBe("https://app.example.com/en-US/mcp-login");
  });
});

describe("policy constants (Resolved defaults)", () => {
  it("keeps token lifetimes as named constants with the planned values", () => {
    expect(mcpConfig.MCP_ACCESS_TOKEN_LIFETIME_SECONDS).toBe(10 * 60);
    expect(mcpConfig.MCP_REFRESH_INACTIVITY_LIFETIME_SECONDS).toBe(72 * 60 * 60);
    expect(mcpConfig.MCP_REFRESH_RETRY_WINDOW_SECONDS).toBe(30);
  });

  it("pins CIMD-only registration to the 2026-07-28 profile with DCR off", () => {
    expect(mcpConfig.MCP_METADATA_PROFILE).toBe("mcp-2026-07-28");
    expect(mcpConfig.MCP_CIMD_REGISTRATION_POLICY).toEqual({
      metadataProfile: "mcp-2026-07-28",
      dynamicClientRegistration: false,
    });
  });

  it("keeps DPoP enabled but not required", () => {
    expect(mcpConfig.MCP_DPOP_POLICY).toEqual({ enabled: true, required: false });
  });

  it("lists the enabled scopes and registration ceilings", () => {
    expect(mcpConfig.MCP_SCOPES).toEqual(["mcp:read", "mcp:write", "offline_access"]);
    expect(mcpConfig.MCP_CLIENT_REGISTRATION_DEFAULT_SCOPES).toEqual([
      "mcp:read",
      "offline_access",
    ]);
    expect(mcpConfig.MCP_CLIENT_REGISTRATION_ALLOWED_EXTRA_SCOPES).toEqual(["mcp:write"]);
  });
});

describe("protected-resource scope matcher (invariant 9)", () => {
  it("satisfies the read baseline with either mcp:read or mcp:write", () => {
    expect(mcpConfig.mcpScopesAllow("mcp:read", "read")).toBe(true);
    expect(mcpConfig.mcpScopesAllow("mcp:write", "read")).toBe(true);
    expect(mcpConfig.mcpScopesAllow("mcp:read mcp:write", "read")).toBe(true);
  });

  it("requires literal mcp:write for write", () => {
    expect(mcpConfig.mcpScopesAllow("mcp:write", "write")).toBe(true);
    expect(mcpConfig.mcpScopesAllow("mcp:read", "write")).toBe(false);
    expect(mcpConfig.mcpScopesAllow("offline_access", "write")).toBe(false);
  });

  it("rejects missing, blank, unrelated, and superstring scopes", () => {
    expect(mcpConfig.mcpScopesAllow(undefined, "read")).toBe(false);
    expect(mcpConfig.mcpScopesAllow(null, "read")).toBe(false);
    expect(mcpConfig.mcpScopesAllow("", "read")).toBe(false);
    expect(mcpConfig.mcpScopesAllow("   ", "read")).toBe(false);
    expect(mcpConfig.mcpScopesAllow("profile", "read")).toBe(false);
    expect(mcpConfig.mcpScopesAllow("mcp:readonly", "read")).toBe(false);
  });

  it("requires exact literal tokens — no trimming, no case folding (space-only splitting)", () => {
    // Wrong case never grants.
    expect(mcpConfig.mcpScopesAllow("MCP:WRITE", "write")).toBe(false);
    // Padded tokens are literal, not trimmed into a match.
    expect(mcpConfig.mcpScopesAllow("mcp:write ", "write")).toBe(false);
    expect(mcpConfig.mcpScopesAllow(["mcp:write "], "write")).toBe(false);
    expect(mcpConfig.mcpScopesAllow([" mcp:write"], "write")).toBe(false);
    // Tab is NOT a separator — the token is "mcp:write\t", not "mcp:write".
    expect(mcpConfig.mcpScopesAllow("mcp:write\t", "write")).toBe(false);
    // Exact tokens in combination still grant...
    expect(mcpConfig.mcpScopesAllow("mcp:read mcp:write", "write")).toBe(true);
    // ...and repeated spaces merely produce empty tokens, which are ignored.
    expect(mcpConfig.mcpScopesAllow("mcp:read  mcp:write", "write")).toBe(true);
    // Array entries are used literally too.
    expect(mcpConfig.parseMcpScopes(["mcp:write "])).toEqual(["mcp:write "]);
    expect(mcpConfig.parseMcpScopes(["mcp:read", " mcp:read"])).toEqual(["mcp:read", " mcp:read"]);
  });

  it("parses space-separated and array scope claims, deduplicated", () => {
    expect(mcpConfig.parseMcpScopes("mcp:read  offline_access mcp:read")).toEqual([
      "mcp:read",
      "offline_access",
    ]);
    expect(mcpConfig.parseMcpScopes(["mcp:write", "mcp:write"])).toEqual(["mcp:write"]);
    expect(mcpConfig.parseMcpScopes(undefined)).toEqual([]);
  });
});

describe("export map", () => {
  it('resolves the "./mcp-config" subpath to this module', () => {
    expect(viaSubpath.canonicalMcpResource).toBe(mcpConfig.canonicalMcpResource);
    expect(viaSubpath.MCP_RESOURCE_URL).toBe(mcpConfig.MCP_RESOURCE_URL);
  });
});
