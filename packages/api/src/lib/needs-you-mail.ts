/**
 * Needs-you e-mail (spec §7.4): when SMTP is configured and the owner's `operationalAlerts` is
 * on, the owner gets one e-mail per new need. Without SMTP nothing is sent and nothing is read.
 *
 * - Instance needs (an interactive step waiting, a restart, Mark as stopped) are picked up by
 *   `sweepNeedsYouMail`, which the server runs every minute. `needsOperatorNotifiedAt` holds the
 *   `needsOperatorSince` of the need last mailed (not a clock reading, so a need raised while a
 *   sweep runs is never mistaken for one already mailed); a need is new when it is unset or
 *   older than `needsOperatorSince`, which is set each time a need begins. The sweep claims a
 *   need with a compare-and-set before it sends, so replicas and overlapping sweeps never send
 *   it twice. A failed send releases the claim for the next sweep, marked `since - 1 ms`, so the
 *   failure count is known to belong to this need; after `NEEDS_YOU_MAIL_MAX_FAILURES` tries
 *   the need counts as mailed.
 * - A command an agent queued for the person is mailed once, when the row is created
 *   (`notifyQueuedCommand`): creation happens once per row, so it needs no marker.
 *
 * Each user gets at most `NEEDS_YOU_MAIL_PER_WINDOW` e-mails per `NEEDS_YOU_MAIL_WINDOW_MS`
 * (per process; one web service is the deployment shape). An instance need over the limit waits
 * for a later sweep; a queued command over the limit is not mailed (Terminals and the nav badge
 * still show it). Needs older than `NEEDS_YOU_MAIL_MAX_AGE_MS` are never mailed, so turning
 * alerts on (or upgrading) does not flood the inbox with old ones.
 */
import { DEFAULT_LOCALE, isSupportedLocale } from "@ws-model-proxy/config/locales";
import prisma, { type Prisma } from "@ws-model-proxy/db";
import { isDbShutdownFenceArmed } from "@ws-model-proxy/db/shutdown-fence";
import { env } from "@ws-model-proxy/env/server";
import {
  isEmailConfigured,
  type NeedsYouKind,
  renderNeedsYou,
  sendEmail,
} from "@ws-model-proxy/mailer";
import type { OPERATOR_NEED } from "../contracts/common";

export const NEEDS_YOU_MAIL_PER_WINDOW = 6;
export const NEEDS_YOU_MAIL_WINDOW_MS = 3_600_000;
export const NEEDS_YOU_MAIL_MAX_AGE_MS = 24 * 3_600_000;
export const NEEDS_YOU_MAIL_MAX_FAILURES = 5;
const SWEEP_BATCH = 50;

const KIND_OF_NEED: Record<(typeof OPERATOR_NEED)[number], NeedsYouKind> = {
  STEP: "step",
  RESTART: "restart",
  MARK_STOPPED: "mark_stopped",
};

/** Per-user send times inside the current window. */
const sentAt = new Map<string, number[]>();

function recentSends(userId: string, nowMs: number): number[] {
  const kept = (sentAt.get(userId) ?? []).filter((at) => nowMs - at < NEEDS_YOU_MAIL_WINDOW_MS);
  if (kept.length > 0) sentAt.set(userId, kept);
  else sentAt.delete(userId);
  return kept;
}

function takeMailSlot(userId: string, nowMs: number): boolean {
  const sends = recentSends(userId, nowMs);
  if (sends.length >= NEEDS_YOU_MAIL_PER_WINDOW) return false;
  sentAt.set(userId, [...sends, nowMs]);
  return true;
}

function returnMailSlot(userId: string, nowMs: number): void {
  const sends = sentAt.get(userId) ?? [];
  const index = sends.lastIndexOf(nowMs);
  if (index >= 0) sends.splice(index, 1);
}

function limitedUsers(nowMs: number): string[] {
  return [...sentAt.keys()].filter(
    (userId) => recentSends(userId, nowMs).length >= NEEDS_YOU_MAIL_PER_WINDOW,
  );
}

/** Test hook: forget every send (the limiter is process memory). */
export function resetNeedsYouMailLimiter(): void {
  sentAt.clear();
}

/** Who may get the mail: alerts on, a proved mailbox, not banned, not being deleted. */
const recipientWhere = {
  operationalAlerts: true,
  emailVerified: true,
  deletionRequestedAt: null,
  OR: [{ banned: null }, { banned: false }],
} satisfies Prisma.UserWhereInput;

type Recipient = { email: string; locale: string };

/** Where the person resolves it: Terminals for steps and queued commands, else the runtime. */
export function needsYouActionUrl(
  kind: NeedsYouKind,
  locale: string,
  runtimeId: string | null,
): string {
  const lang = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
  const path =
    kind === "step" || kind === "queued_command" || runtimeId === null
      ? `/${lang}/terminals`
      : `/${lang}/runtimes/${encodeURIComponent(runtimeId)}`;
  return new URL(path, env.BETTER_AUTH_URL).toString();
}

async function deliver(
  to: Recipient,
  kind: NeedsYouKind,
  name: string,
  runtimeId: string | null,
): Promise<boolean> {
  try {
    const { subject, html } = renderNeedsYou({
      kind,
      name,
      actionUrl: needsYouActionUrl(kind, to.locale, runtimeId),
      locale: to.locale,
    });
    await sendEmail({ to: to.email, subject, html });
    return true;
  } catch (error) {
    // Class only: transport errors can carry addresses and credentials.
    console.warn(
      "[needs-you] e-mail failed:",
      error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
    );
    return false;
  }
}

/**
 * Mails the owner that an agent queued a command for them on `nodeSlug`. Never throws; the
 * caller does not wait for it.
 */
export async function notifyQueuedCommand(args: {
  userId: string;
  nodeSlug: string;
  now?: Date;
}): Promise<boolean> {
  if (!isEmailConfigured()) return false;
  const nowMs = (args.now ?? new Date()).getTime();
  try {
    const user = await prisma.user.findFirst({
      where: { id: args.userId, ...recipientWhere },
      select: { email: true, locale: true },
    });
    if (!user) return false;
    if (!takeMailSlot(args.userId, nowMs)) return false;
    const sent = await deliver(user, "queued_command", args.nodeSlug, null);
    if (!sent) returnMailSlot(args.userId, nowMs);
    return sent;
  } catch (error) {
    console.warn(
      "[needs-you] queued command notice failed:",
      error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error,
    );
    return false;
  }
}

/** The release marker of a failed send: just before the need began, so it stays new. */
function releaseMarker(since: Date): Date {
  return new Date(since.getTime() - 1);
}

/**
 * One pass over new instance needs. Returns how many e-mails were sent. Throws only on a
 * database failure (the scheduler logs it); a send failure is counted on the row. Stops before
 * the next claim once the database shutdown fence is armed.
 */
export async function sweepNeedsYouMail(now: Date = new Date()): Promise<number> {
  if (!isEmailConfigured()) return 0;
  const nowMs = now.getTime();
  const limited = limitedUsers(nowMs);
  const rows = await prisma.runtimeInstance.findMany({
    where: {
      needsOperator: { not: null },
      needsOperatorSince: { gte: new Date(nowMs - NEEDS_YOU_MAIL_MAX_AGE_MS) },
      OR: [
        { needsOperatorNotifiedAt: null },
        { needsOperatorNotifiedAt: { lt: prisma.runtimeInstance.fields.needsOperatorSince } },
      ],
      ...(limited.length > 0 ? { userId: { notIn: limited } } : {}),
      Runtime: { User: recipientWhere },
    },
    orderBy: { needsOperatorSince: "asc" },
    take: SWEEP_BATCH,
    select: {
      id: true,
      userId: true,
      runtimeId: true,
      needsOperator: true,
      needsOperatorSince: true,
      needsOperatorNotifiedAt: true,
      needsOperatorNotifyFailures: true,
      Runtime: { select: { name: true, User: { select: { email: true, locale: true } } } },
    },
  });
  let sent = 0;
  for (const row of rows) {
    if (isDbShutdownFenceArmed()) break;
    const since = row.needsOperatorSince;
    if (row.needsOperator === null || since === null) continue;
    if (!takeMailSlot(row.userId, nowMs)) continue;
    // Failures counted for an earlier need do not count against this one.
    const priorFailures =
      row.needsOperatorNotifiedAt?.getTime() === releaseMarker(since).getTime()
        ? row.needsOperatorNotifyFailures
        : 0;
    // Compare-and-set on the need as read: a need that changed or was claimed elsewhere is left.
    const claim = await prisma.runtimeInstance.updateMany({
      where: {
        id: row.id,
        needsOperator: row.needsOperator,
        needsOperatorSince: since,
        needsOperatorNotifiedAt: row.needsOperatorNotifiedAt,
      },
      data: { needsOperatorNotifiedAt: since },
    });
    if (claim.count === 0) {
      returnMailSlot(row.userId, nowMs);
      continue;
    }
    const ok = await deliver(
      row.Runtime.User,
      KIND_OF_NEED[row.needsOperator],
      row.Runtime.name,
      row.runtimeId,
    );
    if (ok) {
      sent += 1;
      if (row.needsOperatorNotifyFailures > 0) {
        await prisma.runtimeInstance.updateMany({
          where: { id: row.id, needsOperatorSince: since, needsOperatorNotifiedAt: since },
          data: { needsOperatorNotifyFailures: 0 },
        });
      }
      continue;
    }
    returnMailSlot(row.userId, nowMs);
    const failures = priorFailures + 1;
    await prisma.runtimeInstance.updateMany({
      where: { id: row.id, needsOperatorSince: since, needsOperatorNotifiedAt: since },
      // After the last try the need counts as mailed (the claim stays) and the count resets;
      // before it, the claim is released for the next sweep.
      data:
        failures >= NEEDS_YOU_MAIL_MAX_FAILURES
          ? { needsOperatorNotifyFailures: 0 }
          : {
              needsOperatorNotifiedAt: releaseMarker(since),
              needsOperatorNotifyFailures: failures,
            },
    });
  }
  return sent;
}
