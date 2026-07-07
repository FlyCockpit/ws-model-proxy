import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { mountSecurityHeaders } from "./security-headers";

function buildApp() {
  const app = new Hono();
  mountSecurityHeaders(app, {
    cspConnectSrc: ["'self'"],
    themeInitCspHash: "'sha256-test'",
  });
  app.get("/some-page", (c) => c.text("page"));
  return app;
}

describe("mountSecurityHeaders", () => {
  it("serves routes with the app CSP", async () => {
    const res = await buildApp().request("/some-page");
    const csp = res.headers.get("content-security-policy");
    expect(csp).toContain("default-src 'self'");
  });

  it("applies the app CSP's other security headers", async () => {
    const res = await buildApp().request("/some-page");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
