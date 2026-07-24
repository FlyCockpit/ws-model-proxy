import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_SECRET: "test-better-auth-secret-value-32chars!" },
}));
vi.mock("@ws-model-proxy/db", () => ({ default: {} }));

const {
  createMediaConfigHandler,
  createMediaUploadHandler,
  createMediaSignHandler,
  createMediaGetHandler,
  createMediaAdminStatsHandler,
  createMediaAdminPurgeExpiredHandler,
  createMediaAdminDeleteAllHandler,
} = await import("./routes.js");
const { LocalMediaStore } = await import("./store.js");
const { buildSignedMediaUrl } = await import("./signing.js");

import type { MediaConfig } from "./config.js";

const NOW = 1_700_000_000_000;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22, 0x33, 0x44]);

function fakePrisma() {
  return {
    mediaAsset: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      aggregate: vi.fn().mockResolvedValue({ _sum: { sizeBytes: 0 } }),
      count: vi.fn(),
    },
  };
}

type SessionApp = Hono<{ Variables: { session: unknown } }>;

function withSession(app: SessionApp, userId: string | null) {
  app.use("*", async (c, next) => {
    c.set("session", userId ? { user: { id: userId } } : null);
    await next();
  });
  return app;
}

let root: string;
let config: MediaConfig;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "media-routes-"));
  config = {
    storage: "local",
    root,
    maxUploadBytes: 25 * 1024 * 1024,
    maxBytesPerUser: 512 * 1024 * 1024,
    publicBaseUrl: "https://proxy.example.com",
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("GET /api/internal/media/config (capability discovery)", () => {
  it("returns 401 when unauthenticated", async () => {
    const app = withSession(new Hono<{ Variables: { session: unknown } }>(), null);
    app.get("/api/internal/media/config", createMediaConfigHandler({ getConfig: () => config }));
    const res = await app.request("/api/internal/media/config");
    expect(res.status).toBe(401);
  });

  it("reports enabled + maxUploadBytes when storage is configured", async () => {
    const app = withSession(new Hono<{ Variables: { session: unknown } }>(), "user-1");
    app.get("/api/internal/media/config", createMediaConfigHandler({ getConfig: () => config }));
    const res = await app.request("/api/internal/media/config");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; maxUploadBytes: number };
    expect(body).toEqual({ enabled: true, maxUploadBytes: config.maxUploadBytes });
  });

  it("reports disabled when storage is not configured", async () => {
    const app = withSession(new Hono<{ Variables: { session: unknown } }>(), "user-1");
    app.get("/api/internal/media/config", createMediaConfigHandler({ getConfig: () => null }));
    const res = await app.request("/api/internal/media/config");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; maxUploadBytes: number };
    expect(body).toEqual({ enabled: false, maxUploadBytes: 0 });
  });
});

describe("POST /api/internal/media (upload)", () => {
  it("returns 501 when media storage is not configured", async () => {
    const prisma = fakePrisma();
    const app = withSession(new Hono<{ Variables: { session: unknown } }>(), "user-1");
    app.post(
      "/api/internal/media",
      createMediaUploadHandler({ getConfig: () => null, prisma: prisma as never }),
    );

    const form = new FormData();
    form.set("file", new Blob([PNG], { type: "image/png" }), "x.png");
    const res = await app.request("/api/internal/media", { method: "POST", body: form });

    expect(res.status).toBe(501);
    expect(prisma.mediaAsset.create).not.toHaveBeenCalled();
  });

  it("returns 401 when unauthenticated", async () => {
    const prisma = fakePrisma();
    const app = withSession(new Hono<{ Variables: { session: unknown } }>(), null);
    app.post(
      "/api/internal/media",
      createMediaUploadHandler({ getConfig: () => config, prisma: prisma as never }),
    );
    const res = await app.request("/api/internal/media", { method: "POST", body: new FormData() });
    expect(res.status).toBe(401);
  });

  it("stores an allowlisted file and returns { id, expiresAt }", async () => {
    const prisma = fakePrisma();
    prisma.mediaAsset.findFirst.mockResolvedValue(null);
    prisma.mediaAsset.create.mockResolvedValue({ id: "asset-up" });

    const app = withSession(new Hono<{ Variables: { session: unknown } }>(), "user-1");
    app.post(
      "/api/internal/media",
      createMediaUploadHandler({
        getConfig: () => config,
        prisma: prisma as never,
        getTtlHours: async () => 24,
        now: () => NOW,
      }),
    );

    const form = new FormData();
    form.set("file", new Blob([PNG], { type: "image/png" }), "x.png");
    const res = await app.request("/api/internal/media", { method: "POST", body: form });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; expiresAt: string };
    expect(body.id).toBe("asset-up");
    expect(new Date(body.expiresAt).getTime()).toBe(NOW + 24 * 60 * 60 * 1000);
  });

  it("returns 413 with code media_quota_exceeded when over the per-user quota", async () => {
    const prisma = fakePrisma();
    prisma.mediaAsset.findFirst.mockResolvedValue(null);
    // User already holds the entire quota; any new byte pushes them over.
    prisma.mediaAsset.aggregate.mockResolvedValue({
      _sum: { sizeBytes: config.maxBytesPerUser },
    });

    const app = withSession(new Hono<{ Variables: { session: unknown } }>(), "user-1");
    app.post(
      "/api/internal/media",
      createMediaUploadHandler({
        getConfig: () => config,
        prisma: prisma as never,
        getTtlHours: async () => 24,
        now: () => NOW,
      }),
    );
    const form = new FormData();
    form.set("file", new Blob([PNG], { type: "image/png" }), "x.png");
    const res = await app.request("/api/internal/media", { method: "POST", body: form });

    expect(res.status).toBe(413);
    const body = (await res.json()) as { code: string; quotaBytes: number };
    expect(body.code).toBe("media_quota_exceeded");
    expect(body.quotaBytes).toBe(config.maxBytesPerUser);
    expect(prisma.mediaAsset.create).not.toHaveBeenCalled();
  });

  it("returns 415 for a non-allowlisted type", async () => {
    const prisma = fakePrisma();
    prisma.mediaAsset.findFirst.mockResolvedValue(null);
    const app = withSession(new Hono<{ Variables: { session: unknown } }>(), "user-1");
    app.post(
      "/api/internal/media",
      createMediaUploadHandler({
        getConfig: () => config,
        prisma: prisma as never,
        getTtlHours: async () => 24,
      }),
    );
    const form = new FormData();
    form.set("file", new Blob([Buffer.from("<svg/>")], { type: "image/svg+xml" }), "x.svg");
    const res = await app.request("/api/internal/media", { method: "POST", body: form });
    expect(res.status).toBe(415);
    expect(prisma.mediaAsset.create).not.toHaveBeenCalled();
  });
});

describe("POST /api/internal/media/sign (owner check)", () => {
  it("rejects ids the caller does not own or that are expired", async () => {
    const prisma = fakePrisma();
    // Only "a" is owned + unexpired; "b" is missing.
    prisma.mediaAsset.findMany.mockResolvedValue([{ id: "a" }]);
    const app = withSession(new Hono<{ Variables: { session: unknown } }>(), "user-1");
    app.post(
      "/api/internal/media/sign",
      createMediaSignHandler({ getConfig: () => config, prisma: prisma as never, now: () => NOW }),
    );

    const res = await app.request("/api/internal/media/sign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: ["a", "b"] }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { invalidIds: string[] };
    expect(body.invalidIds).toEqual(["b"]);
    // Owner + expiry scoped in the query.
    expect(prisma.mediaAsset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user-1", expiresAt: { gt: new Date(NOW) } }),
      }),
    );
  });

  it("returns fresh signed URLs for owned, unexpired ids", async () => {
    const prisma = fakePrisma();
    prisma.mediaAsset.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    const app = withSession(new Hono<{ Variables: { session: unknown } }>(), "user-1");
    app.post(
      "/api/internal/media/sign",
      createMediaSignHandler({ getConfig: () => config, prisma: prisma as never, now: () => NOW }),
    );
    const res = await app.request("/api/internal/media/sign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: ["a", "b"] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { urls: { id: string; url: string }[] };
    expect(body.urls.map((u) => u.id).sort()).toEqual(["a", "b"]);
    for (const u of body.urls) {
      expect(u.url).toContain("https://proxy.example.com/media/");
      expect(u.url).toContain("sig=");
    }
  });
});

describe("GET /media/:id (signed fetch)", () => {
  async function seedFile(id: string): Promise<void> {
    const store = new LocalMediaStore(root);
    const staged = await store.stage(Readable.from([PNG]));
    await staged.commit(id);
  }

  it("lazily deletes and 404s an expired asset", async () => {
    const prisma = fakePrisma();
    await seedFile("asset-exp");
    prisma.mediaAsset.findUnique.mockResolvedValue({
      mime: "image/png",
      expiresAt: new Date(NOW - 1000), // already expired
    });
    prisma.mediaAsset.delete.mockResolvedValue({});

    const app = new Hono();
    app.get(
      "/media/:id",
      createMediaGetHandler({ getConfig: () => config, prisma: prisma as never, now: () => NOW }),
    );

    const signed = buildSignedMediaUrl({
      id: "asset-exp",
      publicBaseUrl: config.publicBaseUrl,
      now: NOW,
    });
    const path = new URL(signed.url).pathname + new URL(signed.url).search;
    const res = await app.request(path);

    expect(res.status).toBe(404);
    expect(prisma.mediaAsset.delete).toHaveBeenCalledWith({ where: { id: "asset-exp" } });
    // The bytes were removed too.
    expect(await new LocalMediaStore(root).getStream("asset-exp")).toBeNull();
  });

  it("rejects a bad signature with 403 without touching the DB", async () => {
    const prisma = fakePrisma();
    const app = new Hono();
    app.get(
      "/media/:id",
      createMediaGetHandler({ getConfig: () => config, prisma: prisma as never, now: () => NOW }),
    );
    const res = await app.request("/media/asset-x?exp=9999999999&sig=deadbeef");
    expect(res.status).toBe(403);
    expect(prisma.mediaAsset.findUnique).not.toHaveBeenCalled();
  });

  it("streams a live asset with sandbox security headers", async () => {
    const prisma = fakePrisma();
    await seedFile("asset-live");
    prisma.mediaAsset.findUnique.mockResolvedValue({
      mime: "image/png",
      expiresAt: new Date(NOW + 60_000),
    });

    const app = new Hono();
    app.get(
      "/media/:id",
      createMediaGetHandler({ getConfig: () => config, prisma: prisma as never, now: () => NOW }),
    );
    const signed = buildSignedMediaUrl({
      id: "asset-live",
      publicBaseUrl: config.publicBaseUrl,
      now: NOW,
    });
    const path = new URL(signed.url).pathname + new URL(signed.url).search;
    const res = await app.request(path);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(res.headers.get("Content-Disposition")).toBe("inline");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.equals(PNG)).toBe(true);
  });

  it("404s when media is not configured", async () => {
    const prisma = fakePrisma();
    const app = new Hono();
    app.get(
      "/media/:id",
      createMediaGetHandler({ getConfig: () => null, prisma: prisma as never, now: () => NOW }),
    );
    const res = await app.request("/media/whatever?exp=1&sig=1");
    expect(res.status).toBe(404);
  });

  it("fails an unsafe id closed as 404 (traversal / overlong / dot) without a 500 or DB touch", async () => {
    const prisma = fakePrisma();
    const app = new Hono();
    app.get(
      "/media/:id",
      createMediaGetHandler({ getConfig: () => config, prisma: prisma as never, now: () => NOW }),
    );

    // Single-segment unsafe ids (invalid char, overlong) reach the handler's id
    // guard, which 404s before signature verification or any store/DB access.
    for (const id of ["a.b", "a!b", "x".repeat(200)]) {
      const res = await app.request(`/media/${id}?exp=9999999999&sig=deadbeef`);
      // 404 (not 403 bad-sig, not 500).
      expect(res.status).toBe(404);
    }
    // Traversal (slash-bearing) and empty ids never match the single-segment
    // route — still a clean 404, no 500.
    for (const path of [
      `/media/${encodeURIComponent("../../etc/passwd")}?exp=1&sig=1`,
      "/media/",
    ]) {
      expect((await app.request(path)).status).toBe(404);
    }
    expect(prisma.mediaAsset.findUnique).not.toHaveBeenCalled();
  });
});

describe("GET /api/internal/media/admin/stats", () => {
  it("returns upload capability, TTL bounds, and aggregate stats (no content)", async () => {
    const prisma = fakePrisma();
    prisma.mediaAsset.aggregate.mockResolvedValue({
      _count: { _all: 5 },
      _sum: { sizeBytes: 2048 },
    });
    prisma.mediaAsset.count.mockResolvedValue(1);

    const app = new Hono();
    app.get(
      "/api/internal/media/admin/stats",
      createMediaAdminStatsHandler({
        getConfig: () => config,
        prisma: prisma as never,
        getTtlHours: async () => 48,
        now: () => NOW,
      }),
    );
    const res = await app.request("/api/internal/media/admin/stats");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      uploadEnabled: boolean;
      ttl: { hours: number; min: number; max: number; default: number };
      stats: { assetCount: number; totalBytes: number; expiredCount: number };
    };
    expect(body.uploadEnabled).toBe(true);
    expect(body.ttl).toEqual({ hours: 48, min: 1, max: 168, default: 24 });
    expect(body.stats).toEqual({ assetCount: 5, totalBytes: 2048, expiredCount: 1 });
    // The response must never leak ids/owners/urls.
    expect(JSON.stringify(body)).not.toContain("url");
  });

  it("reports uploadEnabled=false when storage is not configured", async () => {
    const prisma = fakePrisma();
    prisma.mediaAsset.aggregate.mockResolvedValue({
      _count: { _all: 0 },
      _sum: { sizeBytes: null },
    });
    prisma.mediaAsset.count.mockResolvedValue(0);

    const app = new Hono();
    app.get(
      "/api/internal/media/admin/stats",
      createMediaAdminStatsHandler({
        getConfig: () => null,
        prisma: prisma as never,
        getTtlHours: async () => 24,
        now: () => NOW,
      }),
    );
    const res = await app.request("/api/internal/media/admin/stats");
    const body = (await res.json()) as { uploadEnabled: boolean };
    expect(body.uploadEnabled).toBe(false);
  });
});

describe("POST /api/internal/media/admin/purge-expired", () => {
  it("sweeps expired assets and returns the removed count", async () => {
    const prisma = fakePrisma();
    // One batch of expired rows, then empty to end the sweep loop.
    prisma.mediaAsset.findMany
      .mockResolvedValueOnce([{ id: "old-1" }, { id: "old-2" }])
      .mockResolvedValueOnce([]);
    prisma.mediaAsset.deleteMany.mockResolvedValue({ count: 2 });

    const app = withSession(new Hono<{ Variables: { session: unknown } }>(), "admin-1");
    app.post(
      "/api/internal/media/admin/purge-expired",
      createMediaAdminPurgeExpiredHandler({
        getConfig: () => config,
        prisma: prisma as never,
        now: () => NOW,
      }),
    );
    const res = await app.request("/api/internal/media/admin/purge-expired", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: 2 });
    expect(prisma.mediaAsset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { expiresAt: { lte: new Date(NOW) } } }),
    );
  });

  it("returns 501 when media storage is not configured", async () => {
    const prisma = fakePrisma();
    const app = withSession(new Hono<{ Variables: { session: unknown } }>(), "admin-1");
    app.post(
      "/api/internal/media/admin/purge-expired",
      createMediaAdminPurgeExpiredHandler({ getConfig: () => null, prisma: prisma as never }),
    );
    const res = await app.request("/api/internal/media/admin/purge-expired", { method: "POST" });
    expect(res.status).toBe(501);
    expect(prisma.mediaAsset.findMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/internal/media/admin/delete-all", () => {
  it("deletes all assets' bytes and rows and returns counts", async () => {
    const store = new LocalMediaStore(root);
    const staged = await store.stage(Readable.from([PNG]));
    await staged.commit("wipe-1");

    const prisma = fakePrisma();
    prisma.mediaAsset.findMany
      .mockResolvedValueOnce([{ id: "wipe-1", sizeBytes: 12 }])
      .mockResolvedValueOnce([]);
    prisma.mediaAsset.deleteMany.mockResolvedValue({ count: 1 });

    const app = withSession(new Hono<{ Variables: { session: unknown } }>(), "admin-1");
    app.post(
      "/api/internal/media/admin/delete-all",
      createMediaAdminDeleteAllHandler({ getConfig: () => config, prisma: prisma as never }),
    );
    const res = await app.request("/api/internal/media/admin/delete-all", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: 1, bytes: 12 });
    expect(await new LocalMediaStore(root).getStream("wipe-1")).toBeNull();
  });

  it("returns 501 when media storage is not configured", async () => {
    const prisma = fakePrisma();
    const app = withSession(new Hono<{ Variables: { session: unknown } }>(), "admin-1");
    app.post(
      "/api/internal/media/admin/delete-all",
      createMediaAdminDeleteAllHandler({ getConfig: () => null, prisma: prisma as never }),
    );
    const res = await app.request("/api/internal/media/admin/delete-all", { method: "POST" });
    expect(res.status).toBe(501);
    expect(prisma.mediaAsset.findMany).not.toHaveBeenCalled();
  });
});
