import type { Session } from "@ws-model-proxy/auth";
import { isForceTwoFactorRequired } from "@ws-model-proxy/auth/force-two-factor-policy";
import { isAdminRole } from "@ws-model-proxy/auth/roles";
import type { Context, Next } from "hono";

// Verified-admin gate for the internal media-admin routes (stats / purge /
// delete-all). It reads the session already resolved by `sessionMiddleware`
// (so the rate limiter can key on the user id and there's only one getSession
// per request) and applies the SAME rule as the oRPC `requireAdmin` middleware:
// verified email, admin role, and any globally forced second factor.
//
// It returns 404 for every failure mode (like `adminOr404Procedure`, which
// backs the admin dashboard surface these endpoints serve) so the existence of
// the media-admin API is never leaked to non-admins.
export async function mediaAdminGate(c: Context, next: Next) {
  const session = c.get("session") as Session | null | undefined;
  const user = session?.user;
  const notFound = () => c.text("Not found", 404);

  if (!user) return notFound();
  if (!user.emailVerified) return notFound();
  if (!isAdminRole(user.role)) return notFound();
  if ((await isForceTwoFactorRequired()) && !user.twoFactorEnabled) return notFound();

  await next();
}
