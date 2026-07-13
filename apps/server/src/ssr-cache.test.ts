import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: {
    SSR_CACHE_TTL_SECONDS: 60,
  },
}));

vi.mock("./seo.js", () => ({
  PUBLIC_PATHS: [{ path: "", title: "Home", changefreq: "weekly", priority: 1 }],
}));

const { clearSsrCache, getOrSetSsrCache } = await import("./ssr-cache.js");

describe("SSR cache", () => {
  beforeEach(() => {
    clearSsrCache();
  });

  it("rewrites cached script nonces to the current request nonce", async () => {
    const request = new Request("https://app.example.com/en-US");
    const render = vi.fn(async () => {
      return new Response('<script nonce="nonce-a">window.__x=1</script>', {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });

    const miss = await getOrSetSsrCache(request, render, { nonce: "nonce-a" });
    await expect(miss.text()).resolves.toContain('nonce="nonce-a"');

    const hit = await getOrSetSsrCache(request, render, { nonce: "nonce-b" });

    await expect(hit.text()).resolves.toContain('nonce="nonce-b"');
    expect(hit.headers.get("X-SSR-Cache")).toBe("hit");
    expect(render).toHaveBeenCalledOnce();
  });
});
