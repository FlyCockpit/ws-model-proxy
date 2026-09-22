import { describe, expect, it } from "vitest";
import { mcpInsufficientScopeResponse, mcpResourceMetadataUrl } from "./errors";

/**
 * Pinning tests for the exported 403 insufficient_scope challenge builder.
 * `mcpInsufficientScopeResponse` is exported specifically so this challenge
 * contract is pinned by tests (see its docblock): the header shape mirrors
 * the installed upstream challenge builder — RFC 6750 §3.1 `insufficient_scope`
 * with a `scope` attribute, plus the RFC 9728 `resource_metadata` pointer —
 * and the body is the shared authorization-layer JSON-RPC error grammar.
 */

const RESOURCE = "https://proxy.example.com/mcp";
const METADATA = "https://proxy.example.com/.well-known/oauth-protected-resource/mcp";

describe("mcpInsufficientScopeResponse", () => {
  it("403 with the exact Bearer insufficient_scope challenge (error, scope, resource_metadata, error_description)", () => {
    const res = mcpInsufficientScopeResponse({
      requiredScopes: ["mcp:write"],
      resourceUrl: RESOURCE,
      description: "This action requires the mcp:write scope.",
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer error="insufficient_scope", scope="mcp:write", ` +
        `resource_metadata="${METADATA}", ` +
        `error_description="This action requires the mcp:write scope."`,
    );
  });

  it("body is the authorization-layer JSON-RPC error grammar (code -32000, id null)", async () => {
    const res = mcpInsufficientScopeResponse({
      requiredScopes: ["mcp:write"],
      resourceUrl: RESOURCE,
      description: "write scope missing",
    });
    expect(await res.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Forbidden" },
      id: null,
    });
  });

  it("deduplicates the required scopes into the challenge's scope attribute", () => {
    const res = mcpInsufficientScopeResponse({
      requiredScopes: ["mcp:write", "mcp:write"],
      resourceUrl: RESOURCE,
      description: "write scope missing",
    });
    expect(res.headers.get("www-authenticate")).toContain('scope="mcp:write"');
  });

  it("escapes quotes/backslashes in the description (quoted-string safe)", () => {
    const res = mcpInsufficientScopeResponse({
      requiredScopes: ["mcp:write"],
      resourceUrl: RESOURCE,
      description: 'a "quoted \\ backslash" description',
    });
    const challenge = res.headers.get("www-authenticate") ?? "";
    // The quoted-string attribute is escaped, never able to break out.
    expect(challenge).toContain('error_description="a \\"quoted \\\\ backslash\\" description"');
  });

  it("truncates an over-long description to the 120-character bound", () => {
    const long = "x".repeat(300);
    const res = mcpInsufficientScopeResponse({
      requiredScopes: ["mcp:write"],
      resourceUrl: RESOURCE,
      description: long,
    });
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain(`error_description="${"x".repeat(120)}"`);
    expect(challenge).not.toContain(`error_description="${"x".repeat(121)}"`);
  });

  it("derives resource_metadata exactly like the upstream builder (path-preserving)", () => {
    // The shared derivation helper is exercised through the challenge: the
    // pointer keeps the resource path (`/mcp`); a trailing slash on the
    // resource URL is normalized away, never doubled.
    expect(mcpResourceMetadataUrl(RESOURCE)).toBe(METADATA);
    const res = mcpInsufficientScopeResponse({
      requiredScopes: ["mcp:write"],
      resourceUrl: "https://proxy.example.com/mcp/",
      description: "write scope missing",
    });
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${METADATA}"`);
  });
});
