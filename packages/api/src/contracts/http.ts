/**
 * Plain HTTP endpoints a node uses before it has a relay session (not oRPC). Served by
 * `apps/server` (`well-known.ts`, the enrollment route, `install-script.ts`).
 */
import { z } from "zod";
import { idSchema, nodeSlugSchema } from "./common";

export const RELAY_PROTOCOL = "3.0";

/** `GET /.well-known/wsmp`: what `wsmp login <url>` checks and pins (SEC-13). */
export const wellKnownWsmpSchema = z
  .object({
    serverVersion: z.string(),
    protocolVersion: z.literal(RELAY_PROTOCOL),
    /** Canonical public origin (pinned by the node). */
    origin: z.string().url(),
    installScript: z.literal("/install.sh"),
    enrollPath: z.literal("/api/node/enroll"),
  })
  .strict();

export const ENROLLMENT_CODE_PATTERN = /^wsmp_enr_[A-Z2-7]{26}$/;

/** `POST /api/node/enroll`. Rate-limited per IP (10 / 15 min) and per user (20 / h); failures count. */
export const nodeEnrollRequestSchema = z
  .object({
    code: z.string().regex(ENROLLMENT_CODE_PATTERN),
    /** Uncompressed P-256 public key, unpadded base64url. */
    identityPublicKey: z.string().regex(/^B[A-Za-z0-9_-]{85}[AEIMQUYcgkosw048]$/),
    slug: nodeSlugSchema,
    hostname: z.string().max(1_024).optional(),
    /** The person confirmed "this replaces node <slug>" (`--replace` or a TTY yes). */
    replaceConfirmed: z.boolean().default(false),
  })
  .strict();

export const nodeEnrollResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      nodeId: idSchema,
      slug: nodeSlugSchema,
      /** Shown once; stored in `node-credential.json` (0600). */
      credential: z.string().min(32).max(256),
      /** Set when the code was a Replace code: the node now lives on this identity. */
      replaced: z.object({ slug: nodeSlugSchema }).strict().nullable(),
      /** The replaced node was Relay only: this node is lowered on its first hello. */
      trustLowerPending: z.boolean(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.enum([
        "invalid_code",
        "expired",
        "used",
        "revoked",
        "slug_taken",
        "replace_confirmation_required",
        "rate_limited",
      ]),
      /** For `replace_confirmation_required`: the node the code replaces. */
      replaces: z.object({ slug: nodeSlugSchema }).strict().optional(),
      retryAfterSec: z.number().int().optional(),
    })
    .strict(),
]);

// ── Web Test page → /v1 (spec §7.2 #4) ──
//
// The Test page calls the public API routes (`/v1/chat/completions`, `/v1/embeddings`,
// `/v1/audio/transcriptions`, `/v1/realtime`) with the person's session instead of an API key,
// so streaming, attachments and live STT run through the real path. Such a request:
// - carries the Better Auth session cookie, an `Origin` equal to the public origin, and the
//   header `x-wsmp-test: 1` (WebSocket upgrades, which cannot set headers, use `?test=1`);
// - is recorded with source TEST and never accepts an API key at the same time;
// - names a callable ID (`owner/pool[:external]`, as with an API key) or, Test page only, one of
//   the person's served models directly as `runtime:<runtimeId>:<upstreamModelId>`. Direct
//   names are refused with an API key (D1: the public API serves pools only).
// - may pin an instance with `x-wsmp-instance: <instanceId>` (direct names only).

export const TEST_REQUEST_HEADER = "x-wsmp-test";
export const TEST_INSTANCE_HEADER = "x-wsmp-instance";
export const TEST_REALTIME_QUERY = "test";

/** `runtime:<runtimeId>:<upstreamModelId>`; the model id may contain `:` and `/`. */
export const DIRECT_TEST_MODEL_PATTERN = /^runtime:([A-Za-z0-9_-]{1,128}):(.{1,256})$/;
