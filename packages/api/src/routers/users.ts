import { randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { auth } from "@ws-model-proxy/auth";
import { runWithAdminInviteLocale } from "@ws-model-proxy/auth/admin-invite-locale";
import { ADMIN_INVITED_PREFIX } from "@ws-model-proxy/auth/credential-setup-lock";
import { isUserBanned } from "@ws-model-proxy/auth/is-user-banned";
import {
  inviteStateSelect,
  isInvitePending,
  recordResetLinkMailed,
} from "@ws-model-proxy/auth/password-reset-links";
import { SIGNUP_DISABLED_CODE } from "@ws-model-proxy/auth/signup-policy";
import { notifyUserBanned } from "@ws-model-proxy/auth/user-ban-listeners";
import {
  notifyUserDeleted,
  notifyUserDeletionMarked,
} from "@ws-model-proxy/auth/user-deletion-listeners";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import {
  type DurableUserDeletionResult,
  deleteUserDurably,
  isPermanentParentDeletionFailure,
} from "@ws-model-proxy/db/parent-deletion";
import { isEmailConfigured, renderInviteUser, sendEmail } from "@ws-model-proxy/mailer";
import { contractProcedure } from "../contract-procedure";
import { usersContract as c } from "../contracts/account";
import {
  assertAdminRemovalAllowed,
  throwUserChangeError,
  withAdminRemovalGuard,
} from "../lib/admin-presence";
import { deletionConflict } from "../lib/deletion-conflict";
import { retryableSerializableTransactionCode } from "../lib/serializable-transaction";
import {
  createSetPasswordLink,
  INVITE_LINK_TTL_DAYS,
  markAdminInvited,
  SetPasswordLinkNotPendingError,
  SetPasswordLinkRefusedError,
} from "../lib/set-password-link";

function generateUnusablePassword(): string {
  return randomBytes(48).toString("base64url");
}

/** The users among `userIds` that `users.invite` created (credential-setup-lock.ts). */
async function adminInvitedIds(userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await prisma.verification.findMany({
    where: { identifier: { in: userIds.map((id) => `${ADMIN_INVITED_PREFIX}${id}`) } },
    select: { value: true },
  });
  return new Set((rows ?? []).map((row) => row.value));
}

/**
 * Thrown by `resendInvite` (409) when the user is not a pending invite. The
 * admin UI shows its own copy for it and refreshes the list.
 */
const INVITE_NOT_PENDING = "INVITE_NOT_PENDING";

/**
 * Thrown by `invite` (500) when the account was created but could not be marked an invite: the
 * admin UI says to remove the user and invite them again, and refreshes the list.
 */
const INVITE_INCOMPLETE = "INVITE_INCOMPLETE";

function inviteNotPending() {
  return new ORPCError(INVITE_NOT_PENDING, {
    status: 409,
    message:
      "This user has already set up their account or signs in another way, so there is no invite to resend.",
  });
}

const INVITE_TARGET_SELECT = {
  id: true,
  email: true,
  name: true,
  locale: true,
  banned: true,
  banExpires: true,
} satisfies Prisma.UserSelect;

/**
 * The invite result. The set-password link is returned only when it could not
 * be emailed: the admin then has to pass it on themselves (one-time reveal in
 * the admin UI). When the email went out, the link exists only in the
 * invitee's inbox.
 */
type InviteDelivery =
  | { userId: string; emailSent: true }
  | { userId: string; emailSent: false; setPasswordUrl: string; expiresAt: string };

async function deliverInvite(args: {
  userId: string;
  name: string;
  email: string;
  locale: string;
}): Promise<InviteDelivery> {
  let link: { url: string; token: string; expiresAt: Date };
  try {
    link = await createSetPasswordLink({ userId: args.userId, locale: args.locale });
  } catch (err) {
    if (
      err instanceof SetPasswordLinkRefusedError ||
      err instanceof SetPasswordLinkNotPendingError
    ) {
      throw inviteNotPending();
    }
    console.error(
      `[users.invite] failed to create set-password link: ${err instanceof Error ? (err.constructor?.name ?? "Error") : typeof err}`,
    );
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Couldn't create the invite link. Try resending the invite.",
    });
  }

  // Skip the SMTP attempt (and its retries) when email is not configured at
  // all; a configured-but-failing server falls through to the same reveal.
  if (isEmailConfigured()) {
    try {
      const { subject, html } = renderInviteUser({
        name: args.name,
        email: args.email,
        setPasswordUrl: link.url,
        expiresInDays: INVITE_LINK_TTL_DAYS,
        locale: args.locale,
      });
      await sendEmail({ to: args.email, subject, html });
    } catch (err) {
      // Never log the link: it is a credential until it is spent.
      console.warn(
        `[users.invite] failed to send invite email: ${err instanceof Error ? (err.constructor?.name ?? "Error") : typeof err}`,
      );
      return revealed(args.userId, link);
    }
    // The link went only to the mailbox, so spending it verifies and proves the address
    // (packages/auth password-reset-links.ts). The mail is out: a failed record is logged and
    // the invite stays "emailed" (a mailed link is never revealed). The link then counts as
    // shown: it still works while the invite is pending and verifies nothing, so the invitee
    // confirms the address at first sign-in.
    try {
      await recordResetLinkMailed({ token: link.token, userId: args.userId, email: args.email });
    } catch (err) {
      console.error(
        `[users.invite] failed to record the mailed invite link: ${err instanceof Error ? (err.constructor?.name ?? "Error") : typeof err}`,
      );
    }
    return { userId: args.userId, emailSent: true };
  }
  return revealed(args.userId, link);
}

/**
 * The link the admin passes on themselves. It sets the password while the invite is pending but
 * proves nothing: with SMTP on, the invitee confirms the address by mail at first sign-in.
 */
function revealed(userId: string, link: { url: string; expiresAt: Date }): InviteDelivery {
  return {
    userId,
    emailSent: false,
    setPasswordUrl: link.url,
    expiresAt: link.expiresAt.toISOString(),
  };
}

const USER_SELECT = {
  id: true,
  email: true,
  slug: true,
  name: true,
  role: true,
  emailVerified: true,
  banned: true,
  banReason: true,
  banExpires: true,
  deletionRequestedAt: true,
  twoFactorEnabled: true,
  createdAt: true,
} as const;

/** Better Auth (admin plugin) codes for an email that is already taken. */
const DUPLICATE_USER_AUTH_CODES: ReadonlySet<string> = new Set([
  "USER_ALREADY_EXISTS",
  "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
]);

/**
 * Classifies an `auth.api.createUser` failure by its codes only, never its
 * message: a Better Auth `APIError` body code, the user-create policy's
 * `SIGNUP_DISABLED` code, or a unique violation (Prisma P2002 / SQLSTATE
 * 23505) from a concurrent invite of the same email.
 */
function inviteFailureCode(err: unknown): "duplicate" | "signup_disabled" | null {
  const pending: unknown[] = [err];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) continue;
    seen.add(candidate);
    for (const key of ["code", "originalCode"]) {
      const code = Reflect.get(candidate, key);
      if (typeof code !== "string") continue;
      if (code === SIGNUP_DISABLED_CODE) return "signup_disabled";
      if (DUPLICATE_USER_AUTH_CODES.has(code) || code === "P2002" || code === "23505") {
        return "duplicate";
      }
    }
    for (const key of ["body", "meta", "driverAdapterError", "cause"])
      pending.push(Reflect.get(candidate, key));
  }
  return null;
}

export const usersRouter = {
  list: contractProcedure(c.list).handler(async ({ input }) => {
    const { limit, offset, search } = input;
    const where = search
      ? {
          OR: [
            { email: { contains: search, mode: "insensitive" as const } },
            { name: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {};
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
        select: { ...USER_SELECT, ...inviteStateSelect(new Date()) },
      }),
      prisma.user.count({ where }),
    ]);
    const invited = await adminInvitedIds(users.map((user) => user.id));
    return {
      users: users.map(({ accounts, sessions, ...user }) => ({
        ...user,
        invitePending: isInvitePending({
          ...user,
          accounts,
          sessions,
          adminInvited: invited.has(user.id),
        }),
        banExpires: user.banExpires?.toISOString() ?? null,
        deletionRequestedAt: user.deletionRequestedAt?.toISOString() ?? null,
        createdAt: user.createdAt.toISOString(),
      })),
      total,
      limit,
      offset,
    };
  }),

  invite: contractProcedure(c.invite).handler(async ({ input }) => {
    const unusablePassword = generateUnusablePassword();
    const createUserBody = {
      email: input.email,
      password: unusablePassword,
      name: input.name,
      role: input.role,
      ...(input.slug ? { slug: input.slug } : {}),
    };

    // `auth.api.createUser` is the only admin-plugin endpoint that accepts
    // server-side calls without a session in headers (verified in the
    // better-auth source). It hashes the password, enforces email
    // uniqueness, and writes through the Prisma adapter so it stays in
    // sync with auth database hooks.
    let userId: string;
    try {
      const created = await runWithAdminInviteLocale(input.locale, () =>
        auth.api.createUser({ body: createUserBody }),
      );
      userId = created.user.id;
    } catch (err) {
      const code = inviteFailureCode(err);
      if (code === "duplicate") {
        throw new ORPCError("CONFLICT", {
          message: "A user with that email already exists.",
        });
      }
      if (code === "signup_disabled") {
        throw new ORPCError("BAD_REQUEST", {
          message:
            "Account creation is disabled by the auth configuration. Ask an admin to check the invite setup.",
        });
      }
      // Log the error's constructor name ONLY. The generated unusable
      // password (and, in future better-auth releases, request context
      // like client_secret=… strings) was just handed to
      // auth.api.createUser — the raw message/stack must never reach
      // the console (invariant 10; probe evidence in R35/R36).
      const errLabel = err instanceof Error ? (err.constructor?.name ?? "Error") : typeof err;
      console.error(`[users.invite] auth.api.createUser failed: ${errLabel}`);
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message:
          "Couldn't create that account. Try again, or contact an admin if it keeps happening.",
      });
    }

    // The mark first, committed on its own: a failed first link leaves a resendable invite.
    try {
      await markAdminInvited(userId);
    } catch (err) {
      console.error(
        `[users.invite] failed to mark the invite: ${err instanceof Error ? (err.constructor?.name ?? "Error") : typeof err}`,
      );
      // A structured code: the account exists without the mark, so neither a new invite (the
      // email is taken) nor a resend works; the admin UI tells the admin to remove it first.
      throw new ORPCError(INVITE_INCOMPLETE, {
        status: 500,
        message: "Couldn't finish the invite. Remove this user and invite them again.",
      });
    }
    return deliverInvite({
      userId,
      name: input.name,
      email: input.email,
      locale: input.locale,
    });
  }),

  resendInvite: contractProcedure(c.resendInvite).handler(async ({ input }) => {
    const target = await prisma.user.findUnique({
      where: { id: input.userId },
      select: {
        ...INVITE_TARGET_SELECT,
        deletionRequestedAt: true,
        ...inviteStateSelect(new Date()),
      },
    });
    if (!target) throw new ORPCError("NOT_FOUND");
    const adminInvited = (await adminInvitedIds([target.id])).has(target.id);
    if (!isInvitePending({ ...target, adminInvited })) throw inviteNotPending();
    if (isUserBanned(target, new Date()) || target.deletionRequestedAt) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Restore this user before resending their invite.",
      });
    }
    return deliverInvite({
      userId: target.id,
      name: target.name,
      email: target.email,
      locale: target.locale,
    });
  }),

  setRole: contractProcedure(c.setRole).handler(async ({ input, context }) => {
    // Don't let an admin demote themselves — if they're the only admin
    // they'd lock themselves (and everyone) out of /admin.
    if (input.userId === context.session.user.id && input.role !== "admin") {
      throw new ORPCError("FORBIDDEN", {
        message: "You cannot remove your own admin role.",
        data: { reason: "SELF_DEMOTION" },
      });
    }
    await withAdminRemovalGuard(
      input.userId,
      async (tx, target) => {
        if (target.role === input.role) return;
        await tx.user.update({ where: { id: input.userId }, data: { role: input.role } });
        await tx.auditEvent.create({
          data: {
            userId: input.userId,
            actor: "USER",
            actorUserId: context.session.user.id,
            action: "users.role_changed",
            resourceType: "user",
            resourceId: input.userId,
            before: { role: target.role },
            after: { role: input.role },
          },
        });
      },
      input.role,
    );
    return { success: true as const };
  }),

  archive: contractProcedure(c.archive).handler(async ({ input, context }) => {
    if (input.userId === context.session.user.id) {
      throw new ORPCError("FORBIDDEN", {
        message: "You cannot archive your own account.",
      });
    }
    await withAdminRemovalGuard(input.userId, async (tx) => {
      await tx.user.update({
        where: { id: input.userId },
        data: { banned: true, banReason: input.reason ?? null, banExpires: null },
      });
      await tx.session.deleteMany({ where: { userId: input.userId } });
    });
    // Post-commit: end the user's in-flight relay file ops and commands
    // (#159). A listener failure is logged, never thrown: the ban stands.
    await notifyUserBanned(input.userId);
    return { success: true as const };
  }),

  unarchive: contractProcedure(c.unarchive).handler(async ({ input }) => {
    // One conditional statement, so a deletion marked between a read and the
    // write cannot be un-banned: the write only matches an unmarked row.
    // (Access is refused on the marker alone anyway; see
    // @ws-model-proxy/auth/user-deletion-access-guard.)
    const restored = await prisma.user.updateMany({
      where: { id: input.userId, deletionRequestedAt: null },
      data: { banned: false, banReason: null, banExpires: null },
    });
    if (restored.count === 1) return { success: true as const };
    const target = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true },
    });
    if (!target) throw new ORPCError("NOT_FOUND", { message: "User not found" });
    throw deletionConflict(
      "deletion_in_progress",
      "This account is being deleted and cannot be restored. Wait for deletion to finish or contact support.",
    );
  }),

  remove: contractProcedure(c.remove).handler(async ({ input, context }) => {
    if (input.userId === context.session.user.id) {
      throw new ORPCError("FORBIDDEN", {
        message: "You cannot delete your own account.",
      });
    }
    const target = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true },
    });
    if (!target)
      throw new ORPCError("NOT_FOUND", {
        message: "User not found",
        data: { reason: "USER_NOT_FOUND" },
      });

    // The delete is durable and bounded (packages/db/src/parent-deletion.ts): the user is
    // marked for deletion (banned, sessions revoked), their history is drained in short
    // batches, and the graph is deleted in the fixed order (instances, profiles, runtimes,
    // nodes, pools, providers) under the owner fences of every user it writes (DL-1 writer
    // class M). Hot-path history left behind is removed by the deleted-user purge. If the
    // last step fails transiently the marker stays and the user-deletion sweeper finishes
    // it, so the response reports `pending`. A permanent database refusal archives the user.
    const label = (err: unknown) =>
      // Constructor name only — Prisma rejections embed SQL + params.
      err instanceof Error ? (err.constructor?.name ?? "Error") : typeof err;
    let result: DurableUserDeletionResult;
    try {
      result = await deleteUserDurably(prisma, input.userId, {
        beforeMark: (tx) => assertAdminRemovalAllowed(tx, input.userId),
        onMarked: notifyUserDeletionMarked,
        onTransientFailure: (err) =>
          console.error(
            `[users.remove] delete incomplete, the deletion sweeper will finish it: ${label(err)}`,
          ),
      });
    } catch (err) {
      if (err instanceof ORPCError) throw err;
      if (retryableSerializableTransactionCode(err)) throwUserChangeError(err);
      // Classified by error class and SQLSTATE / Prisma code
      // (RETAINED_HISTORY, P2003, P2014, 23503, 23514), and for 55000 by the
      // hardening trigger's message: a permanent refusal only when it matches
      // one (see `isPermanentParentDeletionFailure`), otherwise transient.
      if (isPermanentParentDeletionFailure(err)) {
        throw deletionConflict(
          "retained_history",
          "This account could not be deleted and was archived instead. Contact support if it keeps happening.",
        );
      }
      console.error(`[users.remove] prisma delete failed: ${label(err)}`);
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message:
          "Couldn't delete that account. Try again, or contact an admin if it keeps happening.",
      });
    }
    if (result === "missing")
      throw new ORPCError("NOT_FOUND", {
        message: "User not found",
        data: { reason: "USER_NOT_FOUND" },
      });
    if (result === "pending") return { success: true as const, pending: true };
    if (result === "abandoned") {
      // A permanent refusal archived the user before this call finished.
      throw deletionConflict(
        "retained_history",
        "This account could not be deleted and was archived instead. Contact support if it keeps happening.",
      );
    }
    // Close the deleted user's live relay sessions, matched by the
    // authenticated identity's userId (not a credential-id snapshot, so a
    // credential minted just before the delete is covered). Same post-commit
    // notification Better Auth's admin remove-user fires; in-process only
    // (see @ws-model-proxy/auth/user-deletion-listeners).
    await notifyUserDeleted(input.userId);
    return { success: true as const, pending: false };
  }),
};
