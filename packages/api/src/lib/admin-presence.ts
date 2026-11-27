import { ORPCError } from "@orpc/server";
import { isUserBanned } from "@ws-model-proxy/auth/is-user-banned";
import { hasRole } from "@ws-model-proxy/auth/roles";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import { retryableSerializableTransactionCode } from "./serializable-transaction";

/**
 * "Admin" here means the same thing as `isAdminRole` in
 * packages/auth/src/roles.ts: the comma-separated `User.role` string holds an
 * `admin` token, case- and whitespace-insensitive. The SQL below mirrors that
 * so a multi-role value such as `"user, Admin"` counts, while `"superadmin"`
 * does not. The `ILIKE` prefilter only narrows the scan; the token match
 * decides.
 */

/**
 * Admins who can still sign in: the admin token match above,
 * excluding unverified accounts and current bans/archives (isUserBanned).
 * Expired bans are active.
 * Role-change guards must read this fresh inside their transaction.
 */
export async function activeAdminUserCount(
  db: Pick<Prisma.TransactionClient, "$queryRaw"> = prisma,
  now = new Date(),
): Promise<number> {
  const rows = await db.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS "count" FROM "user" u
    WHERE u.role ILIKE '%admin%'
      AND EXISTS (
        SELECT 1 FROM unnest(string_to_array(u.role, ',')) AS r(token)
        WHERE r.token ~* '^\\s*admin\\s*$'
      )
      AND u."deletionRequestedAt" IS NULL
      AND u."emailVerified" IS TRUE
      AND (u.banned IS NOT TRUE OR u."banExpires" < ${now})`;
  return rows[0]?.count ?? 0;
}

const ADMIN_REMOVAL_SELECT = {
  id: true,
  role: true,
  emailVerified: true,
  banned: true,
  banExpires: true,
  deletionRequestedAt: true,
} satisfies Prisma.UserSelect;

type AdminRemovalTarget = Prisma.UserGetPayload<{ select: typeof ADMIN_REMOVAL_SELECT }>;

/** Also used inside durable deletion's Serializable mark transaction. */
export async function assertAdminRemovalAllowed(
  tx: Prisma.TransactionClient,
  userId: string,
  nextRole?: string,
): Promise<AdminRemovalTarget> {
  const target = await tx.user.findUnique({
    where: { id: userId },
    select: ADMIN_REMOVAL_SELECT,
  });
  if (!target) {
    throw new ORPCError("NOT_FOUND", {
      message: "User not found",
      data: { reason: "USER_NOT_FOUND" },
    });
  }
  if (
    !hasRole(nextRole, "admin") &&
    hasRole(target.role, "admin") &&
    target.emailVerified &&
    !target.deletionRequestedAt &&
    !isUserBanned(target, new Date()) &&
    (await activeAdminUserCount(tx)) <= 1
  ) {
    throw new ORPCError("FORBIDDEN", {
      message:
        "You cannot remove the last active admin. Make another verified, active user an admin first.",
      data: { reason: "LAST_ACTIVE_ADMIN" },
    });
  }
  return target;
}

/**
 * Every admin-removing write shares this transaction: read the target, count
 * usable admins, then mutate. Serializable isolation prevents write skew when
 * two admins concurrently demote, archive, or delete each other. nextRole is
 * supplied for role writes; omitting it means archive/delete.
 */
export async function withAdminRemovalGuard<T>(
  userId: string,
  mutate: (tx: Prisma.TransactionClient, target: AdminRemovalTarget) => Promise<T>,
  nextRole?: string,
): Promise<T> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        const target = await assertAdminRemovalAllowed(tx, userId, nextRole);
        return mutate(tx, target);
      },
      { isolationLevel: "Serializable" },
    );
  } catch (error) {
    throwUserChangeError(error);
  }
}

export function throwUserChangeError(error: unknown): never {
  const code = retryableSerializableTransactionCode(error);
  if (code === "P2034" || code === "40001" || code === "40P01") {
    throw new ORPCError("CONFLICT", {
      message: "Another user change happened at the same time. Review the users and try again.",
      data: { reason: "USER_CHANGE_CONFLICT" },
    });
  }
  throw error;
}
