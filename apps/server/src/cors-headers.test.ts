import { APP_LOCALE_HEADER } from "@ws-model-proxy/config/locales";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { describe, expect, it } from "vitest";

import { CORS_ALLOW_HEADERS } from "./cors-headers";

const APP_ORIGIN = "https://app.example.com";

// Mirrors the cross-origin branch in index.ts. Asserting against the real
// middleware rather than the constant is the point: a header missing from
// CORS_ALLOW_HEADERS is only observable as a preflight that fails to echo it
// back, which is exactly what the browser refuses on.
function buildApp() {
  const app = new Hono();
  app.use(
    "/*",
    cors({
      origin: APP_ORIGIN,
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: [...CORS_ALLOW_HEADERS],
      credentials: true,
    }),
  );
  app.post("/api/auth/sign-in/email", (c) => c.json({ ok: true }));
  return app;
}

function preflight(requestHeaders: string) {
  return buildApp().request("/api/auth/sign-in/email", {
    method: "OPTIONS",
    headers: {
      Origin: APP_ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": requestHeaders,
    },
  });
}

describe("CORS_ALLOW_HEADERS", () => {
  it.each([...CORS_ALLOW_HEADERS])("echoes %s back on the preflight", async (header) => {
    const res = await preflight(header);
    const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    expect(allowed).toContain(header.toLowerCase());
  });

  it("allows the locale header the auth client sets on every request", async () => {
    expect(CORS_ALLOW_HEADERS).toContain(APP_LOCALE_HEADER);

    const res = await preflight(`content-type,${APP_LOCALE_HEADER}`);
    const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    expect(allowed).toContain(APP_LOCALE_HEADER);
  });

  it("allows the CSRF header Better-Auth's client plugin sets", async () => {
    const res = await preflight("x-csrf-token");
    const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    expect(allowed).toContain("x-csrf-token");
  });
});
