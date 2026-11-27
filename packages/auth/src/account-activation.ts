import prisma from "@ws-model-proxy/db";
import { lockCredentialSetup } from "./credential-setup-lock";
import { deleteResetLinks } from "./password-reset-links";

/**
 * Activation and reset admission serialize in the adapter transaction under the owner fence.
 * Competing links are deleted atomically with verification; reset admission rechecks eligibility
 * with the password write. This after-hook retries cleanup as defense in depth.
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
