import type defaultPrisma from "@ws-model-proxy/db";

/** A need must last this long before it is emailed: a person at the terminal never gets mail. */
export const DEPLOYMENT_NEED_EMAIL_DELAY_MS = 120_000;
/** At most one notice per instance in this window, however often its need comes and goes. */
export const DEPLOYMENT_NEED_EMAIL_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** A claimed notice whose send failed is tried again after this, not after the full interval. */
export const DEPLOYMENT_NEED_EMAIL_RETRY_MS = 10 * 60 * 1000;
const BATCH = 32;

type NotifyDb = Pick<typeof defaultPrisma, "deploymentInstance">;
type SendEmail = (message: { to: string; subject: string; html: string }) => Promise<void>;

/**
 * Emails owners whose deployments wait for them (`needsOperator` STEP or RESTART), when SMTP is
 * configured (design §11.4). Each notice is claimed first with a guarded update of
 * `needsOperatorNotifiedAt`, so one replica sends it, at most once per need and per
 * {@link DEPLOYMENT_NEED_EMAIL_INTERVAL_MS}, and only after the need lasted
 * {@link DEPLOYMENT_NEED_EMAIL_DELAY_MS}. Best effort: a failed send is logged by error class
 * only (transport errors can carry addresses). The first failure of a notice moves its claim
 * back so it is due again after {@link DEPLOYMENT_NEED_EMAIL_RETRY_MS}; a second keeps the
 * claim (the regular interval), so a send the server accepted but reported as failed repeats
 * at most once. Inactive owners and unverified addresses get nothing. Returns how many notices
 * were sent.
 *
 * Every write keeps the instance's `updatedAt` (written back explicitly, guarded by it): the
 * notice bookkeeping must not reset the reconciler's offline grace or maintenance order, and a
 * row changed meanwhile is simply claimed on a later sweep.
 */
export async function notifyDeploymentOperatorNeeds({
  db,
  now = new Date(),
  send,
  configured,
  shouldStop = () => false,
}: {
  db: NotifyDb;
  now?: Date;
  send?: SendEmail;
  /** Defaults to the mailer's own check (SMTP_HOST set). */
  configured?: boolean;
  /**
   * Checked before each claim (the caller's shutdown): once true, nothing more is claimed or
   * sent, so no mail goes out after the reconciler stopped.
   */
  shouldStop?: () => boolean;
}): Promise<number> {
  // Nothing loads the mailer or the server env until SMTP is configured, so a process (or a
  // unit test) without either never evaluates them.
  if (!(configured ?? Boolean(process.env.SMTP_HOST))) return 0;
  const mailer = await import("@ws-model-proxy/mailer");
  const { env } = await import("@ws-model-proxy/env/server");
  const deliver = send ?? mailer.sendEmail;
  const settledBefore = new Date(now.getTime() - DEPLOYMENT_NEED_EMAIL_DELAY_MS);
  const quietSince = new Date(now.getTime() - DEPLOYMENT_NEED_EMAIL_INTERVAL_MS);
  const due = await db.deploymentInstance.findMany({
    where: {
      needsOperator: { not: null },
      needsOperatorSince: { lte: settledBefore },
      OR: [{ needsOperatorNotifiedAt: null }, { needsOperatorNotifiedAt: { lt: quietSince } }],
      User: {
        emailVerified: true,
        deletionRequestedAt: null,
        OR: [{ banned: null }, { banned: false }, { banExpires: { lt: now } }],
      },
    },
    select: {
      id: true,
      endpointSlug: true,
      needsOperator: true,
      needsOperatorSince: true,
      needsOperatorNotifyFailures: true,
      updatedAt: true,
      User: { select: { email: true, locale: true } },
    },
    orderBy: { needsOperatorSince: "asc" },
    take: BATCH,
  });
  let sent = 0;
  for (const instance of due) {
    if (shouldStop()) break;
    if (!instance.needsOperator || !instance.needsOperatorSince) continue;
    const unchanged = { id: instance.id, updatedAt: instance.updatedAt };
    const claimed = await db.deploymentInstance.updateMany({
      where: {
        ...unchanged,
        needsOperator: instance.needsOperator,
        needsOperatorSince: instance.needsOperatorSince,
        OR: [{ needsOperatorNotifiedAt: null }, { needsOperatorNotifiedAt: { lt: quietSince } }],
      },
      data: { needsOperatorNotifiedAt: now, updatedAt: instance.updatedAt },
    });
    if (!claimed.count) continue;
    const ours = { ...unchanged, needsOperatorNotifiedAt: now };
    try {
      const locale = mailer.resolveMailerLocale(instance.User.locale);
      const { subject, html } = mailer.renderDeploymentNeedsYou({
        endpoint: instance.endpointSlug,
        need: instance.needsOperator === "RESTART" ? "restart" : "step",
        deploymentsUrl: `${env.BETTER_AUTH_URL}/${encodeURIComponent(locale)}/dashboard/deployments`,
        locale,
      });
      await deliver({ to: instance.User.email, subject, html });
      sent += 1;
      if (instance.needsOperatorNotifyFailures > 0)
        await db.deploymentInstance
          .updateMany({
            where: ours,
            data: { needsOperatorNotifyFailures: 0, updatedAt: instance.updatedAt },
          })
          .catch(() => {
            console.warn("[deployments] needs-you failure reset failed");
          });
    } catch (error) {
      const label = error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error;
      console.warn(`[deployments] needs-you email failed: ${label}`);
      // The first failure is retried soon (the claim moves back); a repeated one keeps the
      // claim, so an accepted-but-reported-failed send cannot repeat every few minutes.
      const retry = instance.needsOperatorNotifyFailures === 0;
      await db.deploymentInstance
        .updateMany({
          where: ours,
          data: retry
            ? {
                needsOperatorNotifiedAt: new Date(
                  now.getTime() -
                    DEPLOYMENT_NEED_EMAIL_INTERVAL_MS +
                    DEPLOYMENT_NEED_EMAIL_RETRY_MS,
                ),
                needsOperatorNotifyFailures: 1,
                updatedAt: instance.updatedAt,
              }
            : { needsOperatorNotifyFailures: 0, updatedAt: instance.updatedAt },
        })
        .catch(() => {
          console.warn("[deployments] needs-you retry bookkeeping failed");
        });
    }
  }
  return sent;
}
