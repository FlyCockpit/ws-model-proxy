import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import type { ModelApiTokenIdentity } from "@ws-model-proxy/api/lib/model-api-token-access";
import defaultPrisma from "@ws-model-proxy/db";
import type { Context } from "hono";
import { getMediaConfig, type MediaConfig } from "../media/config.js";
import { MediaQuotaExceededError, uploadMedia } from "../media/service.js";
import { buildSignedMediaUrl } from "../media/signing.js";
import { MediaTypeNotAllowedError } from "../media/sniff.js";
import {
  isSafeMediaId,
  LocalMediaStore,
  type MediaStore,
  MediaTooLargeError,
} from "../media/store.js";
import { getMediaAssetTtlHours } from "../media/ttl.js";
import { openAiErrorBody, openAiFailureJsonResponse } from "./openai-errors.js";
import { authenticateRequest } from "./routes.js";

// ===========================================================================
// Harness-facing /v1 media upload (bearer model-token auth).
// ---------------------------------------------------------------------------
// Same storage backend, sniff allowlist, per-user dedup, and TTL as the
// session-authenticated /api/internal/media routes — but authenticated with the
// SAME bearer model token as the rest of /v1 (no cookies, no CSRF, no browser
// CORS). Assets are owned by the token's user. The response is OpenAI Files-
// adjacent JSON with two additive fields (`url`, `url_expires_at`) so a harness
// can paste the signed URL straight into an image_url/video_url/input_audio part.
// ===========================================================================

type MediaPrisma = Pick<typeof defaultPrisma, "mediaAsset">;

/** Dependency seam so tests can inject auth, a temp-dir store, mock prisma, and clock. */
export interface ModelApiFilesDeps {
  authenticate?: (request: Request) => Promise<ModelApiTokenIdentity | null>;
  getConfig?: () => MediaConfig | null;
  makeStore?: (config: MediaConfig) => MediaStore;
  prisma?: MediaPrisma;
  getTtlHours?: () => Promise<number>;
  now?: () => number;
}

function resolveDeps(deps: ModelApiFilesDeps) {
  return {
    authenticate: deps.authenticate ?? authenticateRequest,
    getConfig: deps.getConfig ?? getMediaConfig,
    makeStore: deps.makeStore ?? ((config: MediaConfig) => new LocalMediaStore(config.root)),
    prisma: deps.prisma ?? (defaultPrisma as unknown as MediaPrisma),
    getTtlHours: deps.getTtlHours ?? getMediaAssetTtlHours,
    now: deps.now ?? (() => Date.now()),
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function openAiError({
  status,
  message,
  code,
  type = "invalid_request_error",
  param = null,
}: {
  status: number;
  message: string;
  code: string;
  type?: string;
  param?: string | null;
}): Response {
  return jsonResponse(openAiErrorBody({ message, type, code, param }), status);
}

const MEDIA_NOT_CONFIGURED_API_MESSAGE =
  "Media upload is not configured on this server. Send images/audio/video as base64 data URLs or external https URLs in your chat parts instead.";

function mediaNotConfiguredResponse(): Response {
  // 501 Not Implemented: the deploy has no media store. OpenAI-shaped so
  // harnesses can branch on error.code without special-casing our body format.
  return openAiError({
    status: 501,
    message: MEDIA_NOT_CONFIGURED_API_MESSAGE,
    code: "media_not_configured",
    type: "api_error",
  });
}

/**
 * Sanitize the client-supplied multipart filename for echo-back only. Strips
 * path separators, control chars, and trims length; returns null when nothing
 * usable remains. The stored/served identity is the asset id + sniffed mime —
 * this name is cosmetic (never used to derive a path).
 */
function sanitizeFilename(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  // Drop any directory component a client might send (e.g. "../../x.png").
  const base = raw.split(/[\\/]/).pop() ?? "";
  // Strip ASCII control chars (0x00-0x1f, 0x7f) without a control-char regex.
  let cleaned = "";
  for (const ch of base) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) cleaned += ch;
  }
  cleaned = cleaned.trim();
  if (!cleaned) return null;
  return cleaned.slice(0, 255);
}

function unixSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

/**
 * OpenAI Files-adjacent JSON. `url` + `url_expires_at` are ADDITIVE: the signed
 * URL is short-lived (~10 min). After it expires, re-mint a fresh one with
 * GET /v1/files/{id} — the asset itself lives for the (hours-long) TTL.
 */
function fileObject({
  id,
  sizeBytes,
  createdAtUnix,
  expiresAt,
  filename,
  signedUrl,
  signatureExpiresAtUnix,
}: {
  id: string;
  sizeBytes: number;
  createdAtUnix: number;
  expiresAt: Date;
  filename: string | null;
  signedUrl: string;
  signatureExpiresAtUnix: number;
}) {
  return {
    id,
    object: "file" as const,
    bytes: sizeBytes,
    created_at: createdAtUnix,
    expires_at: unixSeconds(expiresAt.getTime()),
    filename,
    purpose: "vision" as const,
    // Short-lived signed URL; GET /v1/files/{id} re-mints after it expires.
    url: signedUrl,
    url_expires_at: signatureExpiresAtUnix,
  };
}

// ---------------------------------------------------------------------------
// POST /v1/files — multipart upload (bearer model-token auth)
// ---------------------------------------------------------------------------
export function createModelApiFileUploadHandler(deps: ModelApiFilesDeps = {}) {
  const { authenticate, getConfig, makeStore, prisma, getTtlHours, now } = resolveDeps(deps);

  return async (c: Context): Promise<Response> => {
    const token = await authenticate(c.req.raw);
    if (!token) {
      return openAiFailureJsonResponse("access_denied", "Missing or invalid model API token.");
    }

    const config = getConfig();
    if (!config) return mediaNotConfiguredResponse();

    let file: File | null = null;
    try {
      const form = await c.req.formData();
      const value = form.get("file");
      if (value instanceof File) file = value;
    } catch {
      return openAiError({
        status: 400,
        message: "Expected a multipart/form-data body with a `file` field.",
        code: "invalid_multipart",
      });
    }
    if (!file) {
      return openAiError({
        status: 400,
        message: "Missing `file` field in multipart body.",
        code: "missing_file",
        param: "file",
      });
    }

    const nowMs = now();
    const source = Readable.fromWeb(file.stream() as unknown as NodeWebReadableStream<Uint8Array>);

    try {
      const result = await uploadMedia({
        source,
        userId: token.userId,
        store: makeStore(config),
        ttlHours: await getTtlHours(),
        maxUploadBytes: config.maxUploadBytes,
        maxBytesPerUser: config.maxBytesPerUser,
        prisma,
        now: new Date(nowMs),
      });
      const signed = buildSignedMediaUrl({
        id: result.id,
        publicBaseUrl: config.publicBaseUrl,
        now: nowMs,
      });
      return jsonResponse(
        fileObject({
          id: result.id,
          sizeBytes: result.sizeBytes,
          // Use the asset's real createdAt (older than `now` on a dedup hit) so
          // POST agrees with GET /v1/files/{id} for the same asset.
          createdAtUnix: unixSeconds(result.createdAt.getTime()),
          expiresAt: result.expiresAt,
          filename: sanitizeFilename(file.name),
          signedUrl: signed.url,
          signatureExpiresAtUnix: unixSeconds(Date.parse(signed.signatureExpiresAt)),
        }),
        200,
      );
    } catch (err) {
      if (err instanceof MediaTypeNotAllowedError) {
        // 415-style rejection; the error message names the full allowlist.
        return openAiError({
          status: 415,
          message: err.message,
          code: "unsupported_media_type",
        });
      }
      if (err instanceof MediaQuotaExceededError) {
        // OpenAI-shaped 413; the message names the byte quota.
        return openAiError({
          status: 413,
          message: err.message,
          code: "storage_quota_exceeded",
        });
      }
      if (err instanceof MediaTooLargeError) {
        // Same request_too_large (429) shape as the /v1/files bodyLimit onError.
        return openAiError({
          status: 429,
          message: "Model API request body is too large.",
          code: "request_too_large",
          type: "rate_limit_error",
        });
      }
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// GET /v1/files/{id} — owner-checked re-sign (bearer model-token auth)
// ---------------------------------------------------------------------------
// The harness re-sign path: multi-turn conversations outlive the ~10-min signed
// URL, so a harness re-fetches a fresh `url` here. Unknown, unowned, and expired
// assets all collapse to 404 (lazy-expiry, consistent with GET /media).
export function createModelApiFileGetHandler(deps: ModelApiFilesDeps = {}) {
  const { authenticate, getConfig, makeStore, prisma, now } = resolveDeps(deps);

  return async (c: Context): Promise<Response> => {
    const token = await authenticate(c.req.raw);
    if (!token) {
      return openAiFailureJsonResponse("access_denied", "Missing or invalid model API token.");
    }

    const id = c.req.param("id");
    // Validate id shape at the boundary so a traversal / overlong / empty id
    // fails closed as 404 before it can reach the store's assert (a 500). Use a
    // generic message that never echoes the raw id for the unsafe case.
    if (!isSafeMediaId(id)) {
      return openAiFailureJsonResponse("not_found", "No file found with the requested id.");
    }
    const notFound = () => openAiFailureJsonResponse("not_found", `No file found with id '${id}'.`);

    const config = getConfig();
    // No media store => no assets to return. 404 rather than leaking capability.
    if (!config) return notFound();

    const nowMs = now();
    const asset = await prisma.mediaAsset.findUnique({
      where: { id },
      select: { userId: true, sizeBytes: true, expiresAt: true, createdAt: true },
    });
    // Owner check + existence collapse to a single 404: a foreign or unknown id
    // is indistinguishable, so ownership can't be probed.
    if (!asset || asset.userId !== token.userId) return notFound();

    // Lazy expiry: an expired asset is deleted on access, then 404s.
    if (asset.expiresAt.getTime() <= nowMs) {
      await makeStore(config).delete(id);
      await prisma.mediaAsset.delete({ where: { id } }).catch(() => {});
      return notFound();
    }

    const signed = buildSignedMediaUrl({ id, publicBaseUrl: config.publicBaseUrl, now: nowMs });
    return jsonResponse(
      fileObject({
        id,
        sizeBytes: asset.sizeBytes,
        createdAtUnix: unixSeconds(asset.createdAt.getTime()),
        expiresAt: asset.expiresAt,
        // Filename is not persisted (metadata-only schema), so re-sign returns null.
        filename: null,
        signedUrl: signed.url,
        signatureExpiresAtUnix: unixSeconds(Date.parse(signed.signatureExpiresAt)),
      }),
      200,
    );
  };
}
