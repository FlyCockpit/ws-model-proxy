import type defaultPrisma from "@ws-model-proxy/db";

/** A need must last this long before it is emailed: a person at the terminal never gets mail. */
export const DEPLOYMENT_NEED_EMAIL_DELAY_MS = 120_000;
/** At most one notice per instance in this window, however often its need comes and goes. */
export const DEPLOYMENT_NEED_EMAIL_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BATCH = 32;

type NotifyDb = Pick<typeof defaultPrisma, "deploymentInstance">;
type SendEmail = (message: { to: string; subject: string; html: string }) => Promise<void>;

/**
 * Emails owners whose deployments wait for them (`needsOperator` STEP or RESTART), when SMTP is
 * configured (design §11.4). Each notice is claimed first with a guarded update of
 * `needsOperatorNotifiedAt`, so one replica sends it, at most once per need and per
 * {@link DEPLOYMENT_NEED_EMAIL_INTERVAL_MS}, and only after the need lasted
 * {@link DEPLOYMENT_NEED_EMAIL_DELAY_MS}. Best effort: a failed send is logged by error class
 * only (transport errors can carry addresses) and not retried. Inactive owners and unverified
 * addresses get nothing. Returns how many notices were sent.
 */
export async function notifyDeploymentOperatorNeeds({
  db,
  now = new Date(),
  send,
  configured,
}: {
  db: NotifyDb;
  now?: Date;
  send?: SendEmail;
  /** Defaults to the mailer's own check (SMTP_HOST set). */
  configured?: boolean;
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
      User: { select: { email: true, locale: true } },
    },
    orderBy: { needsOperatorSince: "asc" },
    take: BATCH,
  });
  let sent = 0;
  for (const instance of due) {
    if (!instance.needsOperator || !instance.needsOperatorSince) continue;
    const claimed = await db.deploymentInstance.updateMany({
      where: {
        id: instance.id,
        needsOperator: instance.needsOperator,
        needsOperatorSince: instance.needsOperatorSince,
        OR: [{ needsOperatorNotifiedAt: null }, { needsOperatorNotifiedAt: { lt: quietSince } }],
      },
      data: { needsOperatorNotifiedAt: now },
    });
    if (!claimed.count) continue;
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
    } catch (error) {
      const label = error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error;
      console.warn(`[deployments] needs-you email failed: ${label}`);
    }
  }
  return sent;
}
