import { describe, expect, it } from "vitest";
import {
  explainableMcpScopes,
  MCP_REAUTH_STATUS_QUERY_KEY,
  mcpPreloginClientQueryKey,
  mcpReauthStatusQueryKey,
  mcpSearchFingerprint,
  parseMcpOAuthSearch,
  resolveOauthRedirectUrl,
  signedRedirectHost,
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
  // REAL wire shape (installed @better-auth/oauth-provider dist): getClientPublicEndpoint
  // returns schemaToOAuth output whose display fields are snake_case — client_id /
  // client_name / client_uri / logo_uri (+ contacts / tos_uri / policy_uri).
  it("projects the REAL snake_case wire shape and drops the self-declared client_uri and logo_uri", () => {
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
    ).toEqual({ clientId: "client-1", name: "Example Client" });
  });

  it("projects the REAL wire shape when optional fields are absent (schemaToOAuth ?? void 0)", () => {
    // name/uri/icon are nullable on the client row; schemaToOAuth emits
    // undefined for them — the projection must degrade to null gracefully.
    expect(toMcpPublicClientInfo({ client_id: "c" })).toEqual({ clientId: "c", name: null });
    expect(toMcpPublicClientInfo({ client_id: "c", client_name: "", client_uri: 7 })).toEqual({
      clientId: "c",
      name: null,
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
    });
    // snake_case wins when both spellings are present.
    expect(
      toMcpPublicClientInfo({ client_id: "c2", clientId: "wrong", client_name: "Right" }),
    ).toEqual({ clientId: "c2", name: "Right" });
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

describe("signedRedirectHost", () => {
  /** A signed query as the authorize endpoint writes it: every name listed in ba_param. */
  function signed(entries: Array<[string, string]>, extra: Array<[string, string]> = []) {
    const params = new URLSearchParams(entries);
    for (const name of [...new Set([...entries.map(([key]) => key), "ba_param"])].sort())
      params.append("ba_param", name);
    params.append("sig", "s1");
    for (const [key, value] of extra) params.append(key, value);
    return `?${params.toString()}`;
  }
  const base: Array<[string, string]> = [
    ["client_id", "c1"],
    ["scope", "mcp:read"],
  ];

  it("shows the host of the signed redirect_uri, port included", () => {
    expect(
      signedRedirectHost(signed([...base, ["redirect_uri", "https://app.example.com/cb?x=1"]])),
    ).toBe("app.example.com");
    expect(
      signedRedirectHost(signed([...base, ["redirect_uri", "http://127.0.0.1:33418/cb"]])),
    ).toBe("127.0.0.1:33418");
  });

  it("names an app scheme so an app link never passes for a website", () => {
    expect(signedRedirectHost(signed([...base, ["redirect_uri", "cursor://callback/mcp"]]))).toBe(
      "cursor://callback",
    );
    expect(signedRedirectHost(signed([...base, ["redirect_uri", "com.example.app:/cb"]]))).toBe(
      "com.example.app:",
    );
  });

  it("ignores an unsigned redirect_uri the URL carries (the client plugin never forwards it)", () => {
    expect(
      signedRedirectHost(signed(base, [["redirect_uri", "https://evil.example/cb"]])),
    ).toBeNull();
  });

  it("fails closed on a repeated, missing, unsigned-query or malformed redirect_uri", () => {
    expect(
      signedRedirectHost(
        signed([
          ...base,
          ["redirect_uri", "https://app.example.com/cb"],
          ["redirect_uri", "https://evil.example/cb"],
        ]),
      ),
    ).toBeNull();
    // Listed as signed, then a second copy appended.
    expect(
      signedRedirectHost(
        signed(
          [...base, ["redirect_uri", "https://app.example.com/cb"]],
          [["redirect_uri", "https://evil.example/cb"]],
        ),
      ),
    ).toBeNull();
    expect(signedRedirectHost(signed(base))).toBeNull();
    expect(
      signedRedirectHost("?client_id=c1&redirect_uri=https%3A%2F%2Fapp.example.com"),
    ).toBeNull();
    expect(signedRedirectHost(signed([...base, ["redirect_uri", "not a url"]]))).toBeNull();
    expect(signedRedirectHost("")).toBeNull();
  });
});
