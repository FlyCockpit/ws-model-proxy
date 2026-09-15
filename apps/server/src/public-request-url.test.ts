import { beforeEach, describe, expect, it, vi } from "vitest";

// Mutable env so each test can tune BETTER_AUTH_URL / CORS_ORIGIN before
// calling the helper (same pattern as client-ip.test.ts).
const mockEnv: {
  BETTER_AUTH_URL: string;
  CORS_ORIGIN: string | undefined;
} = {
  BETTER_AUTH_URL: "https://proxy.example.com",
  CORS_ORIGIN: undefined,
};
vi.mock("@ws-model-proxy/env/server", () => ({ env: mockEnv }));

const { cloneRequestOntoPublicOrigin, PublicRequestError, resolvePublicRequest } = await import(
  "./public-request-url.js"
);

const CANONICAL = "https://proxy.example.com";

function makeRequest(
  path: string,
  init: RequestInit & { host?: string; origin?: string } = {},
): Request {
  const { host, origin, ...rest } = init;
  const headers = new Headers(rest.headers);
  const rawAuthority = host ?? "proxy.example.com";
  if (host !== undefined) headers.set("host", host);
  if (origin !== undefined) headers.set("origin", origin);
  // The raw URL's scheme/host mirrors whatever the direct authority says; the
  // helper must only trust the validated Host + configured origin.
  return new Request(`https://${rawAuthority}${path}`, { ...rest, headers });
}

beforeEach(() => {
  mockEnv.BETTER_AUTH_URL = CANONICAL;
  mockEnv.CORS_ORIGIN = undefined;
});

describe("resolvePublicRequest — authority validation", () => {
  it("accepts TLS-termination-behind-a-proxy: canonical Host, ignores spoofed x-forwarded-*", () => {
    const request = makeRequest("/api/auth/oauth2/authorize?client_id=x", {
      host: "proxy.example.com",
    });
    request.headers.set("x-forwarded-host", "evil.example.com");
    request.headers.set("x-forwarded-proto", "http");
    const result = resolvePublicRequest(request);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.url).toBe(`${CANONICAL}/api/auth/oauth2/authorize?client_id=x`);
    // Spoofed forwarding values must not influence scheme or host...
    expect(result.url.startsWith("https://proxy.example.com/")).toBe(true);
    // ...and are dropped from the safe header set.
    expect(result.headers.get("x-forwarded-host")).toBeNull();
    expect(result.headers.get("x-forwarded-proto")).toBeNull();
    expect(result.headers.get("host")).toBe("proxy.example.com");
  });

  it("accepts a native request with no Origin when Host matches", () => {
    const result = resolvePublicRequest(makeRequest("/mcp", { host: "proxy.example.com" }));
    expect(result).toMatchObject({ ok: true, method: "GET" });
  });

  it("accepts a mixed-case Host (Host comparison is case-insensitive)", () => {
    const result = resolvePublicRequest(makeRequest("/mcp", { host: "PROXY.EXAMPLE.COM" }));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    // Canonical host (lowercase from BETTER_AUTH_URL) is what lands in the
    // safe header set and the canonical URL.
    expect(result.url).toBe(`${CANONICAL}/mcp`);
    expect(result.headers.get("host")).toBe("proxy.example.com");
  });

  it("rejects a non-canonical Host", () => {
    const result = resolvePublicRequest(makeRequest("/mcp", { host: "evil.example.com" }));
    expect(result).toEqual({ ok: false, reason: "host-not-allowed" });
  });

  it("rejects multiple Host headers (ambiguous authority)", () => {
    const request = makeRequest("/mcp");
    request.headers.append("host", "proxy.example.com");
    request.headers.append("host", "evil.example.com");
    const result = resolvePublicRequest(request);
    expect(result).toEqual({ ok: false, reason: "ambiguous-host" });
  });

  it("rejects a missing Host", () => {
    const request = makeRequest("/mcp");
    request.headers.delete("host");
    const result = resolvePublicRequest(request);
    expect(result).toEqual({ ok: false, reason: "missing-host" });
  });

  it("rejects a Host mismatch on port", () => {
    const result = resolvePublicRequest(makeRequest("/mcp", { host: "proxy.example.com:8443" }));
    expect(result).toEqual({ ok: false, reason: "host-not-allowed" });
  });
});

describe("resolvePublicRequest — raw URL form (authority-escape prevention)", () => {
  it("rejects a // path that would re-anchor the authority under re-resolution", () => {
    const result = resolvePublicRequest(
      makeRequest("//evil.example.com/mcp", { host: "proxy.example.com" }),
    );
    expect(result).toEqual({ ok: false, reason: "host-not-allowed" });
  });

  it("rejects a /// path", () => {
    const result = resolvePublicRequest(
      makeRequest("///evil.example.com/mcp", { host: "proxy.example.com" }),
    );
    expect(result).toEqual({ ok: false, reason: "host-not-allowed" });
  });

  it("rejects a backslash path (normalizes to // under special-URL parsing)", () => {
    const result = resolvePublicRequest(
      makeRequest("/\\evil.example.com/mcp", { host: "proxy.example.com" }),
    );
    expect(result).toEqual({ ok: false, reason: "host-not-allowed" });
  });

  it("rejects an absolute-form raw URL whose host conflicts with the validated Host", () => {
    const request = new Request("https://evil.example.com/mcp", {
      headers: { host: "proxy.example.com" },
    });
    const result = resolvePublicRequest(request);
    expect(result).toEqual({ ok: false, reason: "host-not-allowed" });
  });

  it("accepts an absolute-form raw URL whose host equals the validated Host (confined by concatenation)", () => {
    const request = new Request("https://proxy.example.com/mcp?cursor=2", {
      headers: { host: "proxy.example.com" },
    });
    const result = resolvePublicRequest(request);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    // Confined: the result is the canonical origin + raw path, never
    // re-resolved against the raw URL.
    expect(result.url).toBe(`${CANONICAL}/mcp?cursor=2`);
  });

  it("accepts an absolute-form raw URL with a differing scheme but matching host (TLS termination)", () => {
    const request = new Request("http://proxy.example.com/mcp", {
      headers: { host: "proxy.example.com" },
    });
    const result = resolvePublicRequest(request);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    // Scheme always comes from config, never from the raw URL or socket.
    expect(result.url.startsWith("https://proxy.example.com/")).toBe(true);
  });

  it("derives the scheme from config when BETTER_AUTH_URL is http (loopback dev)", () => {
    mockEnv.BETTER_AUTH_URL = "http://localhost:3000";
    const result = resolvePublicRequest(makeRequest("/mcp", { host: "localhost:3000" }));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.url).toBe("http://localhost:3000/mcp");
    expect(result.headers.get("host")).toBe("localhost:3000");
  });

  it("preserves an empty ? delimiter exactly (no re-serialization drop)", () => {
    const result = resolvePublicRequest(makeRequest("/mcp?", { host: "proxy.example.com" }));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.url).toBe(`${CANONICAL}/mcp?`);
  });

  it("preserves the empty ? delimiter through the clone as well", () => {
    const cloned = cloneRequestOntoPublicOrigin(
      makeRequest("/mcp?", { host: "proxy.example.com" }),
    );
    expect(cloned.url).toBe(`${CANONICAL}/mcp?`);
  });
});

describe("resolvePublicRequest — Origin validation", () => {
  it("rejects an Origin that does not match the allowed origins", () => {
    const result = resolvePublicRequest(
      makeRequest("/mcp", { host: "proxy.example.com", origin: "https://evil.example.com" }),
    );
    expect(result).toEqual({ ok: false, reason: "origin-mismatch" });
  });

  it("rejects the opaque/sandboxed 'null' Origin", () => {
    const result = resolvePublicRequest(
      makeRequest("/mcp", { host: "proxy.example.com", origin: "null" }),
    );
    expect(result).toEqual({ ok: false, reason: "origin-mismatch" });
  });

  it("rejects an Origin carrying userinfo", () => {
    const result = resolvePublicRequest(
      makeRequest("/mcp", { host: "proxy.example.com", origin: "https://user@proxy.example.com" }),
    );
    expect(result).toEqual({ ok: false, reason: "origin-mismatch" });
  });

  it("rejects an Origin with a path", () => {
    const result = resolvePublicRequest(
      makeRequest("/mcp", { host: "proxy.example.com", origin: "https://proxy.example.com/extra" }),
    );
    expect(result).toEqual({ ok: false, reason: "origin-mismatch" });
  });

  it("rejects an Origin with a non-root trailing-slash path", () => {
    const result = resolvePublicRequest(
      makeRequest("/mcp", {
        host: "proxy.example.com",
        origin: "https://proxy.example.com/some/path/",
      }),
    );
    expect(result).toEqual({ ok: false, reason: "origin-mismatch" });
  });

  it("rejects non-http(s) scheme Origins (blob:)", () => {
    const result = resolvePublicRequest(
      makeRequest("/mcp", { host: "proxy.example.com", origin: "blob:https://proxy.example.com" }),
    );
    expect(result).toEqual({ ok: false, reason: "origin-mismatch" });
  });

  it("rejects comma-folded Origin values (with and without space)", () => {
    for (const folded of [
      "https://proxy.example.com,https://evil.example.com",
      "https://proxy.example.com, https://evil.example.com",
    ]) {
      const result = resolvePublicRequest(
        makeRequest("/mcp", { host: "proxy.example.com", origin: folded }),
      );
      expect(result).toEqual({ ok: false, reason: "origin-mismatch" });
    }
  });

  it("rejects raw Origin forms that URL normalization would launder (raw-string grammar gate)", () => {
    // Each of these currently PARSES to a benign-looking origin under
    // `new URL()` — the gate must reject the RAW string, not the parsed
    // components. The tab is embedded (not edge) because edge HTTP
    // whitespace is trimmed by header normalization before we see it.
    for (const laundered of [
      "https:proxy.example.com",
      "https://proxy.example.com/blocked/..",
      "https://proxy.example.com/%2e",
      "https://proxy.example.com?",
      "https://proxy.example.com#",
      "https://proxy.example\t.com",
    ]) {
      const result = resolvePublicRequest(
        makeRequest("/mcp", { host: "proxy.example.com", origin: laundered }),
      );
      expect(result).toEqual({ ok: false, reason: "origin-mismatch" });
    }
  });

  it("accepts a mixed-case Origin host (allowed-set comparison is case-insensitive)", () => {
    const result = resolvePublicRequest(
      makeRequest("/mcp", { host: "proxy.example.com", origin: "https://PROXY.EXAMPLE.COM" }),
    );
    expect(result).toMatchObject({ ok: true });
  });

  it("accepts an Origin equal to the same-origin web origin (bare root slash is fine)", () => {
    const result = resolvePublicRequest(
      makeRequest("/mcp", { host: "proxy.example.com", origin: "https://proxy.example.com" }),
    );
    expect(result).toMatchObject({ ok: true });
  });

  it("accepts the server origin AND the CORS web origin on split-origin deploys (trustedOrigins parity)", () => {
    mockEnv.CORS_ORIGIN = "https://app.example.com";
    // The server origin is still accepted (matches trustedOrigins in
    // packages/auth/src/index.ts)...
    const serverOrigin = resolvePublicRequest(
      makeRequest("/mcp", { host: "proxy.example.com", origin: "https://proxy.example.com" }),
    );
    expect(serverOrigin).toMatchObject({ ok: true });
    if (!serverOrigin.ok) return;
    expect(serverOrigin.headers.get("origin")).toBe("https://proxy.example.com");
    // ...and so is the split-origin browser app.
    const appOrigin = resolvePublicRequest(
      makeRequest("/mcp", { host: "proxy.example.com", origin: "https://app.example.com" }),
    );
    expect(appOrigin).toMatchObject({ ok: true });
    if (!appOrigin.ok) return;
    expect(appOrigin.headers.get("origin")).toBe("https://app.example.com");
  });

  it("still rejects unknown origins on split-origin deploys", () => {
    mockEnv.CORS_ORIGIN = "https://app.example.com";
    const result = resolvePublicRequest(
      makeRequest("/mcp", { host: "proxy.example.com", origin: "https://evil.example.com" }),
    );
    expect(result).toEqual({ ok: false, reason: "origin-mismatch" });
  });
});

describe("resolvePublicRequest — trusted ingress allowlist", () => {
  it("rejects allowlist-shaped hosts by default (empty frozen allowlist)", () => {
    const request = makeRequest("/mcp", { host: "localhost:3000" });
    request.headers.set("x-forwarded-host", "proxy.example.com");
    expect(resolvePublicRequest(request)).toEqual({ ok: false, reason: "host-not-allowed" });
  });

  it("accepts an allowlisted direct Host with a singular canonical x-forwarded-host", () => {
    const request = makeRequest("/mcp", { host: "localhost:3000" });
    request.headers.set("x-forwarded-host", "proxy.example.com");
    const result = resolvePublicRequest(request, {
      trustedIngressHosts: ["localhost:3000"],
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.url.startsWith(`${CANONICAL}/`)).toBe(true);
    expect(result.headers.get("x-forwarded-host")).toBeNull();
  });

  it("rejects an allowlisted ingress with NO x-forwarded-host (authority ambiguous)", () => {
    const request = makeRequest("/mcp", { host: "localhost:3000" });
    const result = resolvePublicRequest(request, {
      trustedIngressHosts: ["localhost:3000"],
    });
    expect(result).toEqual({ ok: false, reason: "forwarded-host-mismatch" });
  });

  it("rejects a mismatched x-forwarded-host on an allowlisted ingress", () => {
    const request = makeRequest("/mcp", { host: "localhost:3000" });
    request.headers.set("x-forwarded-host", "evil.example.com");
    const result = resolvePublicRequest(request, {
      trustedIngressHosts: ["localhost:3000"],
    });
    expect(result).toEqual({ ok: false, reason: "forwarded-host-mismatch" });
  });

  it("rejects ambiguous multi-value x-forwarded-host on an allowlisted ingress", () => {
    const request = makeRequest("/mcp", { host: "localhost:3000" });
    request.headers.set("x-forwarded-host", "proxy.example.com, proxy.example.com");
    const result = resolvePublicRequest(request, {
      trustedIngressHosts: ["localhost:3000"],
    });
    expect(result).toEqual({ ok: false, reason: "forwarded-host-mismatch" });
  });

  it("rejects padded/comma-carrying single-value x-forwarded-host", () => {
    for (const forwarded of ["proxy.example.com,", ",proxy.example.com", ",,proxy.example.com,,"]) {
      const request = makeRequest("/mcp", { host: "localhost:3000" });
      request.headers.set("x-forwarded-host", forwarded);
      const result = resolvePublicRequest(request, {
        trustedIngressHosts: ["localhost:3000"],
      });
      expect(result).toEqual({ ok: false, reason: "forwarded-host-mismatch" });
    }
  });

  it("rejects an NBSP-padded x-forwarded-host (only ASCII OWS is trimmed)", () => {
    // NBSP is Unicode whitespace: `.trim()` would strip it and launder the
    // value into an exact canonical-host match; ASCII-OWS-only trimming
    // leaves it in place so the comparison mismatches.
    const request = makeRequest("/mcp", { host: "localhost:3000" });
    request.headers.set("x-forwarded-host", "\u00a0proxy.example.com\u00a0");
    const result = resolvePublicRequest(request, {
      trustedIngressHosts: ["localhost:3000"],
    });
    expect(result).toEqual({ ok: false, reason: "forwarded-host-mismatch" });
  });

  it("accepts a single-space-padded x-forwarded-host (ASCII OWS is trimmed)", () => {
    const request = makeRequest("/mcp", { host: "localhost:3000" });
    request.headers.set("x-forwarded-host", " proxy.example.com ");
    const result = resolvePublicRequest(request, {
      trustedIngressHosts: ["localhost:3000"],
    });
    expect(result).toMatchObject({ ok: true });
  });

  it("requires x-forwarded-proto to never override the configured scheme", () => {
    const request = makeRequest("/mcp", { host: "localhost:3000" });
    request.headers.set("x-forwarded-host", "proxy.example.com");
    request.headers.set("x-forwarded-proto", "http");
    const result = resolvePublicRequest(request, {
      trustedIngressHosts: ["localhost:3000"],
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    // Scheme comes from BETTER_AUTH_URL (https), never the forwarded proto.
    expect(result.url.startsWith("https://")).toBe(true);
  });
});

describe("resolvePublicRequest — safe header set", () => {
  it("drops hop-by-hop, forwarding, proxy-*, and Connection-nominated headers; preserves content headers", () => {
    const request = makeRequest("/mcp", {
      host: "proxy.example.com",
      method: "POST",
      body: "payload",
      headers: {
        "content-type": "application/json",
        "content-length": "7",
        authorization: "Bearer abc",
        connection: "keep-alive, x-hop",
        "x-hop": "leak",
        te: "trailers",
        "transfer-encoding": "chunked",
        via: "1.1 proxy",
        forwarded: "for=203.0.113.9;host=evil.example.com",
        "x-forwarded-for": "203.0.113.9",
        "x-real-ip": "203.0.113.9",
        "x-forwarded-port": "443",
        "x-forwarded-prefix": "/api",
        "proxy-connection": "keep-alive",
        "proxy-x-custom": "leak",
      },
    });
    const result = resolvePublicRequest(request);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.headers.get("content-type")).toBe("application/json");
    expect(result.headers.get("content-length")).toBe("7");
    expect(result.headers.get("authorization")).toBe("Bearer abc");
    expect(result.headers.get("via")).toBe("1.1 proxy");
    for (const dropped of [
      "connection",
      "x-hop",
      "te",
      "transfer-encoding",
      "forwarded",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-real-ip",
      "x-forwarded-port",
      "x-forwarded-prefix",
      "proxy-connection",
      "proxy-x-custom",
    ]) {
      expect(result.headers.get(dropped)).toBeNull();
    }
  });

  it("drops set-cookie entirely when Connection nominates it (mixed case)", () => {
    const request = makeRequest("/mcp", {
      host: "proxy.example.com",
      headers: [
        ["set-cookie", "a=1; Path=/"],
        ["set-cookie", "b=2; Path=/"],
        ["connection", "SeT-CoOkIe"],
      ],
    });
    const result = resolvePublicRequest(request);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.headers.getSetCookie()).toEqual([]);
    expect(result.headers.get("set-cookie")).toBeNull();
  });

  it("drops BOTH cookies and the co-nominated x-hop under Connection: Set-Cookie, x-hop", () => {
    const request = makeRequest("/mcp", {
      host: "proxy.example.com",
      headers: [
        ["set-cookie", "a=1; Path=/"],
        ["set-cookie", "b=2; Path=/"],
        ["connection", "Set-Cookie, x-hop"],
        ["x-hop", "leak"],
      ],
    });
    const result = resolvePublicRequest(request);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.headers.getSetCookie()).toEqual([]);
    expect(result.headers.get("set-cookie")).toBeNull();
    expect(result.headers.get("x-hop")).toBeNull();
  });

  it("copies duplicate set-cookie headers individually (no comma collapse)", () => {
    const request = makeRequest("/mcp", {
      host: "proxy.example.com",
      headers: [
        ["set-cookie", "a=1; Path=/"],
        ["set-cookie", "b=2; Path=/"],
      ],
    });
    const result = resolvePublicRequest(request);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });
});

describe("cloneRequestOntoPublicOrigin", () => {
  it("preserves method, path, query, body, and headers through the clone", async () => {
    const original = makeRequest("/mcp?cursor=2&limit=50", {
      host: "proxy.example.com",
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
      headers: {
        "content-type": "application/json",
        authorization: "DPoP proof-token",
      },
    });
    original.headers.set("x-forwarded-host", "evil.example.com");
    const cloned = cloneRequestOntoPublicOrigin(original);
    expect(cloned.method).toBe("POST");
    expect(cloned.url).toBe(`${CANONICAL}/mcp?cursor=2&limit=50`);
    expect(cloned.headers.get("content-type")).toBe("application/json");
    expect(cloned.headers.get("authorization")).toBe("DPoP proof-token");
    expect(cloned.headers.get("x-forwarded-host")).toBeNull();
    await expect(cloned.text()).resolves.toBe(
      JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    );
  });

  it("propagates abort: aborting the original controller aborts the clone", async () => {
    const controller = new AbortController();
    const original = makeRequest("/mcp", {
      host: "proxy.example.com",
      method: "POST",
      body: "payload",
      signal: controller.signal,
    });
    const cloned = cloneRequestOntoPublicOrigin(original);
    expect(cloned.signal.aborted).toBe(false);
    controller.abort();
    expect(cloned.signal.aborted).toBe(true);
  });

  it("throws PublicRequestError with the rejection reason instead of cloning", () => {
    let reason: string | undefined;
    try {
      cloneRequestOntoPublicOrigin(makeRequest("/mcp", { host: "evil.example.com" }));
    } catch (error) {
      expect(error).toBeInstanceOf(PublicRequestError);
      reason = (error as InstanceType<typeof PublicRequestError>).reason;
    }
    expect(reason).toBe("host-not-allowed");
  });
});
