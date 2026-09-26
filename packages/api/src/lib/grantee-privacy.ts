import { ORPCError } from "@orpc/server";
import type { Prisma } from "@ws-model-proxy/db";
import {
  isEmailConfigured,
  renderPoolExternalProviderNotice,
  sendEmail,
} from "@ws-model-proxy/mailer";

import {
  externalFallbackMemberWhere,
  GRANTEE_PRIVACY_CONFIRMATION_REQUIRED,
} from "./effective-provider-egress";

export type PrivacyGrantee = {
  userId: string;
  email: string;
  name: string;
  locale: string;
};

export type GranteePrivacyNotice = {
  poolName: string;
  grantees: PrivacyGrantee[];
};

type PrivacyTx = Pick<Prisma.TransactionClient, "poolGrant" | "poolMember" | "dashboardNotice">;

/**
 * Shared-pool privacy changes and new grants both lock `model_pool` first
 * (`SELECT … FOR UPDATE`) before reading grants or egress state. Do not take
 * execution-target or capacity locks before that pool row lock.
 */
export async function countExternalFallbackMembers(
  tx: Pick<Prisma.TransactionClient, "poolMember">,
  poolId: string,
  excludeMemberId?: string,
): Promise<number> {
  return tx.poolMember.count({
    where: {
      poolId,
      ...(excludeMemberId ? { id: { not: excludeMemberId } } : {}),
      ...externalFallbackMemberWhere,
    },
  });
}

async function loadPrivacyGrantees(tx: PrivacyTx, poolId: string): Promise<PrivacyGrantee[]> {
  const grants = await tx.poolGrant.findMany({
    where: { poolId },
    select: {
      granteeUserId: true,
      Grantee: { select: { email: true, name: true, locale: true } },
    },
  });
  return grants.map((grant) => ({
    userId: grant.granteeUserId,
    email: grant.Grantee.email,
    name: grant.Grantee.name,
    locale: grant.Grantee.locale,
  }));
}

function confirmationError(poolName: string, grantees: readonly PrivacyGrantee[]) {
  const named = grantees.map((grantee) => ({ email: grantee.email, name: grantee.name }));
  return new ORPCError("CONFLICT", {
    message: `Confirm that grantees may have requests sent to an external provider: ${named
      .map((grantee) => grantee.email)
      .join(", ")}.`,
    data: {
      reason: GRANTEE_PRIVACY_CONFIRMATION_REQUIRED,
      poolName,
      grantees: named,
    },
  });
}

/**
 * Returns the grantees who must be notified when this call is the one that
 * makes a shared pool non-private. Empty when the pool stays private, was
 * already non-private, or has no grantees. Throws instead of returning when
 * grantees exist and the caller has not confirmed.
 */
export async function gateSharedPoolPrivacyChange(
  tx: PrivacyTx,
  input: {
    poolId: string;
    poolName: string;
    currentlyNonPrivate: boolean;
    nextNonPrivate: boolean;
    confirmed: boolean;
  },
): Promise<PrivacyGrantee[]> {
  if (input.currentlyNonPrivate || !input.nextNonPrivate) return [];
  const grantees = await loadPrivacyGrantees(tx, input.poolId);
  if (grantees.length === 0) return [];
  if (!input.confirmed) throw confirmationError(input.poolName, grantees);
  return grantees;
}

export async function recordGranteePrivacyNotices(
  tx: Pick<Prisma.TransactionClient, "dashboardNotice">,
  input: { poolId: string; poolName: string; grantees: readonly PrivacyGrantee[] },
): Promise<void> {
  if (input.grantees.length === 0) return;
  await tx.dashboardNotice.createMany({
    data: input.grantees.map((grantee) => ({
      userId: grantee.userId,
      kind: "POOL_EXTERNAL_PROVIDER",
      poolId: input.poolId,
      poolName: input.poolName,
    })),
  });
}

/**
 * Email is best-effort and runs only after the notice rows commit. A crash
 * between those steps leaves the dashboard notice and skips that email.
 * SMTP that is not configured skips email without failing the mutation.
 */
export async function deliverGranteePrivacyEmails(
  notice: GranteePrivacyNotice | null,
): Promise<void> {
  if (!notice || notice.grantees.length === 0 || !isEmailConfigured()) return;
  await Promise.all(
    notice.grantees.map(async (grantee) => {
      try {
        const rendered = renderPoolExternalProviderNotice({
          name: grantee.name,
          poolName: notice.poolName,
          locale: grantee.locale,
        });
        await sendEmail({ to: grantee.email, subject: rendered.subject, html: rendered.html });
      } catch (error) {
        console.error("[privacy] grantee notice email failed", {
          configured: true,
          errorName: error instanceof Error ? error.name : "unknown",
        });
      }
    }),
  );
}
