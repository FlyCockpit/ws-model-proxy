import {
  CLI_DEVICE_LOGIN_UPGRADE_DEVICE_CODE,
  CLI_LOGIN_UPGRADE_REQUIRED_MESSAGE,
} from "@ws-model-proxy/config/cli-device-login";
import type { Context, Next } from "hono";

/**
 * A `wsmp login` start body is a few dozen bytes. Anything larger is refused
 * here with 413, whether it declares its length or not: a body without
 * `Content-Length` is read in chunks and the read stops at the first byte past
 * this cap, so at most one chunk beyond it is ever held.
 */
export const DEVICE_CODE_BODY_MAX_BYTES = 16 * 1024;

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

type ScopeRead =
  | { kind: "scope"; read: boolean; scope: unknown; text: string; contentType: string }
  | { kind: "too_large" };

async function requestScope(c: Context): Promise<ScopeRead> {
  const declared = c.req.header("content-length");
  if (declared !== undefined) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > DEVICE_CODE_BODY_MAX_BYTES)
      return { kind: "too_large" };
  }
  const body = await readCapped(c.req.raw, DEVICE_CODE_BODY_MAX_BYTES);
  if (body.kind === "too_large") return body;
  const contentType = c.req.header("content-type") ?? "";
  if (body.kind === "unreadable") {
    return { kind: "scope", read: false, scope: undefined, text: "", contentType };
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const scope = new URLSearchParams(body.text).get("scope");
    return { kind: "scope", read: true, scope: scope ?? undefined, text: body.text, contentType };
  }
  try {
    const parsed: unknown = JSON.parse(body.text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "scope", read: false, scope: undefined, text: body.text, contentType };
    }
    return {
      kind: "scope",
      read: true,
      scope: (parsed as Record<string, unknown>).scope,
      text: body.text,
      contentType,
    };
  } catch {
    return { kind: "scope", read: false, scope: undefined, text: body.text, contentType };
  }
}

/**
 * The device-code body field that pre-binds a created code to an account.
 * Better Auth's `/device/code` schema accepts it and stores
 * `userId: request.user_id || null`, but the endpoint is public and
 * unauthenticated: any caller could otherwise create a code bound to an
 * arbitrary account id before anyone approves anything. wsmp's own CLI never
 * sends one, so stripping it only closes that gap. Returns the body with the
 * key removed, or null when the body carries no `user_id` (pass it through
 * byte-identically).
 */
function stripUserId(text: string, contentType: string): string | null {
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(text);
    if (!params.has("user_id")) return null;
    params.delete("user_id");
    return params.toString();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (!("user_id" in record)) return null;
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
  const result = await requestScope(c);
  if (result.kind === "too_large") {
    return c.json({ error: "invalid_request", error_description: "Request body too large." }, 413);
  }
  const { read, scope, text, contentType } = result;
  if (!read || (typeof scope === "string" && scope.trim().length > 0)) {
    // Never pre-bind a code to a caller-chosen account. The CLI sends neither
    // key, so this is a no-op for it; a body without the key is forwarded
    // byte-identically.
    const stripped = stripUserId(text, contentType);
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
