/**
 * Restore contract for a user whose deletion is pending (`deletionRequestedAt`
 * set). The marker is authoritative on its own: only the deletion subsystem
 * clears it (`abandonUserDeletion`, predicated on the marker generation the
 * worker selected), and the deletion still completes whatever the ban fields
 * hold.
 *
 * Commit point: {@link refuseSessionForDeletingUser} is a plain read before
 * the adapter's separate INSERT, so on its own it cannot stop a mark that
 * commits in between. The proof is the `session_refuse_deleting_user` trigger
 * (packages/db/prisma/schema-hardening.sql): the INSERT reads its owner FOR
 * SHARE and is refused (SQLSTATE {@link SESSION_REFUSED_SQLSTATE}) once the
 * marker is set, and a session that committed first is removed by the mark's
 * own DELETE. The hook gives the ordinary case its 403; the rare race surfaces
 * as the trigger's error, which {@link mapSessionRefusalToForbidden} turns into
 * the same 403 on the HTTP handler.
 *
 * Better Auth cannot be relied on to keep the ban that `requestUserDeletion`
 * sets: `/admin/unban-user` clears it, `/admin/update-user` writes arbitrary
 * fields, `/admin/ban-user` with `banExpiresIn` turns it into a temporary
 * ban, and the admin plugin's own `session.create.before` clears an expired
 * ban and lets the session through. So the contract is enforced at the
 * consumers:
 * - session creation: {@link refuseSessionForDeletingUser} (every session
 *   mint: sign-in, impersonation; the device-code exchange mints a
 *   `cli_device_credential`, not a session);
 * - MCP admission, CLI credentials, model API tokens, relay registration and
 *   CLI command admission: `userCredentialAccessBlocked` in
 *   `@ws-model-proxy/db/user-deletion-access`.
 *
 * As defense in depth (not the proof: the check below and the route's write
 * are separate statements) the admin routes that would restore or reshape a
 * pending user are refused with CONFLICT ({@link refuseAdminRestoreOfDeletingUser}),
 * mirroring the dashboard's `users.unarchive`. A racing admin write that lands
 * after the mark has no effect on the outcome: while pending every consumer
 * denies on the marker, completion deletes the user, and an abandon re-asserts
 * the indefinite ban in the statement that clears the marker
 * (`abandonUserDeletion`). The observable outcome of a restore attempt is
 * therefore "refused" or "no effect", never "access regained, then deleted".
 */
import prisma from "@ws-model-proxy/db";
import { APIError } from "better-auth/api";

export const USER_DELETION_PENDING_MESSAGE =
  "This user is being deleted; the account cannot sign in or be restored.";

/** Admin routes that change a target user's access, role, identity or credentials. */
export const ADMIN_USER_RESTORE_PATHS: ReadonlySet<string> = new Set([
  "/admin/unban-user",
  "/admin/ban-user",
  "/admin/update-user",
  "/admin/set-role",
  "/admin/set-user-password",
  "/admin/impersonate-user",
]);

/** A pending deletion, or no row at all (deleted): the admin cannot act. */
async function impersonatorRefused(userId: string): Promise<boolean> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { deletionRequestedAt: true },
  });
  return row === null || row.deletionRequestedAt != null;
}

async function deletionPending(userId: string): Promise<boolean> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { deletionRequestedAt: true },
  });
  return row?.deletionRequestedAt != null;
}

/**
 * `databaseHooks.session.create.before`: refuses to mint a session for a user
 * whose deletion is pending, whatever `banned` holds, and an impersonation
 * session (`impersonatedBy`) whose acting admin is pending deletion or gone.
 * Runs after the admin plugin's hook (plugin hooks run first), so an
 * expired-ban reset there does not let the session through.
 */
export async function refuseSessionForDeletingUser(session: {
  userId: string;
  impersonatedBy?: string | null;
}): Promise<void> {
  const impersonator = session.impersonatedBy;
  if (
    (await deletionPending(session.userId)) ||
    (typeof impersonator === "string" && (await impersonatorRefused(impersonator)))
  ) {
    throw new APIError("FORBIDDEN", {
      message: USER_DELETION_PENDING_MESSAGE,
      code: "USER_DELETION_PENDING",
    });
  }
}

/** SQLSTATE raised by the `session_refuse_deleting_user` trigger. */
export const SESSION_REFUSED_SQLSTATE = "WMPD1";

/**
 * True when `error` (a Prisma error, possibly wrapped) is the
 * `session_refuse_deleting_user` trigger refusing a session INSERT.
 */
export function isSessionRefusedForDeletingUser(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) continue;
    seen.add(candidate);
    for (const key of ["code", "originalCode"]) {
      if (Reflect.get(candidate, key) === SESSION_REFUSED_SQLSTATE) return true;
    }
    for (const key of ["meta", "driverAdapterError", "cause"])
      pending.push(Reflect.get(candidate, key));
  }
  return false;
}

/**
 * `onAPIError.onError` step: the trigger's refusal becomes the same 403 the
 * `session.create.before` hook gives (Better Auth's router answers a thrown
 * `APIError` from `onError` with that error's response). Anything else passes.
 */
export function mapSessionRefusalToForbidden(error: unknown): void {
  if (!isSessionRefusedForDeletingUser(error)) return;
  throw new APIError("FORBIDDEN", {
    message: USER_DELETION_PENDING_MESSAGE,
    code: "USER_DELETION_PENDING",
  });
}

/** Global `hooks.before` body: CONFLICT for an admin restore of a pending user. */
export async function refuseAdminRestoreOfDeletingUser(ctx: {
  path?: string;
  body?: unknown;
}): Promise<void> {
  if (!ctx.path || !ADMIN_USER_RESTORE_PATHS.has(ctx.path)) return;
  const body = ctx.body;
  const userId =
    typeof body === "object" && body !== null && "userId" in body ? body.userId : undefined;
  if (typeof userId !== "string" || userId.length === 0) return;
  if (await deletionPending(userId)) {
    throw new APIError("CONFLICT", {
      message: USER_DELETION_PENDING_MESSAGE,
      code: "USER_DELETION_PENDING",
    });
  }
}
