/**
 * Proof of mailbox ownership (`User.provedEmail`), apart from Better Auth's `emailVerified`.
 *
 * `emailVerified` is what lets an account sign in: it is forced true when SMTP is off (anyone can
 * register any address) and for admin-created accounts. Only the real verify-email flow — a link
 * that went to the mailbox — records the proved address, and the proof holds only while it is
 * still the account's address (an e-mail changed any other way is unproved).
 */
import prisma from "@ws-model-proxy/db";

/** Trimmed, ASCII letters lower-cased only (as the share-invite e-mail key). */
export function provedEmailKey(email: string): string {
  return email.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** Whether the account's current e-mail is the one the verify-email flow proved. */
export function hasProvedEmail(account: { email: string; provedEmail: string | null }): boolean {
  return account.provedEmail !== null && account.provedEmail === provedEmailKey(account.email);
}

/**
 * Records the address a verify-email route just verified. Guarded on the e-mail being unchanged
 * since that update, so a concurrent change of address is never marked proved.
 */
export async function recordProvedEmail(user: { id: string; email: string }): Promise<void> {
  await prisma.user.updateMany({
    where: { id: user.id, email: user.email },
    data: { provedEmail: provedEmailKey(user.email) },
  });
}
