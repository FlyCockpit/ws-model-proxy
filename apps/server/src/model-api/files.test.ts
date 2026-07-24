import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// files.ts imports ./routes.ts (for the default bearer-auth seam), which pulls
// in db/env/token-access at load. Mock those so the suite never runs real env
// validation or hits a database. Every test injects `authenticate` + `prisma`
// through the handler deps, so these mocks only need to satisfy module load.
vi.mock("@ws-model-proxy/env/server", () => ({
  env: { BETTER_AUTH_SECRET: "test-better-auth-secret-value-32chars!" },
}));
vi.mock("@ws-model-proxy/db", () => ({ default: {} }));
vi.mock("@ws-model-proxy/api/lib/model-api-token-access", () => ({
  authenticateModelApiTokenSecret: vi.fn(),
  listVisibleModelTargetsForUser: vi.fn(),
  listVisibleModelTargetsForToken: vi.fn(),
}));

const { createModelApiFileUploadHandler, createModelApiFileGetHandler } = await import(
  "./files.js"
);
const { LocalMediaStore } = await import("../media/store.js");

import type { MediaConfig } from "../media/config.js";

const NOW = 1_700_000_000_000;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11, 0x22, 0x33, 0x44]);

function fakePrisma() {
  return {
    mediaAsset: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      aggregate: vi.fn().mockResolvedValue({ _sum: { sizeBytes: 0 } }),
    },
  };
}

/** An injected auth seam that resolves to the given user id (or null). */
function tokenFor(userId: string | null) {
  return async () => (userId ? ({ userId, id: "tok-1", lookupPrefix: "pfx" } as never) : null);
}

function bearer(): Record<string, string> {
  return { authorization: "Bearer test-token" };
}

let root: string;
let config: MediaConfig;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "v1-files-"));
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

describe("POST /v1/files (upload)", () => {
  it("returns 401 (access_denied) when the bearer token is missing/invalid", async () => {
    const prisma = fakePrisma();
    const app = new Hono();
    app.post(
      "/v1/files",
      createModelApiFileUploadHandler({
        authenticate: tokenFor(null),
        getConfig: () => config,
        prisma: prisma as never,
      }),
    );
    const form = new FormData();
    form.set("file", new Blob([PNG], { type: "image/png" }), "x.png");
    const res = await app.request("/v1/files", { method: "POST", body: form });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type: string; code: string } };
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.code).toBe("access_denied");
    expect(prisma.mediaAsset.create).not.toHaveBeenCalled();
  });

  it("returns 501 (media_not_configured) when storage is not configured", async () => {
    const prisma = fakePrisma();
    const app = new Hono();
    app.post(
      "/v1/files",
      createModelApiFileUploadHandler({
        authenticate: tokenFor("user-1"),
        getConfig: () => null,
        prisma: prisma as never,
      }),
    );
    const form = new FormData();
    form.set("file", new Blob([PNG], { type: "image/png" }), "x.png");
    const res = await app.request("/v1/files", {
      method: "POST",
      body: form,
      headers: bearer(),
    });

    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("media_not_configured");
    expect(prisma.mediaAsset.create).not.toHaveBeenCalled();
  });

  it("stores an allowlisted file and returns OpenAI Files-adjacent JSON", async () => {
    const prisma = fakePrisma();
    prisma.mediaAsset.findFirst.mockResolvedValue(null);
    // uploadMedia generates the id and commits bytes under it before creating
    // the row, so the persisted row carries that id — echo it back like the DB.
    prisma.mediaAsset.create.mockImplementation(async ({ data }: { data: { id: string } }) => ({
      id: data.id,
      createdAt: new Date(NOW),
    }));

    const app = new Hono();
    app.post(
      "/v1/files",
      createModelApiFileUploadHandler({
        authenticate: tokenFor("user-1"),
        getConfig: () => config,
        prisma: prisma as never,
        getTtlHours: async () => 24,
        now: () => NOW,
      }),
    );
    const form = new FormData();
    form.set("file", new Blob([PNG], { type: "image/png" }), "photo.png");
    const res = await app.request("/v1/files", {
      method: "POST",
      body: form,
      headers: bearer(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      object: string;
      bytes: number;
      created_at: number;
      expires_at: number;
      filename: string | null;
      purpose: string;
      url: string;
      url_expires_at: number;
    };
    expect(body.id).toBeTruthy();
    expect(body.object).toBe("file");
    expect(body.bytes).toBe(PNG.length);
    expect(body.created_at).toBe(Math.floor(NOW / 1000));
    expect(body.expires_at).toBe(Math.floor((NOW + 24 * 60 * 60 * 1000) / 1000));
    expect(body.filename).toBe("photo.png");
    expect(body.purpose).toBe("vision");
    expect(body.url).toContain(`https://proxy.example.com/media/${body.id}`);
    expect(body.url).toContain("sig=");
    // Signed URL is short-lived (~10 min) relative to the asset TTL.
    expect(body.url_expires_at).toBe(Math.floor((NOW + 10 * 60 * 1000) / 1000));
    expect(body.url_expires_at).toBeLessThan(body.expires_at);
    // The bytes actually landed under the asset id.
    expect(await new LocalMediaStore(root).getStream(body.id)).not.toBeNull();
  });

  it("reports the deduped asset's real created_at, not now", async () => {
    const prisma = fakePrisma();
    // Dedup hit: an identical asset created earlier already exists.
    const originalCreatedAt = new Date(NOW - 5 * 60 * 1000);
    prisma.mediaAsset.findFirst.mockResolvedValue({
      id: "asset-dedup",
      mime: "image/png",
      sizeBytes: PNG.length,
      createdAt: originalCreatedAt,
    });
    prisma.mediaAsset.update.mockResolvedValue({});

    const app = new Hono();
    app.post(
      "/v1/files",
      createModelApiFileUploadHandler({
        authenticate: tokenFor("user-1"),
        getConfig: () => config,
        prisma: prisma as never,
        getTtlHours: async () => 24,
        now: () => NOW,
      }),
    );
    const form = new FormData();
    form.set("file", new Blob([PNG], { type: "image/png" }), "dupe.png");
    const res = await app.request("/v1/files", {
      method: "POST",
      body: form,
      headers: bearer(),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; created_at: number };
    expect(body.id).toBe("asset-dedup");
    // created_at is the ORIGINAL asset's time, so POST agrees with a later GET.
    expect(body.created_at).toBe(Math.floor(originalCreatedAt.getTime() / 1000));
    expect(body.created_at).not.toBe(Math.floor(NOW / 1000));
    // Dedup path refreshes TTL instead of creating a new row.
    expect(prisma.mediaAsset.create).not.toHaveBeenCalled();
    expect(prisma.mediaAsset.update).toHaveBeenCalledWith({
      where: { id: "asset-dedup" },
      data: { expiresAt: new Date(NOW + 24 * 60 * 60 * 1000) },
    });
  });

  it("owns the asset by the token's user id", async () => {
    const prisma = fakePrisma();
    prisma.mediaAsset.findFirst.mockResolvedValue(null);
    prisma.mediaAsset.create.mockResolvedValue({ id: "asset-owned", createdAt: new Date(NOW) });

    const app = new Hono();
    app.post(
      "/v1/files",
      createModelApiFileUploadHandler({
        authenticate: tokenFor("user-42"),
        getConfig: () => config,
        prisma: prisma as never,
        getTtlHours: async () => 24,
        now: () => NOW,
      }),
    );
    const form = new FormData();
    form.set("file", new Blob([PNG], { type: "image/png" }), "x.png");
    await app.request("/v1/files", { method: "POST", body: form, headers: bearer() });

    expect(prisma.mediaAsset.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: "user-42" }),
      }),
    );
  });

  it("returns 413 (storage_quota_exceeded) naming the quota when over the per-user cap", async () => {
    const prisma = fakePrisma();
    prisma.mediaAsset.findFirst.mockResolvedValue(null);
    prisma.mediaAsset.aggregate.mockResolvedValue({
      _sum: { sizeBytes: config.maxBytesPerUser },
    });

    const app = new Hono();
    app.post(
      "/v1/files",
      createModelApiFileUploadHandler({
        authenticate: tokenFor("user-1"),
        getConfig: () => config,
        prisma: prisma as never,
        getTtlHours: async () => 24,
        now: () => NOW,
      }),
    );
    const form = new FormData();
    form.set("file", new Blob([PNG], { type: "image/png" }), "x.png");
    const res = await app.request("/v1/files", { method: "POST", body: form, headers: bearer() });

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("storage_quota_exceeded");
    expect(body.error.message).toContain(String(config.maxBytesPerUser));
    expect(prisma.mediaAsset.create).not.toHaveBeenCalled();
  });

  it("returns 415 (unsupported_media_type) naming the allowlist for a rejected type", async () => {
    const prisma = fakePrisma();
    prisma.mediaAsset.findFirst.mockResolvedValue(null);
    const app = new Hono();
    app.post(
      "/v1/files",
      createModelApiFileUploadHandler({
        authenticate: tokenFor("user-1"),
        getConfig: () => config,
        prisma: prisma as never,
        getTtlHours: async () => 24,
      }),
    );
    const form = new FormData();
    form.set("file", new Blob([Buffer.from("<svg/>")], { type: "image/svg+xml" }), "x.svg");
    const res = await app.request("/v1/files", {
      method: "POST",
      body: form,
      headers: bearer(),
    });

    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("unsupported_media_type");
    expect(body.error.message).toContain("JPEG");
    expect(prisma.mediaAsset.create).not.toHaveBeenCalled();
  });
});

describe("GET /v1/files/:id (re-sign)", () => {
  it("returns 401 (access_denied) when the bearer token is missing/invalid", async () => {
    const prisma = fakePrisma();
    const app = new Hono();
    app.get(
      "/v1/files/:id",
      createModelApiFileGetHandler({
        authenticate: tokenFor(null),
        getConfig: () => config,
        prisma: prisma as never,
      }),
    );
    const res = await app.request("/v1/files/asset-x");
    expect(res.status).toBe(401);
    expect(prisma.mediaAsset.findUnique).not.toHaveBeenCalled();
  });

  it("re-mints a fresh signed URL for an owned, unexpired asset", async () => {
    const prisma = fakePrisma();
    prisma.mediaAsset.findUnique.mockResolvedValue({
      userId: "user-1",
      sizeBytes: 12,
      expiresAt: new Date(NOW + 60 * 60 * 1000),
      createdAt: new Date(NOW - 60 * 1000),
    });

    const app = new Hono();
    app.get(
      "/v1/files/:id",
      createModelApiFileGetHandler({
        authenticate: tokenFor("user-1"),
        getConfig: () => config,
        prisma: prisma as never,
        now: () => NOW,
      }),
    );
    const res = await app.request("/v1/files/asset-live", { headers: bearer() });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      object: string;
      bytes: number;
      created_at: number;
      expires_at: number;
      filename: string | null;
      purpose: string;
      url: string;
      url_expires_at: number;
    };
    expect(body.id).toBe("asset-live");
    expect(body.object).toBe("file");
    expect(body.bytes).toBe(12);
    expect(body.created_at).toBe(Math.floor((NOW - 60 * 1000) / 1000));
    expect(body.expires_at).toBe(Math.floor((NOW + 60 * 60 * 1000) / 1000));
    expect(body.filename).toBeNull();
    expect(body.purpose).toBe("vision");
    expect(body.url).toContain("https://proxy.example.com/media/asset-live");
    expect(body.url).toContain("sig=");
    expect(body.url_expires_at).toBe(Math.floor((NOW + 10 * 60 * 1000) / 1000));
  });

  it("404s when the asset is owned by a different user (no probing)", async () => {
    const prisma = fakePrisma();
    prisma.mediaAsset.findUnique.mockResolvedValue({
      userId: "someone-else",
      sizeBytes: 12,
      expiresAt: new Date(NOW + 60 * 60 * 1000),
      createdAt: new Date(NOW - 60 * 1000),
    });

    const app = new Hono();
    app.get(
      "/v1/files/:id",
      createModelApiFileGetHandler({
        authenticate: tokenFor("user-1"),
        getConfig: () => config,
        prisma: prisma as never,
        now: () => NOW,
      }),
    );
    const res = await app.request("/v1/files/foreign", { headers: bearer() });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
    expect(prisma.mediaAsset.delete).not.toHaveBeenCalled();
  });

  it("lazily deletes and 404s an expired asset", async () => {
    const prisma = fakePrisma();
    // Seed real bytes so the lazy-delete has something to remove.
    const staged = await new LocalMediaStore(root).stage(
      (await import("node:stream")).Readable.from([PNG]),
    );
    await staged.commit("asset-exp");

    prisma.mediaAsset.findUnique.mockResolvedValue({
      userId: "user-1",
      sizeBytes: 12,
      expiresAt: new Date(NOW - 1000), // already expired
      createdAt: new Date(NOW - 60 * 1000),
    });
    prisma.mediaAsset.delete.mockResolvedValue({});

    const app = new Hono();
    app.get(
      "/v1/files/:id",
      createModelApiFileGetHandler({
        authenticate: tokenFor("user-1"),
        getConfig: () => config,
        prisma: prisma as never,
        now: () => NOW,
      }),
    );
    const res = await app.request("/v1/files/asset-exp", { headers: bearer() });

    expect(res.status).toBe(404);
    expect(prisma.mediaAsset.delete).toHaveBeenCalledWith({ where: { id: "asset-exp" } });
    expect(await new LocalMediaStore(root).getStream("asset-exp")).toBeNull();
  });

  it("404s an unknown id", async () => {
    const prisma = fakePrisma();
    prisma.mediaAsset.findUnique.mockResolvedValue(null);
    const app = new Hono();
    app.get(
      "/v1/files/:id",
      createModelApiFileGetHandler({
        authenticate: tokenFor("user-1"),
        getConfig: () => config,
        prisma: prisma as never,
        now: () => NOW,
      }),
    );
    const res = await app.request("/v1/files/nope", { headers: bearer() });
    expect(res.status).toBe(404);
  });

  it("fails an unsafe id closed as 404 without a 500, DB touch, or echoing the raw id", async () => {
    const prisma = fakePrisma();
    const app = new Hono();
    app.get(
      "/v1/files/:id",
      createModelApiFileGetHandler({
        authenticate: tokenFor("user-1"),
        getConfig: () => config,
        prisma: prisma as never,
        now: () => NOW,
      }),
    );

    // Single-segment unsafe ids (invalid char, overlong) reach the handler's id
    // guard → JSON not_found with a generic message that never echoes the raw id.
    for (const id of ["a.b", "a!b", "x".repeat(200)]) {
      const res = await app.request(`/v1/files/${id}`, { headers: bearer() });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("not_found");
      expect(body.error.message).toBe("No file found with the requested id.");
    }
    // Traversal (slash-bearing) and empty ids never match the single-segment
    // route at all — still a clean 404 (no 500), just Hono's own not-found.
    for (const path of [`/v1/files/${encodeURIComponent("../../etc/passwd")}`, "/v1/files/"]) {
      const res = await app.request(path, { headers: bearer() });
      expect(res.status).toBe(404);
    }
    expect(prisma.mediaAsset.findUnique).not.toHaveBeenCalled();
  });
});
