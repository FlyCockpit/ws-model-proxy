import { canonicalMcpResource } from "@ws-model-proxy/auth/mcp-config";
import { type Context, Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(() => ({
  WMP_MCP_ENABLED: false,
  BETTER_AUTH_URL: "https://proxy.example.com",
}));

vi.mock("@ws-model-proxy/env/server", () => ({ env: mockEnv }));

const {
  inspectAuthorizeRequest,
  invalidAuthorizeRequestResponse,
  invalidAuthorizeScopeResponse,
  invalidAuthorizeTargetResponse,
  mcpAuthorizeScopeGuard,
  requestedResourcesIncludeCanonical,
} = await import("./mcp-authorize-scope-guard");

const AUTHORIZE = "/api/auth/oauth2/authorize";
const BASE = "https://proxy.example.com";
const CANONICAL = canonicalMcpResource(BASE);
const CANONICAL_PARAM = encodeURIComponent(CANONICAL);
const FOREIGN = "https://foreign.example.com/mcp";
const FOREIGN_PARAM = encodeURIComponent(FOREIGN);
const FORM = "application/x-www-form-urlencoded";
const HYBRID_JSON = "application/json+application/x-www-form-urlencoded";
const inspect = (request: Request) => inspectAuthorizeRequest(request, BASE);

interface DownstreamCapture {
  url: string;
  method: string;
  contentType: string | null;
  body: string;
}

function buildApp() {
  const app = new Hono();
  const downstream = vi.fn(async (c: Context) => {
    const raw = c.req.raw;
    captured = {
      url: raw.url,
      method: raw.method,
      contentType: raw.headers.get("content-type"),
      body: raw.method === "GET" || raw.method === "HEAD" ? "" : await raw.text(),
    };
    return new Response("downstream", { status: 200 });
  });
  let captured: DownstreamCapture | null = null;
  app.use(AUTHORIZE, mcpAuthorizeScopeGuard);
  app.on(["POST", "GET"], AUTHORIZE, downstream);
  return { app, downstream, getCaptured: () => captured };
}

beforeEach(() => {
  mockEnv.WMP_MCP_ENABLED = false;
});

describe("mcpAuthorizeScopeGuard (flag on)", () => {
  beforeEach(() => {
    mockEnv.WMP_MCP_ENABLED = true;
  });

  // ------------------------------------------------------------------
  // scope: missing / blank — local, non-redirecting invalid_scope.
  // ------------------------------------------------------------------

  it("rejects a GET without scope locally, without redirecting", async () => {
    const { app, downstream } = buildApp();
    const res = await app.request(
      `${AUTHORIZE}?resource=${CANONICAL_PARAM}&client_id=abc&redirect_uri=https://c.example/cb`,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      error: "invalid_scope",
      error_description: expect.stringContaining("scope"),
    });
    expect(res.headers.get("location")).toBeNull();
    expect(downstream).not.toHaveBeenCalled();
  });

  it("rejects a GET with a blank (spaces-only) scope", async () => {
    const { app, downstream } = buildApp();
    const res = await app.request(`${AUTHORIZE}?scope=%20%20&resource=${CANONICAL_PARAM}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_scope" });
    expect(downstream).not.toHaveBeenCalled();
  });

  it("HEAD without scope is NOT judged (not-applicable → forwarded)", async () => {
    // L18 (pass 5): the provider registers GET/POST only — better-call
    // findRoute 404s HEAD — so the guard must never be broader than the
    // route it fronts. (Real-handler parity: HEAD → downstream 404, pinned
    // in mcp-authorize-parity.test.ts.)
    const { app, downstream, getCaptured } = buildApp();
    const res = await app.request(`${AUTHORIZE}?resource=${CANONICAL_PARAM}`, {
      method: "HEAD",
    });
    expect(res.status).toBe(200); // stub downstream answered
    expect(downstream).toHaveBeenCalled();
    expect(getCaptured()?.method).toBe("HEAD");
  });

  it("rejects a form-encoded POST with a missing scope without consuming the original body", async () => {
    const { app, downstream } = buildApp();
    const res = await app.request(AUTHORIZE, {
      method: "POST",
      headers: { "content-type": FORM },
      body: `resource=${CANONICAL_PARAM}&client_id=abc&redirect_uri=https%3A%2F%2Fc.example%2Fcb`,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_scope" });
    expect(downstream).not.toHaveBeenCalled();
  });

  it("rejects a form-encoded POST with a blank scope (charset param still form-admissible)", async () => {
    const { app } = buildApp();
    const res = await app.request(AUTHORIZE, {
      method: "POST",
      headers: { "content-type": `${FORM}; charset=utf-8` },
      body: `scope=+++&resource=${CANONICAL_PARAM}&client_id=abc`,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_scope" });
  });

  // ------------------------------------------------------------------
  // L18 — last-value-per-key parsing on the form path (better-call
  // formData().forEach object-assign parity).
  // ------------------------------------------------------------------

  it("L18: repeated form scope keys — LAST value wins (blank last → local invalid_scope)", async () => {
    const { app } = buildApp();
    const res = await app.request(AUTHORIZE, {
      method: "POST",
      headers: { "content-type": FORM },
      body: `scope=mcp:read&scope=+++&resource=${CANONICAL_PARAM}`,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_scope" });
  });

  it("L18: repeated form scope keys — blank first, present LAST → forwarded", async () => {
    const { app, getCaptured } = buildApp();
    const body = `scope=&scope=mcp:read&resource=${CANONICAL_PARAM}`;
    const res = await app.request(AUTHORIZE, {
      method: "POST",
      headers: { "content-type": FORM },
      body,
    });
    expect(res.status).toBe(200);
    expect(getCaptured()?.body).toBe(body);
  });

  it("L18: BOM-prefixed \\uFEFFscope form key is NOT scope (absent → local invalid_scope)", async () => {
    const { app, downstream } = buildApp();
    const res = await app.request(AUTHORIZE, {
      method: "POST",
      headers: { "content-type": FORM },
      body:
        "\uFEFF" +
        `scope=mcp:read&resource=${CANONICAL_PARAM}&client_id=abc&redirect_uri=https%3A%2F%2Fc.example%2Fcb`,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_scope" });
    expect(downstream).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // L16 — resource membership per the pinned downstream shape semantics.
  // ------------------------------------------------------------------

  it("L16: rejects a GET with no resource parameter (local invalid_target, no redirect)", async () => {
    const { app, downstream } = buildApp();
    const res = await app.request(`${AUTHORIZE}?scope=mcp:read&client_id=abc`);
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      error: "invalid_target",
      error_description: expect.stringContaining("resource"),
    });
    expect(res.headers.get("location")).toBeNull();
    expect(downstream).not.toHaveBeenCalled();
  });

  it("L16: rejects a blank (spaces-only) single resource value on GET (unsplit membership)", async () => {
    const { app, downstream } = buildApp();
    const res = await app.request(`${AUTHORIZE}?scope=mcp:read&resource=%20%20`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_target" });
    expect(downstream).not.toHaveBeenCalled();
  });

  it("L16: single GET resource occurrence is judged UNSPLIT — canonical+foreign in one value fails", async () => {
    const { app, downstream } = buildApp();
    const res = await app.request(
      `${AUTHORIZE}?scope=mcp:read&resource=${CANONICAL_PARAM}%20${FOREIGN_PARAM}`,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_target" });
    expect(downstream).not.toHaveBeenCalled();
  });

  it("L16: MULTIPLE GET resource occurrences are membership across ALL — canonical anywhere passes", async () => {
    const { app, getCaptured } = buildApp();
    const url = `${AUTHORIZE}?scope=mcp:read&resource=${FOREIGN_PARAM}&resource=${CANONICAL_PARAM}`;
    const res = await app.request(url);
    expect(res.status).toBe(200);
    expect(getCaptured()?.url).toBe(new URL(url, "http://localhost").href);
  });

  it("L16: multiple GET resource occurrences without canonical → local invalid_target", async () => {
    const { app } = buildApp();
    const res = await app.request(
      `${AUTHORIZE}?scope=mcp:read&resource=${FOREIGN_PARAM}&resource=${encodeURIComponent("https://other.example.com/mcp")}`,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_target" });
  });

  it("L16: form resource — LAST occurrence ONLY (foreign last → local invalid_target)", async () => {
    const { app, downstream } = buildApp();
    const res = await app.request(AUTHORIZE, {
      method: "POST",
      headers: { "content-type": FORM },
      body: `scope=mcp:read&resource=${CANONICAL_PARAM}&resource=${FOREIGN_PARAM}`,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_target" });
    expect(downstream).not.toHaveBeenCalled();
  });

  it("L16: form resource — canonical LAST → forwarded byte-identical", async () => {
    const { app, getCaptured } = buildApp();
    const body = `scope=mcp:read mcp:write&resource=${FOREIGN_PARAM}&resource=${CANONICAL_PARAM}&code_challenge=x`;
    const res = await app.request(AUTHORIZE, {
      method: "POST",
      headers: { "content-type": FORM },
      body,
    });
    expect(res.status).toBe(200);
    expect(getCaptured()?.body).toBe(body);
  });

  it("L16: form resource is never space-split — `R R` with canonical as one token still fails", async () => {
    const { app } = buildApp();
    const res = await app.request(AUTHORIZE, {
      method: "POST",
      headers: { "content-type": FORM },
      body: `scope=mcp:read&resource=${CANONICAL_PARAM}%20${FOREIGN_PARAM}`,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_target" });
  });

  it("L16: BOM-prefixed \\uFEFFresource form key is NOT resource (absent → local invalid_target)", async () => {
    const { app, downstream } = buildApp();
    const res = await app.request(AUTHORIZE, {
      method: "POST",
      headers: { "content-type": FORM },
      body:
        "\uFEFF" +
        `resource=${CANONICAL_PARAM}&scope=mcp:read&client_id=abc&redirect_uri=https%3A%2F%2Fc.example%2Fcb`,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_target" });
    expect(downstream).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------
  // GET duplicate scope → forwarded (downstream owns "must not appear
  // more than once"); GET duplicate resource → membership.
  // ------------------------------------------------------------------

  it("forwards a GET with DUPLICATE scope occurrences unchanged (downstream invalid_request)", async () => {
    const { app, getCaptured } = buildApp();
    const url = `${AUTHORIZE}?scope=mcp:read&scope=%20%20&resource=${CANONICAL_PARAM}`;
    const res = await app.request(url);
    expect(res.status).toBe(200);
    expect(getCaptured()?.url).toBe(new URL(url, "http://localhost").href);
  });

  // ------------------------------------------------------------------
  // Applicability — better-call getBody allowlist parity.
  // ------------------------------------------------------------------

  it("forwards a GET with a present scope and canonical resource unchanged (identical URL to downstream)", async () => {
    const { app, getCaptured } = buildApp();
    const url = `${AUTHORIZE}?scope=mcp:read+offline_access&resource=${CANONICAL_PARAM}&client_id=abc&state=xyz`;
    const res = await app.request(url, { headers: { accept: "text/html" } });
    expect(res.status).toBe(200);
    const captured = getCaptured();
    expect(captured?.url).toBe(new URL(url, "http://localhost").href);
    expect(captured?.method).toBe("GET");
  });

  it("forwards a form-encoded POST with a present scope/resource without consuming its body", async () => {
    const { app, getCaptured } = buildApp();
    const body = `scope=mcp:read mcp:write&resource=${CANONICAL_PARAM}&client_id=abc&code_challenge=x`;
    const res = await app.request(AUTHORIZE, {
      method: "POST",
      headers: { "content-type": FORM },
      body,
    });
    expect(res.status).toBe(200);
    const captured = getCaptured();
    expect(captured?.body).toBe(body);
    expect(captured?.contentType).toBe(FORM);
    expect(captured?.method).toBe("POST");
  });

  it("forwards non-admissible POST bodies untouched for Better Auth to answer (415)", async () => {
    const { app, getCaptured } = buildApp();
    for (const contentType of [
      "application/json",
      "multipart/form-data",
      "text/plain",
      "application/xml",
    ]) {
      const res = await app.request(AUTHORIZE, {
        method: "POST",
        headers: { "content-type": contentType },
        body: JSON.stringify({ scope: "" }),
      });
      expect(res.status, contentType).toBe(200);
      expect(getCaptured()?.body).toBe(JSON.stringify({ scope: "" }));
    }
    const missing = await app.request(AUTHORIZE, { method: "POST", body: "scope=" });
    expect(missing.status).toBe(200);
  });

  it("is scoped to the authorize path (other auth paths untouched)", async () => {
    const app = new Hono();
    const downstream = vi.fn((c: Context) => new Response(`ok:${c.req.path}`));
    app.use("/api/auth/*", mcpAuthorizeScopeGuard);
    app.on(["POST", "GET"], "/api/auth/*", downstream);
    const res = await app.request("/api/auth/sign-in/email", { method: "POST" });
    expect(res.status).toBe(200);
    expect(downstream).toHaveBeenCalledTimes(1);
  });

  // ------------------------------------------------------------------
  // L18 (pass 4) — RAW-pathname applicability: better-call routes on the
  // raw (still percent-encoded) pathname; Hono's c.req.path DECODES
  // unreserved triples like %61, which made the guard judge requests that
  // downstream 404s. Encoded forms must SKIP the guard entirely.
  // ------------------------------------------------------------------

  it.each([
    ["/api/auth/oauth2/%61uthorize", "leading %61 for 'a'"],
    ["/api/auth/oauth2/authoriz%65", "trailing %65 for 'e'"],
  ])(
    "RAW-pathname SKIP: %s (missing scope) reaches downstream, not a local 400 (%s)",
    async (path) => {
      const { app, downstream } = buildApp();
      const res = await app.request(`${path}?client_id=abc`);
      // These two decode to the route for Hono's matching, so the guard RUNS
      // and must skip on the raw pathname: the request is forwarded verbatim
      // (downstream better-call 404s on the raw pathname — asserted against
      // the real handler in mcp-authorize-parity.test.ts).
      expect(res.status).toBe(200);
      expect(downstream).toHaveBeenCalledTimes(1);
      expect(await res.text()).toBe("downstream");
    },
  );

  it.each([
    ["/API/auth/oauth2/authorize", "uppercase path"],
    ["/api/auth/oauth2/authorize/", "trailing slash"],
    ["/api/auth/oauth2/authorize%20", "trailing %20"],
    ["/api/auth/oauth2/%2futhorize", "encoded slash"],
    ["/api/auth//oauth2/authorize", "double slash"],
    ["/api/auth/oauth2/author+ize", "plus sign"],
    ["/api/auth/oauth2/authoriz%C3%A9", "multibyte"],
  ])(
    "RAW-pathname SKIP (unchanged shapes): %s is never a local guard rejection (%s)",
    async (path) => {
      const { app } = buildApp();
      const res = await app.request(`${path}?client_id=abc`);
      // None of these equal the literal authorize path on EITHER the decoded
      // or the raw pathname, so the guard must not answer — Hono itself may
      // 404 (route unmatched) or forward; both are acceptable, a local 400
      // invalid_scope/invalid_target is not.
      expect([200, 404]).toContain(res.status);
      expect(res.headers.get("location")).toBeNull();
      if (res.status === 400) {
        expect(await res.json()).not.toMatchObject({ error: "invalid_scope" });
      }
    },
  );

  it("plain (unencoded) authorize path is still guarded", async () => {
    const { app, downstream } = buildApp();
    const res = await app.request(`${AUTHORIZE}?client_id=abc`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_scope" });
    expect(downstream).not.toHaveBeenCalled();
  });
});

describe("mcpAuthorizeScopeGuard (flag off — pure pass-through)", () => {
  it("forwards a missing-scope AND missing-resource GET untouched (guard inactive)", async () => {
    const { app, downstream, getCaptured } = buildApp();
    const res = await app.request(`${AUTHORIZE}?client_id=abc`);
    expect(res.status).toBe(200);
    expect(downstream).toHaveBeenCalledTimes(1);
    expect(getCaptured()?.method).toBe("GET");
  });

  it("forwards a blank-scope, foreign-resource form POST untouched and byte-identical", async () => {
    const { app, getCaptured } = buildApp();
    const body = `scope=%20&resource=${FOREIGN_PARAM}&client_id=abc`;
    const res = await app.request(AUTHORIZE, {
      method: "POST",
      headers: { "content-type": FORM },
      body,
    });
    expect(res.status).toBe(200);
    expect(getCaptured()?.body).toBe(body);
  });
});

describe("inspectAuthorizeRequest (unit — pinned downstream semantics)", () => {
  const url = (query: string) => new URL(`https://server.example${AUTHORIZE}${query}`);
  const post = (contentType: string | null, body: string, method = "POST") =>
    new Request(url(""), {
      method,
      headers: contentType ? { "content-type": contentType } : {},
      body,
    });

  it("GET: absent/blank single scope → invalid-scope; present → judged on resource", async () => {
    expect(await inspect(new Request(url(`?resource=${CANONICAL_PARAM}`)))).toBe("invalid-scope");
    expect(await inspect(new Request(url(`?scope=%20&resource=${CANONICAL_PARAM}`)))).toBe(
      "invalid-scope",
    );
    expect(await inspect(new Request(url(`?scope=mcp:read&resource=${CANONICAL_PARAM}`)))).toBe(
      "forward",
    );
  });

  it("GET: duplicate scope → forward; duplicate resource → membership across all", async () => {
    expect(
      await inspect(new Request(url(`?scope=mcp:read&scope=%20&resource=${CANONICAL_PARAM}`))),
    ).toBe("forward");
    expect(
      await inspect(
        new Request(url(`?scope=mcp:read&resource=${FOREIGN_PARAM}&resource=${CANONICAL_PARAM}`)),
      ),
    ).toBe("forward");
    expect(
      await inspect(
        new Request(
          url(
            `?scope=mcp:read&resource=${FOREIGN_PARAM}&resource=${encodeURIComponent("https://other.example.com/mcp")}`,
          ),
        ),
      ),
    ).toBe("invalid-target");
  });

  it("GET: single resource occurrence judged unsplit", async () => {
    expect(await inspect(new Request(url(`?scope=mcp:read&resource=${CANONICAL_PARAM}%20x`)))).toBe(
      "invalid-target",
    );
    expect(await inspect(new Request(url(`?scope=mcp:read&resource=%20`)))).toBe("invalid-target");
  });

  it("POST form: last-value-per-key for scope and resource; no space-splitting", async () => {
    expect(await inspect(post(FORM, `scope=mcp:read&resource=${CANONICAL_PARAM}`))).toBe("forward");
    expect(await inspect(post(FORM, `client_id=x`))).toBe("invalid-scope");
    expect(
      await inspect(post(FORM, `scope=mcp:read&resource=${CANONICAL_PARAM}%20${FOREIGN_PARAM}`)),
    ).toBe("invalid-target");
    expect(
      await inspect(
        post(FORM, `scope=mcp:read&resource=${FOREIGN_PARAM}&resource=${CANONICAL_PARAM}`),
      ),
    ).toBe("forward");
    expect(
      await inspect(
        post(FORM, `scope=mcp:read&resource=${CANONICAL_PARAM}&resource=${FOREIGN_PARAM}`),
      ),
    ).toBe("invalid-target");
  });

  it("POST form: BOM-prefixed keys are not the parameter (downstream parity)", async () => {
    expect(await inspect(post(FORM, `\uFEFFscope=mcp:read&resource=${CANONICAL_PARAM}`))).toBe(
      "invalid-scope",
    );
    expect(await inspect(post(FORM, `\uFEFFresource=${CANONICAL_PARAM}&scope=mcp:read`))).toBe(
      "invalid-target",
    );
  });

  it("POST JSON branch (hybrid content types): scope/resource per pinned object semantics", async () => {
    const json = (body: unknown, contentType = HYBRID_JSON) =>
      inspect(post(contentType, JSON.stringify(body)));
    expect(await json({ scope: "mcp:read", resource: CANONICAL })).toBe("forward");
    expect(await json({ resource: CANONICAL })).toBe("invalid-scope");
    expect(await json({ scope: "  ", resource: CANONICAL })).toBe("invalid-scope");
    expect(await json({ scope: "mcp:read" })).toBe("invalid-target");
    expect(await json({ scope: "mcp:read", resource: FOREIGN })).toBe("invalid-target");
    expect(await json({ scope: "mcp:read", resource: [FOREIGN, CANONICAL] })).toBe("forward");
    expect(await json({ scope: "mcp:read", resource: [FOREIGN] })).toBe("invalid-target");
    expect(await json({ scope: ["mcp:read"], resource: CANONICAL })).toBe("forward");
    expect(await json({ scope: "mcp:read", resource: 42 })).toBe("forward");
    expect(await json("not-an-object")).toBe("forward");
    expect(await json(null)).toBe("forward");
  });

  it("POST: hybrid family admitted — `+json` suffix and charset params", async () => {
    expect(
      await inspect(
        post(
          "application/x-www-form-urlencoded+json",
          JSON.stringify({ scope: "mcp:read", resource: CANONICAL }),
        ),
      ),
    ).toBe("forward");
    expect(
      await inspect(
        post(
          "application/x-www-form-urlencoded; charset=utf-8",
          `scope=mcp:read&resource=${CANONICAL_PARAM}`,
        ),
      ),
    ).toBe("forward");
    expect(
      await inspect(post("application/vnd.x+json+application/x-www-form-urlencoded", "null")),
    ).toBe("forward");
  });

  it("POST: non-admissible content types and other methods are not applicable", async () => {
    for (const contentType of [
      "application/json",
      "application/json; charset=utf-8",
      "multipart/form-data",
      "text/plain",
    ]) {
      expect(await inspect(post(contentType, "scope=")), contentType).toBe("not-applicable");
    }
    expect(await inspect(post(null, "scope="))).toBe("not-applicable");
    // Admissibility is an INCLUDES match on the base, but undici refuses to
    // form-parse exotic non-`+` suffixes — the guard judges that LOCALLY
    // (invalid_request) instead of forwarding (downstream formData() would
    // throw the same TypeError as a non-APIError → 500 + raw-TypeError log).
    expect(await inspect(post("application/x-www-form-urlencoded-json", "scope="))).toBe(
      "invalid-request",
    );
    expect(
      await inspect(
        new Request(url(""), {
          method: "PUT",
          headers: { "content-type": FORM },
          body: `scope=mcp:read&resource=${CANONICAL_PARAM}`,
        }),
      ),
    ).toBe("not-applicable");
  });

  it("POST: form-admissible but unform-parseable bodies are LOCAL invalid_request (text/ hybrid)", async () => {
    // `text/application/x-www-form-urlencoded` passes the substring
    // allowlist; undici refuses to form-parse it (probe-verified against
    // the installed runtime). Local 400 invalid_request — never forwarded.
    expect(
      await inspect(
        post(
          "text/application/x-www-form-urlencoded",
          `scope=mcp:read&resource=${CANONICAL_PARAM}`,
        ),
      ),
    ).toBe("invalid-request");
    expect(
      await inspect(post("text/application/x-www-form-urlencoded", "not-a-form-body=\xff\xfe")),
    ).toBe("invalid-request");
  });

  it("POST: JSON-branch malformed bodies STAY forwarded (downstream SyntaxError → APIError 400)", async () => {
    expect(await inspect(post(HYBRID_JSON, "{not json"))).toBe("not-applicable");
  });

  it("middleware: form-parse failure → local 400 invalid_request, non-redirecting, downstream untouched", async () => {
    // This describe defaults the flag OFF; enable it for this middleware
    // assertion (the outer beforeEach resets it for the neighbors).
    mockEnv.WMP_MCP_ENABLED = true;
    const { app, downstream } = buildApp();
    const res = await app.request(AUTHORIZE, {
      method: "POST",
      headers: { "content-type": "text/application/x-www-form-urlencoded" },
      body: `scope=mcp:read&resource=${CANONICAL_PARAM}`,
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
    expect(downstream).not.toHaveBeenCalled();
  });

  it("does not consume the inspected request's body", async () => {
    const body = `scope=mcp:read&resource=${CANONICAL_PARAM}`;
    const request = post(FORM, body);
    await inspect(request);
    // The ORIGINAL body is still readable exactly once downstream.
    expect(await request.text()).toBe(body);
  });

  it("requestedResourcesIncludeCanonical is membership across the list", () => {
    expect(requestedResourcesIncludeCanonical([FOREIGN, CANONICAL], BASE)).toBe(true);
    expect(requestedResourcesIncludeCanonical([CANONICAL], BASE)).toBe(true);
    expect(requestedResourcesIncludeCanonical([FOREIGN], BASE)).toBe(false);
    expect(requestedResourcesIncludeCanonical([], BASE)).toBe(false);
  });

  it("invalidAuthorizeScopeResponse / invalidTarget / invalidRequest are proper RFC 6749 error responses", () => {
    const bodies = [
      invalidAuthorizeScopeResponse(),
      invalidAuthorizeTargetResponse(),
      invalidAuthorizeRequestResponse(),
    ];
    for (const res of bodies) {
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("location")).toBeNull();
    }
  });
});
