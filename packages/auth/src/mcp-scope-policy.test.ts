import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { makeSignature } from "better-auth/crypto";
import { describe, expect, it, vi } from "vitest";
import { MCP_FINE_SCOPES, MCP_REMOVED_WRITE_DESCRIPTION } from "./agent-scopes";
import { MCP_RESOURCE_SCOPES, MCP_SCOPES } from "./mcp-config";
import { resolveMcpPlugins } from "./mcp-plugins";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://proxy.example.test",
    BETTER_AUTH_SECRET: "scope-policy-test-secret-at-least-thirty-two-characters",
    CORS_ORIGIN: undefined,
  },
}));
vi.mock("@ws-model-proxy/db", () => ({
  default: { mcpGrant: { findUnique: vi.fn(async () => null) } },
}));

const metadata = vi.hoisted(() => ({ scope: "mcp:read" }));
vi.mock("@better-auth/cimd/node", () => ({
  fetchClientMetadataResource: vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          client_id: "https://client.example.test/metadata.json",
          client_name: "Fixture client",
          redirect_uris: ["https://client.example.test/callback"],
          token_endpoint_auth_method: "none",
          scope: metadata.scope,
        }),
        { headers: { "content-type": "application/json" } },
      ),
  ),
}));

const secret = "scope-policy-test-secret-at-least-thirty-two-characters";

function fixture() {
  const memory: Record<string, Record<string, unknown>[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
    oauthClient: [],
    oauthResource: [],
    oauthClientResource: [],
    oauthAccessToken: [],
    oauthRefreshToken: [],
    oauthConsent: [],
  };
  const auth = betterAuth({
    baseURL: "https://proxy.example.test",
    secret,
    database: memoryAdapter(memory),
    plugins: resolveMcpPlugins({ enabled: true, baseUrl: "https://proxy.example.test" }),
    emailAndPassword: { enabled: true },
    advanced: { disableOriginCheck: true },
    logger: { disabled: true },
  });
  return {
    auth,
    memory,
    request: (path: string, init: RequestInit) =>
      auth.handler(new Request(`https://proxy.example.test/api/auth/oauth2/${path}`, init)),
  };
}
const registration = {
  redirect_uris: ["https://client.example.test/callback"],
  token_endpoint_auth_method: "none",
};

/** Simulate still-valid, pre-upgrade browser state signed with the server secret. */
async function signedQuery(clientId: string, scope: string) {
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: registration.redirect_uris[0] ?? "",
    response_type: "code",
    scope,
    resource: "https://proxy.example.test/mcp",
    code_challenge: "challenge",
    code_challenge_method: "S256",
    exp: String(Math.floor(Date.now() / 1000) + 600),
  });
  query.sort();
  query.set("sig", await makeSignature(query.toString(), secret));
  return query.toString();
}

describe("OAuth scope policy through the real provider", () => {
  it.each(["mcp:write", "mcp:read  mcp:write offline_access", " mcp:write "])(
    "DCR rejects removed scope tokens: %s",
    async (scope) => {
      const { request, memory } = fixture();
      const response = await request("register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...registration, scope }),
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
      expect(await response.json()).toMatchObject({
        error: "invalid_scope",
        error_description: MCP_REMOVED_WRITE_DESCRIPTION,
      });
      expect(memory.oauthClient).toHaveLength(0);
    },
  );

  it.each([
    "mcp:read",
    "mcp:read mcp:files",
    "mcp:files mcp:read offline_access mcp:files mcp:read",
    `mcp:read ${MCP_FINE_SCOPES.join(" ")} offline_access`,
  ])("DCR stores and returns precisely the requested scope set: %s", async (scope) => {
    const { request, memory } = fixture();
    const response = await request("register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...registration, scope }),
    });
    expect(response.status).toBe(201);
    const scopes = [...new Set(scope.split(" "))];
    expect(await response.json()).toMatchObject({ scope: scopes.join(" ") });
    expect(memory.oauthClient?.[0]?.scopes).toEqual(scopes);
    expect(memory.oauthClient?.[0]?.tokenEndpointAuthMethod).toBe("none");
    expect(memory.oauthClientResource).toHaveLength(1);
  });

  it.each([undefined, "", "   ", "\t \r\n"])(
    "DCR without a scope subset retains the full registration ceiling: %j",
    async (scope) => {
      const { request, memory } = fixture();
      const response = await request("register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...registration, scope }),
      });
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({ scope: MCP_SCOPES.join(" ") });
      expect(memory.oauthClient?.[0]?.scopes).toEqual([...MCP_SCOPES]);
      expect(memory.oauthClientResource).toHaveLength(1);
    },
  );

  it("DCR without scope can follow the /mcp challenge scopes through to consent", async () => {
    const { auth, request, memory } = fixture();
    const response = await request("register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(registration),
    });
    expect(response.status).toBe(201);
    const client = (await response.json()) as { client_id: string };
    const signup = await auth.api.signUpEmail({
      body: { email: "person@example.test", name: "Person", password: "fixture-password-123" },
      asResponse: true,
    });
    const cookie = signup.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(cookie).not.toBe("");
    const query = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: registration.redirect_uris[0] ?? "",
      response_type: "code",
      scope: MCP_RESOURCE_SCOPES.join(" "),
      resource: "https://proxy.example.test/mcp",
      code_challenge: "challenge",
      code_challenge_method: "S256",
    });
    const authorize = await request(`authorize?${query}`, {
      method: "GET",
      headers: { cookie },
    });
    expect(authorize.status).toBe(302);
    const consent = new URL(authorize.headers.get("location") ?? "", "https://proxy.example.test");
    expect(consent.pathname).toBe("/en-US/mcp-consent");
    expect(consent.searchParams.has("error")).toBe(false);
    expect(consent.searchParams.get("scope")).toBe(MCP_RESOURCE_SCOPES.join(" "));
    expect(memory.oauthConsent).toHaveLength(0);
    expect(memory.oauthAccessToken).toHaveLength(0);
  });

  it.each([
    ["none", "null"],
    ["none", "throw"],
    ["client_secret_basic", "null"],
    ["client_secret_basic", "throw"],
  ])("DCR narrowing failure rolls back registration (%s, %s)", async (method, failure) => {
    const { auth, request, memory } = fixture();
    // Keep an unrelated client/link to prove cleanup is scoped to the failed registration.
    const first = await request("register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...registration, scope: "mcp:read" }),
    });
    const existing = (await first.json()) as { client_id: string };
    const context = await auth.$context;
    const update = vi.spyOn(context.adapter, "update").mockImplementationOnce(async () => {
      expect(memory.oauthClient).toHaveLength(2);
      expect(memory.oauthClientResource).toHaveLength(2);
      if (failure === "throw") throw new Error("Injected scope update failure");
      return null;
    });
    const response = await request("register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...registration,
        token_endpoint_auth_method: method,
        scope: "mcp:read",
      }),
    });
    expect(update).toHaveBeenCalledOnce();
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBeNull();
    expect(await response.json()).toEqual({
      error: "server_error",
      error_description: "Client registration could not be finalized.",
    });
    expect(memory.oauthClient).toHaveLength(1);
    expect(memory.oauthClient?.[0]?.clientId).toBe(existing.client_id);
    expect(memory.oauthClientResource).toHaveLength(1);
    expect(memory.oauthClientResource?.[0]?.clientId).toBe(existing.client_id);
  });

  it.each([
    ["consent", { accept: true }],
    ["consent", { accept: true, scope: "mcp:read" }],
    ["continue", { selected: true }],
    ["continue", { created: true }],
    ["continue", { postLogin: true }],
  ])("%s refuses a pre-upgrade signed query before issuing a code: %j", async (path, approval) => {
    const { auth, request, memory } = fixture();
    const registered = await request("register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...registration, scope: "mcp:read" }),
    });
    const client = (await registered.json()) as { client_id: string };
    const signup = await auth.api.signUpEmail({
      body: { email: "person@example.test", name: "Person", password: "fixture-password-123" },
      asResponse: true,
    });
    const cookie = signup.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(cookie).not.toBe("");
    const response = await request(path, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        ...approval,
        oauth_query: await signedQuery(client.client_id, "mcp:read mcp:write"),
      }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).toBeNull();
    expect(await response.json()).toMatchObject({
      error: "invalid_scope",
      error_description: MCP_REMOVED_WRITE_DESCRIPTION,
    });
    expect(memory.oauthConsent).toHaveLength(0);
    expect(memory.verification).toHaveLength(0);
    expect(memory.oauthAccessToken).toHaveLength(0);
  });

  it("signed query signature verification still runs before the removed-scope guard", async () => {
    const { request } = fixture();
    const query = new URLSearchParams(await signedQuery("fixture-client", "mcp:read"));
    query.set("scope", "mcp:read mcp:write");
    const response = await request("consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accept: true, oauth_query: query.toString() }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_signature" });
  });

  it.each(["sign-in/email", "sign-up/email", "sign-in/social"])(
    "%s cannot resume authorization from an old signed query",
    async (path) => {
      const { auth, memory } = fixture();
      const response = await auth.handler(
        new Request(`https://proxy.example.test/api/auth/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: "person@example.test",
            password: "fixture-password-123",
            name: "Person",
            provider: "github",
            oauth_query: await signedQuery("fixture-client", "mcp:read mcp:write"),
          }),
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "invalid_scope",
        error_description: MCP_REMOVED_WRITE_DESCRIPTION,
      });
      expect(memory.user).toHaveLength(0);
      expect(memory.session).toHaveLength(0);
      expect(memory.verification).toHaveLength(0);
    },
  );

  it("authorize also checks removed scopes when invoked without the server's HTTP guard", async () => {
    const { request, memory } = fixture();
    const query = new URLSearchParams({ scope: "mcp:read mcp:write" });
    const response = await request(`authorize?${query}`, { method: "GET" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_scope",
      error_description: MCP_REMOVED_WRITE_DESCRIPTION,
    });
    expect(memory.verification).toHaveLength(0);
  });

  it.each(["MCP:WRITE", "mcp:write:extra", "mcp:write\textra"])(
    "signed query guard matches only the exact removed scope token: %s",
    async (scope) => {
      const { request } = fixture();
      const response = await request("continue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selected: true, oauth_query: await signedQuery("fixture", scope) }),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).not.toMatchObject({
        error_description: MCP_REMOVED_WRITE_DESCRIPTION,
      });
    },
  );

  it("token forms reject removed scopes with JSON 400", async () => {
    const contentType = "application/x-www-form-urlencoded";
    const { request } = fixture();
    const body = {
      grant_type: "refresh_token",
      client_id: "test",
      refresh_token: "fixture",
      scope: "mcp:read mcp:write",
    };
    const response = await request("token", {
      method: "POST",
      headers: { "content-type": contentType },
      body: new URLSearchParams(body),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_scope",
      error_description: MCP_REMOVED_WRITE_DESCRIPTION,
    });
  });

  it("token JSON keeps the provider's unsupported-media-type refusal", async () => {
    const { request } = fixture();
    const response = await request("token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", scope: "mcp:write" }),
    });
    expect(response.status).toBe(415);
  });

  it("CIMD metadata cannot register the removed scope", async () => {
    metadata.scope = "mcp:read mcp:write";
    const { request, memory } = fixture();
    const params = new URLSearchParams({
      client_id: "https://client.example.test/metadata.json",
      redirect_uri: "https://client.example.test/callback",
      response_type: "code",
      scope: "mcp:read",
      resource: "https://proxy.example.test/mcp",
      code_challenge: "challenge",
      code_challenge_method: "S256",
    });
    const response = await request(`authorize?${params}`, { method: "GET" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_scope",
      error_description: MCP_REMOVED_WRITE_DESCRIPTION,
    });
    expect(memory.oauthClient).toHaveLength(0);
  });

  it("token form parsing uses the last scope occurrence", async () => {
    const { request } = fixture();
    for (const [first, last, removed] of [
      ["mcp:read", "mcp:write", true],
      ["mcp:write", "mcp:read", false],
    ] as const) {
      const response = await request("token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `grant_type=refresh_token&client_id=test&refresh_token=fixture&scope=${first}&scope=${last}`,
      });
      const json = (await response.json()) as { error_description?: string };
      expect(json.error_description === MCP_REMOVED_WRITE_DESCRIPTION).toBe(removed);
    }
  });
});
