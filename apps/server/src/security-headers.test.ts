import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { mountSecurityHeaders, withWebsocketConnectSources } from "./security-headers";

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

  it("includes form-action 'self' so injected forms cannot exfiltrate credentials", async () => {
    const res = await buildApp().request("/some-page");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/form-action[^;]*'self'/);
  });

  it("adds explicit websocket forms of http and https origins", () => {
    expect(
      withWebsocketConnectSources([
        "'self'",
        "https://app.example.com",
        "https://api.example.com",
        "http://localhost:3001",
      ]),
    ).toEqual([
      "'self'",
      "https://app.example.com",
      "wss://app.example.com",
      "https://api.example.com",
      "wss://api.example.com",
      "http://localhost:3001",
      "ws://localhost:3001",
    ]);
  });

  it("allows same-origin blob workers for browser-side video compression", async () => {
    const res = await buildApp().request("/some-page");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/worker-src[^;]*'self'[^;]*blob:/);
  });
});
