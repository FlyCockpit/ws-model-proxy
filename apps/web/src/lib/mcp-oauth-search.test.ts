import { describe, expect, it } from "vitest";
import {
  explainableMcpScopes,
  MCP_REAUTH_STATUS_QUERY_KEY,
  mcpPreloginClientQueryKey,
  mcpReauthStatusQueryKey,
  mcpSearchFingerprint,
  parseMcpOAuthSearch,
  resolveOauthRedirectUrl,
  toMcpPublicClientInfo,
} from "./mcp-oauth-search";

describe("parseMcpOAuthSearch", () => {
  it("extracts client id, scopes, and signature presence", () => {
    const info = parseMcpOAuthSearch({
      client_id: "client-1",
      scope: "mcp:read offline_access mcp:read",
      sig: "abc",
      state: "xyz",
    });
    expect(info.clientId).toBe("client-1");
    expect(info.scopes).toEqual(["mcp:read", "offline_access"]);
    expect(info.hasSignedQuery).toBe(true);
    expect(info.usable).toBe(true);
  });

  it("is unusable without a client id", () => {
    expect(parseMcpOAuthSearch({ sig: "abc" }).usable).toBe(false);
    expect(parseMcpOAuthSearch({ client_id: "", sig: "abc" }).usable).toBe(false);
    expect(parseMcpOAuthSearch({ client_id: 42, sig: "abc" }).usable).toBe(false);
  });

  it("is unusable without the sig signature parameter", () => {
    expect(parseMcpOAuthSearch({ client_id: "client-1" }).usable).toBe(false);
    expect(parseMcpOAuthSearch({ client_id: "client-1", sig: "" }).usable).toBe(false);
    expect(parseMcpOAuthSearch({ client_id: "client-1", sig: [""] }).usable).toBe(false);
    expect(parseMcpOAuthSearch({ client_id: "client-1", sig: ["ok"] }).usable).toBe(true);
  });
});

describe("resolveOauthRedirectUrl", () => {
  it("accepts only redirect === true with a nonempty string url", () => {
    expect(resolveOauthRedirectUrl({ redirect: true, url: "https://app.example/cb" })).toBe(
      "https://app.example/cb",
    );
  });

  it("rejects every other shape", () => {
    expect(resolveOauthRedirectUrl(null)).toBeNull();
    expect(resolveOauthRedirectUrl(undefined)).toBeNull();
    expect(resolveOauthRedirectUrl("https://app.example/cb")).toBeNull();
    expect(resolveOauthRedirectUrl({})).toBeNull();
    expect(resolveOauthRedirectUrl({ redirect: false, url: "https://app.example/cb" })).toBeNull();
    expect(resolveOauthRedirectUrl({ redirect: true })).toBeNull();
    expect(resolveOauthRedirectUrl({ redirect: true, url: "" })).toBeNull();
    expect(resolveOauthRedirectUrl({ redirect: true, url: 7 })).toBeNull();
    expect(resolveOauthRedirectUrl({ redirect: "true", url: "https://app.example/cb" })).toBeNull();
  });
});

describe("explainableMcpScopes", () => {
  it("maps the three MCP scopes and flags unknown tokens", () => {
    expect(explainableMcpScopes(["mcp:read", "mcp:write", "offline_access"])).toEqual([
      { raw: "mcp:read", key: "read" },
      { raw: "mcp:write", key: "write" },
      { raw: "offline_access", key: "offline_access" },
    ]);
    expect(explainableMcpScopes(["admin:everything"])).toEqual([
      { raw: "admin:everything", key: null },
    ]);
  });
});

describe("toMcpPublicClientInfo", () => {
  // REAL wire shape (installed @better-auth/oauth-provider@1.7.3 dist,
  // authorize-9whjxVLJ.mjs): getClientPublicEndpoint (:2303-2322) returns
  // schemaToOAuth output (:2237-2256) whose display fields are snake_case —
  // client_id / client_name / client_uri / logo_uri (+ contacts / tos_uri /
  // policy_uri). The previous camelCase fixtures were circular (they fed the
  // implementation's invented shape back to itself).
  it("projects the REAL snake_case wire shape (client_id/client_name/client_uri) and drops logo_uri", () => {
    expect(
      toMcpPublicClientInfo({
        client_id: "client-1",
        client_name: "Example Client",
        client_uri: "https://client.example",
        logo_uri: "https://client.example/logo.png",
        contacts: ["a@example.com"],
        tos_uri: "https://client.example/tos",
        policy_uri: "https://client.example/policy",
      }),
    ).toEqual({ clientId: "client-1", name: "Example Client", uri: "https://client.example" });
  });

  it("projects the REAL wire shape when optional fields are absent (schemaToOAuth ?? void 0)", () => {
    // name/uri/icon are nullable on the client row; schemaToOAuth emits
    // undefined for them — the projection must degrade to null gracefully.
    expect(toMcpPublicClientInfo({ client_id: "c" })).toEqual({
      clientId: "c",
      name: null,
      uri: null,
    });
    expect(toMcpPublicClientInfo({ client_id: "c", client_name: "", client_uri: 7 })).toEqual({
      clientId: "c",
      name: null,
      uri: null,
    });
  });

  it("requires a client id and rejects non-object payloads", () => {
    expect(toMcpPublicClientInfo({ client_name: "No Id" })).toBeNull();
    expect(toMcpPublicClientInfo(null)).toBeNull();
  });

  it("tolerates the camelCase spelling as defense in depth against client-shape drift", () => {
    expect(toMcpPublicClientInfo({ clientId: "c1", name: "N", uri: "https://u" })).toEqual({
      clientId: "c1",
      name: "N",
      uri: "https://u",
    });
    // snake_case wins when both spellings are present.
    expect(
      toMcpPublicClientInfo({ client_id: "c2", clientId: "wrong", client_name: "Right" }),
    ).toEqual({ clientId: "c2", name: "Right", uri: null });
  });
});

describe("mcpSearchFingerprint + query keys (R83/R84 F5)", () => {
  it("distinguishes different signed transactions and is stable per URL", () => {
    const a = mcpSearchFingerprint({ client_id: "c", sig: "s1", state: "x" });
    const aAgain = mcpSearchFingerprint({ state: "x", sig: "s1", client_id: "c" });
    const b = mcpSearchFingerprint({ client_id: "c", sig: "s2", state: "x" });
    expect(a).toBe(aAgain); // key order must not matter
    expect(a).not.toBe(b); // a different transaction is a different fingerprint
  });

  it("reauth keys bind session AND transaction; prelogin keys bind the transaction", () => {
    // The session part is the SESSION id (R85/R86 N1): same user with a
    // replaced session → different grant generation → different key.
    const sessionA = mcpReauthStatusQueryKey("session-a", "c", "f1");
    const sessionB = mcpReauthStatusQueryKey("session-b", "c", "f1");
    const txB = mcpReauthStatusQueryKey("session-a", "c", "f2");
    expect(sessionA).not.toEqual(sessionB);
    expect(sessionA).not.toEqual(txB);
    expect(mcpPreloginClientQueryKey("c", "f1")).not.toEqual(mcpPreloginClientQueryKey("c", "f2"));
    // Every reauth key shares the invalidatable prefix.
    for (const key of [sessionA, sessionB, txB]) {
      expect(key[0]).toBe(MCP_REAUTH_STATUS_QUERY_KEY);
    }
  });
});
