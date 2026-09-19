import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalMcpResource,
  MCP_ACCESS_TOKEN_LIFETIME_SECONDS,
  MCP_CLIENT_REGISTRATION_ALLOWED_EXTRA_SCOPES,
  MCP_CLIENT_REGISTRATION_DEFAULT_SCOPES,
  MCP_CONSENT_PAGE_PATH_DEFAULT,
  MCP_LOGIN_PAGE_PATH_DEFAULT,
  MCP_REFRESH_INACTIVITY_LIFETIME_SECONDS,
  MCP_REFRESH_RETRY_WINDOW_SECONDS,
  MCP_SCOPES,
} from "./mcp-config";
import { resolveMcpPlugins } from "./mcp-plugins";

// mcp-config binds env-derived constants at module load; give it a valid
// minimal env so the import does not run real env validation (the values are
// irrelevant — this suite passes baseUrl explicitly). vi.mock is hoisted
// above the imports by vitest. Phase 2 also needs BETTER_AUTH_SECRET (the
// consent-reference HMAC key) and a mocked Prisma (the grant integration).
vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://proxy.example.com",
    CORS_ORIGIN: undefined,
    BETTER_AUTH_SECRET: "test-secret",
  },
}));

vi.mock("@ws-model-proxy/db", () => ({
  default: {
    mcpGrant: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  },
}));

const httpsBase = "https://ws-model-proxy.example.com";

describe("resolveMcpPlugins (WMP_MCP_ENABLED decision)", () => {
  it("is empty while disabled so the plugin list stays exactly admin/twoFactor/deviceAuthorization", () => {
    expect(resolveMcpPlugins({ enabled: false, baseUrl: httpsBase })).toEqual([]);
  });

  it("adds exactly jwt (mcp/oauth-provider) and cimd when enabled", () => {
    const plugins = resolveMcpPlugins({ enabled: true, baseUrl: httpsBase });
    expect(plugins.map((plugin) => plugin.id)).toEqual(["jwt", "oauth-provider", "cimd"]);
  });

  it("binds the MCP resource to the canonical public origin plus /mcp", () => {
    const plugins = resolveMcpPlugins({
      enabled: true,
      baseUrl: httpsBase,
    });
    const jwtPlugin = plugins[0];
    // mcp() folds `resource` into the oauth-provider `resources` list and
    // pins it into client-registration defaults.
    const mcpPlugin = plugins.find((plugin) => plugin.id === "oauth-provider");
    expect(jwtPlugin?.id).toBe("jwt");
    expect(mcpPlugin && "options" in mcpPlugin ? mcpPlugin.options.resources : undefined).toContain(
      canonicalMcpResource(httpsBase),
    );
    expect(
      mcpPlugin && "options" in mcpPlugin
        ? mcpPlugin.options.clientRegistrationDefaultResources
        : undefined,
    ).toContain(canonicalMcpResource(httpsBase));
  });

  it("sources login/consent pages from mcp-config (default-locale paths)", () => {
    const plugins = resolveMcpPlugins({ enabled: true, baseUrl: httpsBase });
    const mcpPlugin = plugins.find((plugin) => plugin.id === "oauth-provider");
    const options = mcpPlugin && "options" in mcpPlugin ? mcpPlugin.options : undefined;
    expect(options?.loginPage).toBe(MCP_LOGIN_PAGE_PATH_DEFAULT);
    expect(options?.consentPage).toBe(MCP_CONSENT_PAGE_PATH_DEFAULT);
    expect(MCP_LOGIN_PAGE_PATH_DEFAULT).toBe("/en-US/mcp-login");
    expect(MCP_CONSENT_PAGE_PATH_DEFAULT).toBe("/en-US/mcp-consent");
  });

  it("keeps loopback HTTP dev origins usable (mcp validates loopback HTTP itself)", () => {
    const plugins = resolveMcpPlugins({
      enabled: true,
      baseUrl: "http://localhost:3000",
    });
    expect(plugins).toHaveLength(3);
    const mcpPlugin = plugins.find((plugin) => plugin.id === "oauth-provider");
    expect(mcpPlugin && "options" in mcpPlugin ? mcpPlugin.options.resources : undefined).toContain(
      canonicalMcpResource("http://localhost:3000"),
    );
  });

  it("pins the Phase 2 option set (scopes, ceilings, lifetimes, grants, DCR, resources, pages)", async () => {
    const plugins = resolveMcpPlugins({ enabled: true, baseUrl: httpsBase });
    const mcpPlugin = plugins.find((plugin) => plugin.id === "oauth-provider");
    const options = mcpPlugin && "options" in mcpPlugin ? mcpPlugin.options : undefined;
    expect(options).toBeDefined();

    // Scopes + registration ceilings: the effective registration capability
    // set is the union of defaults and allowed extras — exactly MCP_SCOPES,
    // so a CIMD client cannot register arbitrary capabilities. Note the
    // installed 1.7.3 mcp()/oauthProvider() factory NORMALIZES
    // `clientRegistrationAllowedScopes` to the persisted union (defaults ∪
    // extras) at construction, so the resolved option equals the full
    // ceiling even though the mcp-plugins input is the extras-only list.
    expect(options?.scopes).toEqual([...MCP_SCOPES]);
    expect(options?.clientRegistrationDefaultScopes).toEqual([
      ...MCP_CLIENT_REGISTRATION_DEFAULT_SCOPES,
    ]);
    expect([...(options?.clientRegistrationDefaultScopes ?? [])].sort()).toEqual(
      [...MCP_CLIENT_REGISTRATION_DEFAULT_SCOPES].sort(),
    );
    expect([...(options?.clientRegistrationAllowedScopes ?? [])].sort()).toEqual(
      [...MCP_SCOPES].sort(),
    );
    expect(
      [
        ...MCP_CLIENT_REGISTRATION_DEFAULT_SCOPES,
        ...MCP_CLIENT_REGISTRATION_ALLOWED_EXTRA_SCOPES,
      ].sort(),
    ).toEqual([...MCP_SCOPES].sort());

    // Lifetimes (mcp-config named constants).
    expect(options?.accessTokenExpiresIn).toBe(MCP_ACCESS_TOKEN_LIFETIME_SECONDS);
    expect(options?.accessTokenExpiresIn).toBe(600);
    expect(options?.refreshTokenExpiresIn).toBe(MCP_REFRESH_INACTIVITY_LIFETIME_SECONDS);
    expect(options?.refreshTokenExpiresIn).toBe(72 * 60 * 60);
    expect(options?.refreshTokenReuseInterval).toBe(MCP_REFRESH_RETRY_WINDOW_SECONDS);
    expect(options?.refreshTokenReuseInterval).toBe(30);

    // Grant types: user-bound only, never client_credentials.
    expect(options?.grantTypes).toEqual(["authorization_code", "refresh_token"]);

    // DCR disabled through BOTH registration controls.
    expect(options?.allowDynamicClientRegistration).toBe(false);
    expect(options?.allowUnauthenticatedClientRegistration).toBe(false);

    // PKCE policy + per-client resource enforcement.
    expect(options?.clientRegistrationRequirePKCE).toBe(true);
    expect(options?.enforcePerClientResources).toBe(true);

    // Canonical resource + localized pages.
    expect(options?.resources).toContain(canonicalMcpResource(httpsBase));
    expect(options?.loginPage).toBe(MCP_LOGIN_PAGE_PATH_DEFAULT);
    expect(options?.consentPage).toBe(MCP_CONSENT_PAGE_PATH_DEFAULT);
    expect(options?.postLogin?.page).toBe(MCP_LOGIN_PAGE_PATH_DEFAULT);

    // Privileges deny every user-facing client/resource CRUD action.
    for (const action of ["create", "read", "update", "delete", "list", "rotate"] as const) {
      expect(await options?.clientPrivileges?.({ headers: new Headers(), action })).toBe(false);
    }
    for (const action of [
      "create",
      "read",
      "update",
      "delete",
      "list",
      "link",
      "unlink",
    ] as const) {
      expect(await options?.resourcePrivileges?.({ headers: new Headers(), action })).toBe(false);
    }
  });

  it("wires the application-grant integration into postLogin + the access-token claims extension", () => {
    const plugins = resolveMcpPlugins({ enabled: true, baseUrl: httpsBase });
    const mcpPlugin = plugins.find((plugin) => plugin.id === "oauth-provider");
    const options = mcpPlugin && "options" in mcpPlugin ? mcpPlugin.options : undefined;

    // postLogin: page + consentReferenceId + shouldRedirect configured together.
    expect(typeof options?.postLogin?.consentReferenceId).toBe("function");
    expect(typeof options?.postLogin?.shouldRedirect).toBe("function");

    // Access-token claims extension (the oauth-provider extensions hook —
    // the installed 1.7.3 surface for additive access-token claims).
    const extension = options?.extensions?.[0];
    expect(extension).toBeDefined();
    expect(typeof extension?.claims?.accessToken).toBe("function");

    // No separate oauthProvider() plugin is composed alongside mcp().
    expect(plugins.filter((plugin) => plugin.id === "oauth-provider")).toHaveLength(1);
  });

  it("forwards the claims-hook referenceId (the durable consent HMAC) into the grant function", () => {
    // The hook input's referenceId IS the postLogin.consentReferenceId HMAC,
    // persisted on the consent/verification record and forwarded at code
    // exchange, refresh, and introspection. The adapter must pass it through
    // as the authoritative grant key (L17); the behavioral matrix for what
    // the grant function does with it lives in mcp-grant.test.ts.
    const source = readFileSync(new URL("./mcp-plugins.ts", import.meta.url), "utf8");
    expect(source).toContain("referenceId: input.referenceId");
    expect(source).toContain("referenceId?: string | undefined;");
    // Session derivation stays a MINT-path-only concern of the grant module;
    // the adapter forwards sessionId unchanged alongside referenceId.
    expect(source).toContain("sessionId: input.sessionId");
  });

  it("does not require DPoP globally on the MCP resource (no per-resource dpop requirement option)", () => {
    const plugins = resolveMcpPlugins({ enabled: true, baseUrl: httpsBase });
    const mcpPlugin = plugins.find((plugin) => plugin.id === "oauth-provider");
    const options = mcpPlugin && "options" in mcpPlugin ? mcpPlugin.options : undefined;
    // The resource is passed as the flat `resource` string (audience-bound,
    // advertised); no dpopBoundAccessTokensRequired pin exists anywhere in
    // the option set — DPoP stays opt-in per CIMD client metadata.
    const resourceRows = (options?.resources ?? []).filter(
      (entry): entry is { identifier: string; dpopBoundAccessTokensRequired?: boolean } =>
        typeof entry === "object" && entry !== null,
    );
    expect(resourceRows.some((row) => row.dpopBoundAccessTokensRequired)).toBe(false);
  });
});

describe("auth instance wiring", () => {
  it("spreads resolveMcpPlugins after the three always-on plugins, gated on env.WMP_MCP_ENABLED", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toContain("...resolveMcpPlugins({\n      enabled: env.WMP_MCP_ENABLED,");
    // The three always-on plugins stay ahead of the gated spread.
    const deviceIndex = source.indexOf("deviceAuthorization({");
    const spreadIndex = source.indexOf("...resolveMcpPlugins(");
    expect(deviceIndex).toBeGreaterThan(-1);
    expect(spreadIndex).toBeGreaterThan(deviceIndex);
  });
});
