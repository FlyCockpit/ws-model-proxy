import type { Context, Next } from "hono";

import {
  requireImpersonatorIsVerifiedAdmin,
  requireVerifiedAdminSession,
} from "./admin-session-gate";

// Better-Auth's admin plugin exposes a parallel management API under
// `/api/auth/admin/*`. Its built-in route checks validate the role, but they
// do not know this app also requires verified email and any globally forced
// second factor. Gate the whole plugin surface before `auth.handler`.
export async function betterAuthAdminGate(c: Context, next: Next) {
  // Only this exact POST checks the saved original actor. The target's role
  // never authorizes another management path, including near-misses.
  const result =
    c.req.method === "POST" && c.req.path === "/api/auth/admin/stop-impersonating"
      ? await requireImpersonatorIsVerifiedAdmin(c.req.raw.headers)
      : await requireVerifiedAdminSession(c.req.raw.headers);
  if (!result.ok) {
    return c.json(
      { error: result.error, error_description: result.errorDescription },
      result.status,
    );
  }
  const path = c.req.path;
  let procedure: string | undefined;
  if (path === "/api/auth/admin/set-role") procedure = "users.setRole";
  if (path === "/api/auth/admin/unban-user") procedure = "users.unarchive";
  if (path === "/api/auth/admin/ban-user") procedure = "users.archive";
  if (path === "/api/auth/admin/remove-user") procedure = "users.remove";
  if (path === "/api/auth/admin/update-user") {
    // Inspect a clone so supported profile updates still reach Better Auth
    // with their body intact. Invalid JSON remains Better Auth's concern.
    const body: unknown = await c.req.raw
      .clone()
      .json()
      .catch(() => null);
    if (body && typeof body === "object" && "data" in body) {
      const data = body.data;
      if (data && typeof data === "object") {
        if ("role" in data) procedure = "users.setRole";
        else if ("banned" in data || "banExpires" in data) procedure = "users.archive";
        else if ("emailVerified" in data) procedure = "users";
      }
    }
  }
  if (procedure) {
    return c.json(
      {
        error: "USE_ORPC_USER_MANAGEMENT",
        error_description: `Use the oRPC ${procedure} procedure for user access changes.`,
      },
      403,
    );
  }
  await next();
}
