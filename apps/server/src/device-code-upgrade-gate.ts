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
 * The body formats the gate reads, decided as Better Call (Better Auth's
 * router, `better-call` `getBody`) decides them: the whole header lowercased,
 * a JSON media type (`application/json`, `application/*+json`) first, then
 * `application/x-www-form-urlencoded` anywhere in it. Anything else is
 * refused.
 */
const JSON_MEDIA_TYPE = /^application\/([a-z0-9.+-]*\+)?json/i;

type BodyFormat = "json" | "form" | "other";

function bodyFormat(contentType: string): BodyFormat {
  const normalized = contentType.toLowerCase();
  if (JSON_MEDIA_TYPE.test(normalized)) return "json";
  if (normalized.includes("application/x-www-form-urlencoded")) return "form";
  return "other";
}

/**
 * The only `/device/code` fields forwarded to Better Auth. Its schema also
 * accepts `user_id`, which stores `userId: request.user_id || null` and so
 * pre-binds the new code to that account; the endpoint is public and
 * unauthenticated, so any caller could bind a code to an arbitrary account
 * before anyone approves anything. wsmp's CLI sends exactly these two fields.
 */
const FORWARDED_FIELDS = ["client_id", "scope"] as const;

type Fields = Partial<Record<(typeof FORWARDED_FIELDS)[number], string>>;

type GateRead =
  | { kind: "fields"; fields: Fields }
  | { kind: "too_large" }
  | { kind: "unsupported_media_type" }
  | { kind: "unparsable" };

/** The allowlisted string fields of a JSON object or form body. */
function pickFields(get: (name: string) => unknown): Fields {
  const fields: Fields = {};
  for (const name of FORWARDED_FIELDS) {
    const value = get(name);
    if (typeof value === "string") fields[name] = value;
  }
  return fields;
}

async function readRequest(c: Context): Promise<GateRead> {
  const declared = c.req.header("content-length");
  if (declared !== undefined) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > DEVICE_CODE_BODY_MAX_BYTES)
      return { kind: "too_large" };
  }
  const format = bodyFormat(c.req.header("content-type") ?? "");
  if (format === "other") return { kind: "unsupported_media_type" };
  const read = await readCapped(c.req.raw, DEVICE_CODE_BODY_MAX_BYTES);
  if (read.kind === "too_large") return read;
  if (read.kind === "unreadable") return { kind: "unparsable" };
  if (format === "form") {
    const params = new URLSearchParams(read.text);
    return { kind: "fields", fields: pickFields((name) => params.get(name) ?? undefined) };
  }
  let value: unknown;
  try {
    value = JSON.parse(read.text);
  } catch {
    return { kind: "unparsable" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "unparsable" };
  const record = value as Record<string, unknown>;
  return {
    kind: "fields",
    fields: pickFields((name) => (Object.hasOwn(record, name) ? record[name] : undefined)),
  };
}

/**
 * The request Better Auth sees: the allowlisted fields as a JSON body with
 * exactly `application/json` and a re-stated `Content-Length`. Better Auth
 * reads a device-code body twice (Better Call by media type, then the plugin
 * re-reads the raw text as a form whenever the Content-Type merely contains
 * the form type), so forwarding the caller's bytes or header would let a
 * second parse find fields the gate never saw. One representation, built from
 * what the gate parsed, leaves nothing else to find.
 */
function forwardedRequest(request: Request, fields: Fields): Request {
  const body = JSON.stringify(fields);
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  headers.set("content-length", String(new TextEncoder().encode(body).byteLength));
  // The body is now buffered: drop a chunked framing header that would
  // contradict the stated length.
  headers.delete("transfer-encoding");
  const init: RequestInit & { duplex?: "half" } = { body, headers };
  return new Request(request, init);
}

/**
 * The one entry point to Better Auth's public `POST /api/auth/device/code`.
 *
 * A body over {@link DEVICE_CODE_BODY_MAX_BYTES} is refused with 413, a body
 * that is not JSON or a form with 415, and one that is not a JSON object with
 * 400. Every other request reaches Better Auth only as
 * {@link forwardedRequest}: its `client_id` and `scope`, nothing else.
 *
 * A request without a `scope` comes from a wsmp older than 0.4.0 (every newer
 * `wsmp login` sends `cli-slug:<slug>`). Those releases print only the HTTP
 * status for a refused start, so instead of Better Auth's
 * `400 invalid_scope` they get a start response whose device code the
 * exchange refuses with the upgrade message, which they do print. No device
 * code row is created, and the code approves nothing. The body also carries
 * the RFC 8628 `error` / `error_description`, for any client that reads them.
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
  if (result.kind === "unparsable") {
    return c.json(
      {
        error: "invalid_request",
        error_description: "The request body must be a JSON object or a form.",
      },
      400,
    );
  }
  const { fields } = result;
  if (fields.scope !== undefined && fields.scope.trim().length > 0) {
    c.req.raw = forwardedRequest(c.req.raw, fields);
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
