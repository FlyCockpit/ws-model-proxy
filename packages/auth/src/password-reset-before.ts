import { APIError } from "better-auth/api";
import { revokeUserCredentials } from "./credential-revocation";

/** Better Auth 1.7.18 commits recovery before onPasswordReset: secure standing access first. */
export async function secureAccountBeforePasswordReset(ctx: {
  path?: string;
  body?: { token?: unknown } | undefined;
  query?: { token?: unknown } | undefined;
  context: {
    internalAdapter: {
      findVerificationValue: (
        identifier: string,
      ) => Promise<{ value: string; expiresAt: Date } | null>;
    };
  };
}): Promise<void> {
  if (ctx.path !== "/reset-password") return;
  // Match the pinned endpoint's body/query precedence and strict expiry comparison.
  const token = ctx.body?.token || ctx.query?.token;
  if (typeof token !== "string" || !token) return;
  try {
    const verification = await ctx.context.internalAdapter.findVerificationValue(
      `reset-password:${token}`,
    );
    if (!verification || verification.expiresAt < new Date()) return;
    // If reset later fails before replacing the password, the password is unchanged
    // but the user is signed out everywhere and credentials are revoked: the safe direction.
    await revokeUserCredentials(verification.value, { revokeSessions: true });
  } catch {
    throw new APIError("SERVICE_UNAVAILABLE", {
      message:
        "We couldn't finish securing your account. Nothing was changed — try the link again.",
    });
  }
}
