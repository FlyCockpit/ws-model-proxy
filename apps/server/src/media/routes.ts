import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import type { Session } from "@ws-model-proxy/auth";
import defaultPrisma from "@ws-model-proxy/db";
import type { Context } from "hono";
import { z } from "zod";
import { deleteAllMedia, getMediaStats } from "./admin.js";
import { sweepExpiredMedia } from "./cleanup.js";
import { getMediaConfig, MEDIA_NOT_CONFIGURED_MESSAGE, type MediaConfig } from "./config.js";
import { MediaQuotaExceededError, uploadMedia } from "./service.js";
import { buildSignedMediaUrl, verifyMediaSignature } from "./signing.js";
import { MediaTypeNotAllowedError } from "./sniff.js";
import { isSafeMediaId, LocalMediaStore, type MediaStore, MediaTooLargeError } from "./store.js";
import {
  getMediaAssetTtlHours,
  MEDIA_ASSET_TTL_DEFAULT_HOURS,
  MEDIA_ASSET_TTL_MAX_HOURS,
  MEDIA_ASSET_TTL_MIN_HOURS,
} from "./ttl.js";

type MediaPrisma = Pick<typeof defaultPrisma, "mediaAsset">;

/** Dependency seam so tests can inject a temp-dir store, mock prisma, and clock. */
export interface MediaHandlerDeps {
  getConfig?: () => MediaConfig | null;
  makeStore?: (config: MediaConfig) => MediaStore;
  prisma?: MediaPrisma;
  getTtlHours?: () => Promise<number>;
  now?: () => number;
}

function resolveDeps(deps: MediaHandlerDeps) {
  return {
    getConfig: deps.getConfig ?? getMediaConfig,
    makeStore: deps.makeStore ?? ((config: MediaConfig) => new LocalMediaStore(config.root)),
    prisma: deps.prisma ?? (defaultPrisma as unknown as MediaPrisma),
    getTtlHours: deps.getTtlHours ?? getMediaAssetTtlHours,
    now: deps.now ?? (() => Date.now()),
  };
}

function sessionUser(c: Context): Session["user"] | null {
  const session = c.get("session") as Session | null | undefined;
  return session?.user ?? null;
}

// ---------------------------------------------------------------------------
// GET /api/internal/media/config — capability discovery (session-authenticated)
// ---------------------------------------------------------------------------
// Lets the dashboard/chat-test client decide whether to upload large
// attachments or fall back to base64 embedding, and how large an upload may be.
export function createMediaConfigHandler(deps: MediaHandlerDeps = {}) {
  const { getConfig } = resolveDeps(deps);

  return async (c: Context): Promise<Response> => {
    const user = sessionUser(c);
    if (!user) return c.json({ error: "Authentication is required." }, 401);

    const config = getConfig();
    if (!config) {
      return c.json({ enabled: false, maxUploadBytes: 0 }, 200);
    }
    return c.json({ enabled: true, maxUploadBytes: config.maxUploadBytes }, 200);
  };
}

// ---------------------------------------------------------------------------
// POST /api/internal/media — multipart upload (session-authenticated)
// ---------------------------------------------------------------------------
export function createMediaUploadHandler(deps: MediaHandlerDeps = {}) {
  const { getConfig, makeStore, prisma, getTtlHours, now } = resolveDeps(deps);

  return async (c: Context): Promise<Response> => {
    const user = sessionUser(c);
    if (!user) return c.json({ error: "Authentication is required." }, 401);

    const config = getConfig();
    if (!config) return c.json({ error: MEDIA_NOT_CONFIGURED_MESSAGE }, 501);

    let file: File | null = null;
    try {
      const form = await c.req.formData();
      const value = form.get("file");
      if (value instanceof File) file = value;
    } catch {
      return c.json({ error: "Expected a multipart/form-data body with a `file` field." }, 400);
    }
    if (!file) {
      return c.json({ error: "Missing `file` field in multipart body." }, 400);
    }

    const source = Readable.fromWeb(file.stream() as unknown as NodeWebReadableStream<Uint8Array>);

    try {
      const result = await uploadMedia({
        source,
        userId: user.id,
        store: makeStore(config),
        ttlHours: await getTtlHours(),
        maxUploadBytes: config.maxUploadBytes,
        maxBytesPerUser: config.maxBytesPerUser,
        prisma,
        now: new Date(now()),
      });
      return c.json({ id: result.id, expiresAt: result.expiresAt.toISOString() }, 201);
    } catch (err) {
      if (err instanceof MediaTypeNotAllowedError) {
        return c.json({ error: err.message }, 415);
      }
      if (err instanceof MediaQuotaExceededError) {
        // Distinct code so the client can show a quota-specific message rather
        // than the generic upload-failed fallback.
        return c.json(
          { error: err.message, code: "media_quota_exceeded", quotaBytes: err.quotaBytes },
          413,
        );
      }
      if (err instanceof MediaTooLargeError) {
        // Same 413 shape as the route's bodyLimit onError (defense in depth for
        // when the service-layer cap trips before/without the middleware).
        return c.json({ error: "Upload is too large.", maxBytes: err.maxBytes }, 413);
      }
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// POST /api/internal/media/sign — mint fresh signed URLs (owner-checked)
// ---------------------------------------------------------------------------
const signBodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(64),
});

export function createMediaSignHandler(deps: MediaHandlerDeps = {}) {
  const { getConfig, prisma, now } = resolveDeps(deps);

  return async (c: Context): Promise<Response> => {
    const user = sessionUser(c);
    if (!user) return c.json({ error: "Authentication is required." }, 401);

    const config = getConfig();
    if (!config) return c.json({ error: MEDIA_NOT_CONFIGURED_MESSAGE }, 501);

    let parsed: z.infer<typeof signBodySchema>;
    try {
      parsed = signBodySchema.parse(await c.req.json());
    } catch {
      return c.json({ error: "Expected JSON body { ids: string[] }." }, 400);
    }

    const requestedIds = [...new Set(parsed.ids)];
    const nowDate = new Date(now());
    const owned = await prisma.mediaAsset.findMany({
      where: { id: { in: requestedIds }, userId: user.id, expiresAt: { gt: nowDate } },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((a) => a.id));

    const invalidIds = requestedIds.filter((id) => !ownedIds.has(id));
    if (invalidIds.length > 0) {
      // Owner check + expiry check as one gate: any unknown/foreign/expired id
      // fails the whole request rather than silently dropping entries.
      return c.json(
        {
          error: "One or more media ids are unknown, not owned by you, or expired.",
          invalidIds,
        },
        403,
      );
    }

    const urls = requestedIds.map((id) =>
      buildSignedMediaUrl({ id, publicBaseUrl: config.publicBaseUrl, now: now() }),
    );
    return c.json({ urls }, 200);
  };
}

// ---------------------------------------------------------------------------
// GET /media/:id?exp=…&sig=… — HMAC-only signed fetch (unauthenticated)
// ---------------------------------------------------------------------------
export function createMediaGetHandler(deps: MediaHandlerDeps = {}) {
  const { getConfig, makeStore, prisma, now } = resolveDeps(deps);

  return async (c: Context): Promise<Response> => {
    const config = getConfig();
    // Don't reveal whether media is configured to unauthenticated callers.
    if (!config) return c.text("Not found", 404);

    const id = c.req.param("id");
    // Validate the id shape at the boundary (traversal / overlong / empty) so an
    // unsafe id fails closed as 404 rather than reaching the store's assert and
    // becoming a 500. No raw id is echoed or logged.
    if (!isSafeMediaId(id)) return c.text("Not found", 404);

    const check = verifyMediaSignature({
      id,
      exp: c.req.query("exp"),
      sig: c.req.query("sig"),
      now: now(),
    });
    if (!check.ok) {
      // Signature problems are a distinct, non-existence-revealing failure.
      return c.text("Forbidden", 403);
    }

    const asset = await prisma.mediaAsset.findUnique({
      where: { id },
      select: { mime: true, expiresAt: true },
    });
    if (!asset) return c.text("Not found", 404);

    // Lazy expiry: an expired asset is deleted on access, then 404s.
    if (asset.expiresAt.getTime() <= now()) {
      await makeStore(config).delete(id);
      await prisma.mediaAsset.delete({ where: { id } }).catch(() => {});
      return c.text("Not found", 404);
    }

    const object = await makeStore(config).getStream(id);
    if (!object) return c.text("Not found", 404);

    const headers = new Headers({
      "Content-Type": asset.mime,
      "Content-Length": String(object.sizeBytes),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Cache-Control": "private, max-age=300",
      "Content-Disposition": "inline",
    });
    const webStream = Readable.toWeb(object.stream) as unknown as ReadableStream<Uint8Array>;
    return new Response(webStream, { status: 200, headers });
  };
}

// ===========================================================================
// Admin media policy routes (verified-admin gated in index.ts via mediaAdminGate)
// ---------------------------------------------------------------------------
// Metadata / policy ONLY. These never return ids, owners, mimes, signed URLs,
// or anything that could open user content — the asset plan forbids admin
// view/download of assets. Purge/delete-all actions are audit-logged with the
// admin's user id and row/byte COUNTS only (never filenames or content).
// ===========================================================================

/** Structured audit line for a destructive admin media action. Counts only. */
function auditMediaAction(
  action: "purge-expired" | "delete-all",
  adminUserId: string,
  counts: { rows: number; bytes: number },
): void {
  console.log(
    `[media][audit] action=${action} admin=${adminUserId} rows=${counts.rows} bytes=${counts.bytes}`,
  );
}

// ---------------------------------------------------------------------------
// GET /api/internal/media/admin/stats — capability + aggregate stats
// ---------------------------------------------------------------------------
export function createMediaAdminStatsHandler(deps: MediaHandlerDeps = {}) {
  const { getConfig, prisma, getTtlHours, now } = resolveDeps(deps);

  return async (c: Context): Promise<Response> => {
    const config = getConfig();
    const ttlHours = await getTtlHours();
    const stats = await getMediaStats({ prisma, now: new Date(now()) });

    return c.json(
      {
        uploadEnabled: config !== null,
        ttl: {
          hours: ttlHours,
          min: MEDIA_ASSET_TTL_MIN_HOURS,
          max: MEDIA_ASSET_TTL_MAX_HOURS,
          default: MEDIA_ASSET_TTL_DEFAULT_HOURS,
        },
        stats,
      },
      200,
    );
  };
}

// ---------------------------------------------------------------------------
// POST /api/internal/media/admin/purge-expired — reclaim expired assets now
// ---------------------------------------------------------------------------
export function createMediaAdminPurgeExpiredHandler(deps: MediaHandlerDeps = {}) {
  const { getConfig, makeStore, prisma, now } = resolveDeps(deps);

  return async (c: Context): Promise<Response> => {
    const user = sessionUser(c);
    if (!user) return c.text("Not found", 404);

    const config = getConfig();
    if (!config) return c.json({ error: MEDIA_NOT_CONFIGURED_MESSAGE }, 501);

    const removed = await sweepExpiredMedia({
      store: makeStore(config),
      prisma,
      now: new Date(now()),
    });
    auditMediaAction("purge-expired", user.id, { rows: removed, bytes: 0 });

    return c.json({ removed }, 200);
  };
}

// ---------------------------------------------------------------------------
// POST /api/internal/media/admin/delete-all — danger zone: wipe all assets
// ---------------------------------------------------------------------------
export function createMediaAdminDeleteAllHandler(deps: MediaHandlerDeps = {}) {
  const { getConfig, makeStore, prisma } = resolveDeps(deps);

  return async (c: Context): Promise<Response> => {
    const user = sessionUser(c);
    if (!user) return c.text("Not found", 404);

    const config = getConfig();
    if (!config) return c.json({ error: MEDIA_NOT_CONFIGURED_MESSAGE }, 501);

    const { removed, bytes } = await deleteAllMedia({ store: makeStore(config), prisma });
    auditMediaAction("delete-all", user.id, { rows: removed, bytes });

    return c.json({ removed, bytes }, 200);
  };
}
