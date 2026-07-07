import { auth } from "@ws-model-proxy/auth";
import type { Context, Next } from "hono";

// Signed-in-user gate for the Better-Auth deviceAuthorization plugin's
// approve/deny endpoints (`/api/auth/device/approve` and
// `/api/auth/device/deny`). CLI device auth is user-owned in this product:
// regular users may approve their own CLI login from their current browser
// session. Admin-only global device management remains separate under the
// admin oRPC devices router.
//
// We deliberately use `403 access_denied` for signed-in-but-ineligible users
// because this surface is not 404-hidden: the device-flow itself is bootstrapped
// from a public OAuth endpoint. Hiding
// the exact failure mode here would only obscure normal end-user errors
// without changing the security boundary.
//
// The error shape matches what the deviceAuthorization plugin returns in
// other failure modes (`error` + `error_description`), so the better-auth
// client surfaces it through `result.error.error_description` in the same
// way the UI already expects.
export async function deviceAdminGate(c: Context, next: Next) {
  let session: Awaited<ReturnType<typeof auth.api.getSession>> | null = null;
  try {
    session = await auth.api.getSession({ headers: c.req.raw.headers });
  } catch {
    session = null;
  }
  if (!session?.user) {
    return c.json({ error: "access_denied", error_description: "Authentication required" }, 401);
  }
  await next();
}
