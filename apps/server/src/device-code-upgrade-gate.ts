import {
  CLI_DEVICE_LOGIN_UPGRADE_DEVICE_CODE,
  CLI_LOGIN_UPGRADE_REQUIRED_MESSAGE,
} from "@ws-model-proxy/config/cli-device-login";
import type { Context, MiddlewareHandler, Next } from "hono";
import { bodyLimit } from "hono/body-limit";

/**
 * A `wsmp login` start body is a few dozen bytes. Anything larger is refused
 * here with 413, whether it declares its length or not: a body without
 * `Content-Length` is read in chunks and the read stops at the first byte past
 * this cap, so at most one chunk beyond it is ever held.
 */
export const DEVICE_CODE_BODY_MAX_BYTES = 16 * 1024;

function tooLarge(c: Context) {
  return c.json({ error: "invalid_request", error_description: "Request body too large." }, 413);
}

/**
 * The same cap, mounted in app.ts BEFORE the app-wide 10 MB body limit: that
 * limit reads a body without `Content-Length` to its end before calling the
 * next middleware, so on its own it would buffer up to 10 MB of an
 * unauthenticated upload before {@link deviceCodeUpgradeGate} ever ran. This
 * one stops reading at the first chunk past the cap.
 */
export const deviceCodeBodyCap: MiddlewareHandler = bodyLimit({
  maxSize: DEVICE_CODE_BODY_MAX_BYTES,
  onError: tooLarge,
});

type BodyRead = { kind: "text"; text: string } | { kind: "too_large" } | { kind: "unreadable" };

/**
 * Reads a clone of the body up to `max` bytes. The clone tees the stream, so
 * the original still holds what was read for Better Auth; the tee only pulls
 * as far as this reader, which bounds that buffer to the cap plus one chunk.
 */
async function readCapped(request: Request, max: number): Promise<BodyRead> {
  const stream = request.clone().body;
  if (!stream) return { kind: "text", text: "" };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        // Not awaited: a tee branch's cancel settles only once the other
        // branch (the original body, never read on this path) is cancelled.
        reader.cancel().catch(() => undefined);
        return { kind: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: "unreadable" };
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "text", text: new TextDecoder().decode(bytes) };
}

/**
 * How Better Call (Better Auth's router) will parse the body, decided the same
 * way it decides (`better-call` `getBody`): the whole header lowercased, a JSON
 * media type (`application/json`, `application/*+json`) first, then
 * `application/x-www-form-urlencoded` anywhere in it. The gate must read the
 * body exactly as Better Auth will, or a body it cannot read (a mixed-case
 * `Application/X-Www-Form-Urlencoded`, say) would reach Better Auth with its
 * `user_id` intact.
 */
const JSON_MEDIA_TYPE = /^application\/([a-z0-9.+-]*\+)?json/i;

type BodyFormat = "json" | "form" | "other";

function bodyFormat(contentType: string): BodyFormat {
  const normalized = contentType.toLowerCase();
  if (JSON_MEDIA_TYPE.test(normalized)) return "json";
  if (normalized.includes("application/x-www-form-urlencoded")) return "form";
  return "other";
}

type ParsedBody =
  | { kind: "json"; record: Record<string, unknown> }
  | { kind: "form"; params: URLSearchParams }
  | { kind: "unparsable" };

type GateRead =
  | { kind: "body"; body: ParsedBody; scope: unknown }
  | { kind: "too_large" }
  | { kind: "unsupported_media_type" };

async function readRequest(c: Context): Promise<GateRead> {
  const declared = c.req.header("content-length");
  if (declared !== undefined) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > DEVICE_CODE_BODY_MAX_BYTES)
      return { kind: "too_large" };
  }
  const format = bodyFormat(c.req.header("content-type") ?? "");
  // `/device/code` accepts only JSON and form bodies (Better Auth answers
  // anything else with 415, or with a parse that never yields an object).
  // Refusing the rest here keeps every forwarded body one the gate parsed.
  if (format === "other") return { kind: "unsupported_media_type" };
  const read = await readCapped(c.req.raw, DEVICE_CODE_BODY_MAX_BYTES);
  if (read.kind === "too_large") return read;
  if (read.kind === "unreadable")
    return { kind: "body", body: { kind: "unparsable" }, scope: undefined };
  if (format === "form") {
    const params = new URLSearchParams(read.text);
    return {
      kind: "body",
      body: { kind: "form", params },
      scope: params.get("scope") ?? undefined,
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(read.text);
  } catch {
    return { kind: "body", body: { kind: "unparsable" }, scope: undefined };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "body", body: { kind: "unparsable" }, scope: undefined };
  }
  const record = value as Record<string, unknown>;
  return { kind: "body", body: { kind: "json", record }, scope: record.scope };
}

/**
 * The device-code body field that pre-binds a created code to an account.
 * Better Auth's `/device/code` schema accepts it and stores
 * `userId: request.user_id || null`, but the endpoint is public and
 * unauthenticated: any caller could otherwise create a code bound to an
 * arbitrary account id before anyone approves anything. wsmp's own CLI never
 * sends one, so stripping it only closes that gap. Returns the body with every
 * `user_id` removed, or null when the body carries none (pass it through
 * byte-identically). A body the gate could not parse as an object is one
 * Better Auth refuses too (400), so it passes through unchanged.
 */
function stripUserId(body: ParsedBody): string | null {
  if (body.kind === "form") {
    if (!body.params.has("user_id")) return null;
    body.params.delete("user_id");
    return body.params.toString();
  }
  if (body.kind !== "json") return null;
  const { record } = body;
  if (!Object.hasOwn(record, "user_id")) return null;
  delete record.user_id;
  return JSON.stringify(record);
}

/** A copy of `request` whose body is `body`, with `Content-Length` re-stated. */
function withBody(request: Request, body: string): Request {
  const headers = new Headers(request.headers);
  // The body is now buffered, so state its exact length and drop a chunked
  // framing header that would contradict it.
  headers.set("content-length", String(new TextEncoder().encode(body).byteLength));
  headers.delete("transfer-encoding");
  const init: RequestInit & { duplex?: "half" } = { body, headers };
  return new Request(request, init);
}

/**
 * `POST /api/auth/device/code` without a `scope` comes from a wsmp older than
 * 0.4.0 (every newer `wsmp login` sends `cli-slug:<slug>`). Those releases
 * print only the HTTP status for a refused start, so instead of Better Auth's
 * `400 invalid_scope` they get a start response whose device code the
 * exchange refuses with the upgrade message, which they do print. No device
 * code row is created, and the code approves nothing.
 *
 * The body also carries the RFC 8628 `error` / `error_description`, for any
 * client that reads them. A request with a scope (valid or not) goes on to
 * Better Auth with any caller-supplied `user_id` stripped, so a public,
 * unauthenticated caller cannot pre-bind a code to an arbitrary account (see
 * {@link stripUserId}). A body over {@link DEVICE_CODE_BODY_MAX_BYTES} is
 * refused with 413 before any of that.
 */
export async function deviceCodeUpgradeGate(c: Context, next: Next) {
  if (c.req.method !== "POST") return next();
  const result = await readRequest(c);
  if (result.kind === "too_large") return tooLarge(c);
  if (result.kind === "unsupported_media_type") {
    return c.json(
      {
        error: "invalid_request",
        error_description:
          "Content-Type must be application/json or application/x-www-form-urlencoded.",
      },
      415,
    );
  }
  const { body, scope } = result;
  if (body.kind === "unparsable" || (typeof scope === "string" && scope.trim().length > 0)) {
    // Never pre-bind a code to a caller-chosen account. The CLI sends no
    // `user_id`, so this is a no-op for it; a body without the key is
    // forwarded byte-identically.
    const stripped = stripUserId(body);
    if (stripped !== null) c.req.raw = withBody(c.req.raw, stripped);
    return next();
  }
  return c.json(
    {
      device_code: CLI_DEVICE_LOGIN_UPGRADE_DEVICE_CODE,
      user_code: "UPGRADE-WSMP",
      verification_uri: null,
      verification_uri_complete: null,
      expires_in: 60,
      interval: 1,
      error: "invalid_scope",
      error_description: CLI_LOGIN_UPGRADE_REQUIRED_MESSAGE,
    },
    200,
  );
}
