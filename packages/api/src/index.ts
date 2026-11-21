/** Contract-bound procedure access checks shared by all transports. */
import { ORPCError } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { isForceTwoFactorRequired } from "@ws-model-proxy/auth/force-two-factor-policy";
import { isAdminRole } from "@ws-model-proxy/auth/roles";
import type { Context } from "./context";
import { callerMayReach, isHumanCaller } from "./contracts/auth-context";
import type { ProcedureAccess } from "./contracts/procedure";

function forbidden(message: string) {
  return new ORPCError("FORBIDDEN", { message });
}

function notFound() {
  return new ORPCError("NOT_FOUND", { message: "Not found" });
}

async function assertTwoFactorPolicy(session: Session): Promise<void> {
  if ((await isForceTwoFactorRequired()) && !session.user.twoFactorEnabled) {
    throw forbidden("Two-factor authentication setup is required.");
  }
}

function isVerifiedAdmin(session: Session): boolean {
  return session.user.emailVerified && isAdminRole(session.user.role);
}

export type AdminAuthorityFailure = "not-admin" | "two-factor";

/**
 * The admin authority rule: verified email, admin role, then the forced-2FA policy. The one
 * definition: `assertAccess` applies the same two parts for the admin levels, and HTTP surfaces
 * reached without an oRPC context (`apps/server/src/admin-session-gate.ts`) call this instead of
 * re-deriving it.
 */
export async function checkAdminAuthority(
  session: Session,
): Promise<{ ok: true } | { ok: false; reason: AdminAuthorityFailure }> {
  if (!isVerifiedAdmin(session)) return { ok: false, reason: "not-admin" };
  if ((await isForceTwoFactorRequired()) && !session.user.twoFactorEnabled) {
    return { ok: false, reason: "two-factor" };
  }
  return { ok: true };
}

/**
 * The one access check, by contract access level (`contracts/procedure.ts`). Returns the
 * signed-in session; every non-public level needs one.
 *
 * - `admin` and `human_admin` hide themselves: a caller who is not a verified admin gets
 *   NOT_FOUND, so the admin surface does not leak.
 * - `human` is a positive check: a cookie session whose `x-csrf-token` was verified
 *   (`isHumanCaller`). An MCP token, an OAuth access token or a cookie without the header is
 *   refused, whatever the transport.
 */
export async function assertAccess(access: ProcedureAccess, context: Context): Promise<Session> {
  if (access === "public") {
    throw new Error("assertAccess is not used for public procedures");
  }
  const session = context.session;
  const hidden = access === "admin" || access === "human_admin";
  if (!session?.user || context.auth.kind === "anonymous") {
    throw hidden ? notFound() : new ORPCError("UNAUTHORIZED");
  }
  if (context.auth.userId !== session.user.id) {
    throw new ORPCError("UNAUTHORIZED");
  }
  if (hidden && !isVerifiedAdmin(session)) {
    throw notFound();
  }
  if (!callerMayReach(access, context.auth)) {
    if (access === "admin" || access === "session") throw notFound();
    throw forbidden("This action requires a person.");
  }
  await assertTwoFactorPolicy(session);
  return session;
}

export { isHumanCaller };
