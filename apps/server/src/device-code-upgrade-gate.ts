import {
  CLI_DEVICE_LOGIN_UPGRADE_DEVICE_CODE,
  CLI_LOGIN_UPGRADE_REQUIRED_MESSAGE,
} from "@ws-model-proxy/config/cli-device-login";
import type { Context, Next } from "hono";

/** Oversized bodies are left to Better Auth's own limits. */
const DEVICE_CODE_BODY_MAX_BYTES = 16 * 1024;

async function requestScope(c: Context): Promise<{ read: boolean; scope: unknown }> {
  const length = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(length) && length > DEVICE_CODE_BODY_MAX_BYTES) {
    return { read: false, scope: undefined };
  }
  const contentType = c.req.header("content-type") ?? "";
  try {
    const text = await c.req.raw.clone().text();
    if (text.length > DEVICE_CODE_BODY_MAX_BYTES) return { read: false, scope: undefined };
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const scope = new URLSearchParams(text).get("scope");
      return { read: true, scope: scope ?? undefined };
    }
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { read: false, scope: undefined };
    }
    return { read: true, scope: (parsed as Record<string, unknown>).scope };
  } catch {
    return { read: false, scope: undefined };
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
 * Better Auth unchanged.
 */
export async function deviceCodeUpgradeGate(c: Context, next: Next) {
  if (c.req.method !== "POST") return next();
  const { read, scope } = await requestScope(c);
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
