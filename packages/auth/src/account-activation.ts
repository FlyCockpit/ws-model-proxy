import prisma from "@ws-model-proxy/db";
import { lockCredentialSetup } from "./credential-setup-lock";
import { deleteResetLinks } from "./password-reset-links";

/**
 * An invited account becomes active when its email is verified. Reset links minted while it was
 * a pending invite (set-password links an admin was shown, or a resend's) must die at that
 * moment, whatever route verified it: an ordinary `/verify-email`, or a mailed reset link (whose
 * after-hook does the same itself, password-reset-links.ts `verifyEmailIfResetLinkWasMailed`).
 * WMP links no other identity provider to an account, so verification is the only activation.
 *
 * This is tidy-up, not the guarantee. What stops the holder of a leftover shown link from
 * replacing the active account's password is the `/reset-password` before-hook
 * (password-reset-links.ts `isResetLinkRedeemable`): a link that was not mailed is spendable only
 * while the account is a pending invite. So a failed cleanup is logged, never surfaced: the
 * activation is already committed, and failing the request would only report a verification
 * that worked as failed (a retry returns early, so it would not re-run the cleanup either).
 *
 * Runs as a Better Auth database after-hook, which fires once the write is committed, and takes
 * the per-user credential-setup lock minting takes (packages/api lib/set-password-link.ts). A
 * mint racing the activation therefore either re-reads the user under the lock after the
 * activation committed and refuses (no longer a pending invite), or committed its link before
 * this took the lock, and this deletes it.
 */

/** Endpoint contexts whose user update set `emailVerified: true`. */
const verificationWrites = new WeakSet<object>();

/** `databaseHooks.user.update.before`: note a write that verifies the email. */
export function noteVerificationWrite(data: Record<string, unknown>, context: unknown): void {
  if (data.emailVerified === true && typeof context === "object" && context !== null) {
    verificationWrites.add(context);
  }
}

/**
 * `databaseHooks.user.update.after`: if this update verified the email, the account is active,
 * so its reset links go. With no endpoint context (a server-side internal write) it cannot tell,
 * so it cleans up whenever the row is verified: fail safe.
 */
export async function afterUserUpdate(
  user: { id?: unknown; emailVerified?: unknown } | null | undefined,
  context: unknown,
): Promise<void> {
  if (user?.emailVerified !== true || typeof user.id !== "string") return;
  const known = typeof context === "object" && context !== null;
  if (known && !verificationWrites.has(context)) return;
  await deleteResetLinksOnActivation(user.id);
}

/** Attempts, and the pause before each retry (ms). */
const ATTEMPTS = 3;
const BACKOFF_MS = [100, 400] as const;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Under the credential-setup lock, delete every reset link of `userId`. Idempotent, so it is
 * retried; a final failure is logged (user id and error class only) and swallowed: the leftover
 * links are refused at redemption anyway and expire on their own.
 */
export async function deleteResetLinksOnActivation(
  userId: string,
  { sleep = defaultSleep }: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(BACKOFF_MS[attempt - 1] ?? 400);
    try {
      await prisma.$transaction(async (tx) => {
        await lockCredentialSetup(tx, userId);
        await deleteResetLinks(tx, userId);
      });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  console.error(
    `[auth] deleting reset links on account activation failed after ${ATTEMPTS} attempts; they are refused at redemption and expire on their own.`,
    `user=${userId}`,
    lastError instanceof Error ? (lastError.constructor?.name ?? "Error") : typeof lastError,
  );
}
