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

type ScopeRead = { kind: "scope"; read: boolean; scope: unknown } | { kind: "too_large" };

async function requestScope(c: Context): Promise<ScopeRead> {
  const declared = c.req.header("content-length");
  if (declared !== undefined) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > DEVICE_CODE_BODY_MAX_BYTES)
      return { kind: "too_large" };
  }
  const body = await readCapped(c.req.raw, DEVICE_CODE_BODY_MAX_BYTES);
  if (body.kind === "too_large") return body;
  if (body.kind === "unreadable") return { kind: "scope", read: false, scope: undefined };
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const scope = new URLSearchParams(body.text).get("scope");
    return { kind: "scope", read: true, scope: scope ?? undefined };
  }
  try {
    const parsed: unknown = JSON.parse(body.text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "scope", read: false, scope: undefined };
    }
    return { kind: "scope", read: true, scope: (parsed as Record<string, unknown>).scope };
  } catch {
    return { kind: "scope", read: false, scope: undefined };
  }
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
 * Better Auth unchanged. A body over {@link DEVICE_CODE_BODY_MAX_BYTES} is
 * refused with 413 before any of that.
 */
export async function deviceCodeUpgradeGate(c: Context, next: Next) {
  if (c.req.method !== "POST") return next();
  const result = await requestScope(c);
  if (result.kind === "too_large") {
    return c.json({ error: "invalid_request", error_description: "Request body too large." }, 413);
  }
  const { read, scope } = result;
  if (!read || (typeof scope === "string" && scope.trim().length > 0)) return next();
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
