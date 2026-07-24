import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createSameOriginGuard } from "./csrf-guard.js";

const APP_ORIGIN = "https://app.example.com";
const SPA_ORIGIN = "https://spa.example.com"; // split-origin frontend

function guardedApp() {
  const app = new Hono();
  const guard = createSameOriginGuard({ allowedOrigins: [APP_ORIGIN, SPA_ORIGIN] });
  app.use("/api/internal/media", guard);
  app.post("/api/internal/media", (c) => c.json({ ok: true }, 201));
  app.get("/api/internal/media", (c) => c.json({ ok: true }, 200));
  return app;
}

describe("createSameOriginGuard", () => {
  it("allows a same-origin POST (Origin matches the app origin)", async () => {
    const res = await guardedApp().request("/api/internal/media", {
      method: "POST",
      headers: { origin: APP_ORIGIN },
    });
    expect(res.status).toBe(201);
  });

  it("allows a split-origin SPA POST even though Sec-Fetch-Site is cross-site", async () => {
    const res = await guardedApp().request("/api/internal/media", {
      method: "POST",
      headers: { origin: SPA_ORIGIN, "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(201);
  });

  it("blocks a cross-site form-style POST with a foreign Origin (403)", async () => {
    const res = await guardedApp().request("/api/internal/media", {
      method: "POST",
      headers: { origin: "https://evil.example.com", "content-type": "multipart/form-data" },
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toEqual({
      error: "Cross-site request blocked.",
    });
  });

  it("allows a POST with no Origin but Sec-Fetch-Site: same-origin", async () => {
    const res = await guardedApp().request("/api/internal/media", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(201);
  });

  it("blocks a POST with no Origin and Sec-Fetch-Site: cross-site", async () => {
    const res = await guardedApp().request("/api/internal/media", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
  });

  it("fails closed when neither Origin nor Sec-Fetch-Site is present", async () => {
    const res = await guardedApp().request("/api/internal/media", { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("leaves safe GET reads untouched regardless of origin", async () => {
    const res = await guardedApp().request("/api/internal/media", {
      method: "GET",
      headers: { origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(200);
  });
});
