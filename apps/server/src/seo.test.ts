import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    BETTER_AUTH_URL: "https://app.example.com",
  },
}));

const { registerSeoRoutes } = await import("./seo.js");

describe("SEO routes", () => {
  it("uses the configured canonical origin instead of request host headers", async () => {
    const app = new Hono();
    registerSeoRoutes(app);

    const sitemap = await app.request("/sitemap.xml", {
      headers: {
        host: "evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
      },
    });

    expect(sitemap.status).toBe(200);
    const sitemapBody = await sitemap.text();
    expect(sitemapBody).toContain("https://app.example.com/en-US");
    expect(sitemapBody).not.toContain("evil.example");
    for (const protectedPath of ["/admin", "/dashboard", "/settings", "/portal"]) {
      expect(sitemapBody).not.toContain(protectedPath);
    }

    const robots = await app.request("/robots.txt", {
      headers: { host: "evil.example", "x-forwarded-host": "evil.example" },
    });
    expect(await robots.text()).toContain("Sitemap: https://app.example.com/sitemap.xml");
  });
});
