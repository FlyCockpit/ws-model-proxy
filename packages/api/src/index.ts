/**
 * oRPC base procedures. Every 0.4.0 procedure is bound to its contract through
 * `contract-procedure.ts`, which picks the access check from the contract's access tag; the
 * named bases below are the same checks for code outside the contract tree.
 */
import { ORPCError, os } from "@orpc/server";
import type { Session } from "@ws-model-proxy/auth";
import { isForceTwoFactorRequired } from "@ws-model-proxy/auth/force-two-factor-policy";
import { isAdminRole } from "@ws-model-proxy/auth/roles";
import type { Context } from "./context";
import { callerMayReach, isHumanCaller } from "./contracts/auth-context";
import type { ProcedureAccess } from "./contracts/procedure";

const o = os.$context<Context>();

export const publicProcedure = o;

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

function accessMiddleware(access: Exclude<ProcedureAccess, "public">) {
  return o.middleware(async ({ context, next }) => {
    const session = await assertAccess(access, context);
    return next({ context: { session } });
  });
}

/** A signed-in person on `/rpc` (cookie session). */
export const protectedProcedure = o.use(accessMiddleware("session"));

/** A signed-in person, or an MCP agent token whose tool calls this procedure. */
export const agentProcedure = o.use(accessMiddleware("agent"));

/** Only a person: cookie session with a verified CSRF header (§6.3). Never MCP. */
export const humanProcedure = o.use(accessMiddleware("human"));

/** A verified admin; NOT_FOUND for everyone else. */
export const adminProcedure = o.use(accessMiddleware("admin"));

/** A verified admin acting as a person (CSRF verified). */
export const humanAdminProcedure = o.use(accessMiddleware("human_admin"));

export { isHumanCaller };
