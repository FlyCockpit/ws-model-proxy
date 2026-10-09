import { randomBytes } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { auth } from "@ws-model-proxy/auth";
import { SIGNUP_DISABLED_CODE } from "@ws-model-proxy/auth/signup-policy";
import { notifyUserBanned } from "@ws-model-proxy/auth/user-ban-listeners";
import {
  notifyUserDeleted,
  notifyUserDeletionMarked,
} from "@ws-model-proxy/auth/user-deletion-listeners";
import prisma from "@ws-model-proxy/db";
import {
  type DurableUserDeletionResult,
  deleteUserDurably,
  isPermanentParentDeletionFailure,
} from "@ws-model-proxy/db/parent-deletion";
import { env } from "@ws-model-proxy/env/server";
import { renderInviteUser, sendEmail } from "@ws-model-proxy/mailer";
import { contractProcedure } from "../contract-procedure";
import { usersContract as c } from "../contracts/account";
import { deletionConflict } from "../lib/deletion-conflict";

function generateTempPassword(): string {
  // 24 url-safe bytes → ~32 chars. Long enough to satisfy any reasonable
  // strength check; short enough to read from an email.
  return randomBytes(24).toString("base64url");
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
        select: USER_SELECT,
      }),
      prisma.user.count({ where }),
    ]);
    return {
      users: users.map((user) => ({
        ...user,
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
    const tempPassword = generateTempPassword();
    const createUserBody = {
      email: input.email,
      password: tempPassword,
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
    let recipientLocale: string;
    try {
      const created = await auth.api.createUser({
        body: createUserBody,
      });
      userId = created.user.id;
      // The User row was just created with the Prisma `@default("en-US")`
      // for `locale`. Read it back so a future change to the default (or a
      // hook that overrides it) flows through to the email render without
      // additional plumbing here.
      const fresh = await prisma.user.findUnique({
        where: { id: userId },
        select: { locale: true },
      });
      recipientLocale = fresh?.locale ?? "en-US";
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
      // Log the error's constructor name ONLY. The generated temp
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

    // Email send is best-effort: if SMTP is not configured (or fails) we
    // still return the temp password to the admin so they can share it
    // out of band. The email failure is logged but does not roll back the
    // user creation — undoing it would race against any concurrent admin
    // who is already looking at the new row.
    let emailSent = false;
    try {
      const { subject, html } = renderInviteUser({
        name: input.name,
        email: input.email,
        tempPassword,
        signInUrl: `${env.BETTER_AUTH_URL}/login`,
        locale: recipientLocale,
      });
      await sendEmail({ to: input.email, subject, html });
      emailSent = true;
    } catch (err) {
      // Constructor name only — SMTP/transport rejections can embed
      // recipient addresses and auth material in their messages.
      const errLabel = err instanceof Error ? (err.constructor?.name ?? "Error") : typeof err;
      console.warn(`[users.invite] failed to send invite email: ${errLabel}`);
    }

    return { userId, tempPassword, emailSent };
  }),

  setRole: contractProcedure(c.setRole).handler(async ({ input, context }) => {
    // Don't let an admin demote themselves — if they're the only admin
    // they'd lock themselves (and everyone) out of /admin.
    if (input.userId === context.session.user.id && input.role !== "admin") {
      throw new ORPCError("FORBIDDEN", {
        message: "You cannot remove your own admin role.",
      });
    }
    const target = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true },
    });
    if (!target) throw new ORPCError("NOT_FOUND", { message: "User not found" });

    await prisma.user.update({
      where: { id: input.userId },
      data: { role: input.role },
    });
    return { success: true as const };
  }),

  archive: contractProcedure(c.archive).handler(async ({ input, context }) => {
    if (input.userId === context.session.user.id) {
      throw new ORPCError("FORBIDDEN", {
        message: "You cannot archive your own account.",
      });
    }
    const target = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true },
    });
    if (!target) throw new ORPCError("NOT_FOUND", { message: "User not found" });

    // Set banned=true so better-auth treats the user as locked, and revoke
    // every active session so the next page-load signs them out. We mirror
    // what the admin plugin's banUser endpoint does internally — no expiry
    // (banExpires=null), no auto-unban.
    await prisma.$transaction([
      prisma.user.update({
        where: { id: input.userId },
        data: {
          banned: true,
          banReason: input.reason ?? null,
          banExpires: null,
        },
      }),
      prisma.session.deleteMany({ where: { userId: input.userId } }),
    ]);
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
    if (!target) throw new ORPCError("NOT_FOUND", { message: "User not found" });

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
        onMarked: notifyUserDeletionMarked,
        onTransientFailure: (err) =>
          console.error(
            `[users.remove] delete incomplete, the deletion sweeper will finish it: ${label(err)}`,
          ),
      });
    } catch (err) {
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
    if (result === "missing") throw new ORPCError("NOT_FOUND", { message: "User not found" });
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
