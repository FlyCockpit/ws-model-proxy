import type { Prisma } from "@ws-model-proxy/db";

/** Call only after taking the user's owner fence, in the credential write transaction. */
export async function hasLiveCredentialSession(
  tx: Pick<Prisma.TransactionClient, "session">,
  userId: string,
  sessionId: string | null | undefined,
): Promise<boolean> {
  if (!sessionId) return false;
  return Boolean(
    await tx.session.findFirst({
      where: { id: sessionId, userId, expiresAt: { gt: new Date() } },
      select: { id: true },
    }),
  );
}
