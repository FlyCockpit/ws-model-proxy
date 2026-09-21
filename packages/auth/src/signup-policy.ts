import prisma from "@ws-model-proxy/db";
import { ADMIN_EMAIL, env, SIGNUP_ENABLED } from "@ws-model-proxy/env/server";

export const SIGNUP_ENABLED_SETTING_KEY = "signupEnabled";
export const SIGNUP_DISABLED_MESSAGE =
  "Sign-up is currently disabled. Contact an admin if you need access.";

function parseBooleanSetting(value: string | null | undefined): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

export async function getRuntimeSignupEnabled(): Promise<boolean> {
  const setting = await prisma.appSetting.findUnique({
    where: { key: SIGNUP_ENABLED_SETTING_KEY },
    select: { value: true },
  });
  return parseBooleanSetting(setting?.value) ?? SIGNUP_ENABLED;
}

export async function getSignupAccessState(): Promise<{
  signupEnabled: boolean;
  adminBootstrapSignupEnabled: boolean;
  userCount: number;
}> {
  const [signupEnabled, userCount] = await Promise.all([
    getRuntimeSignupEnabled(),
    prisma.user.count(),
  ]);

  return {
    signupEnabled,
    // Local development keeps the zero-config first-user flow. A fresh
    // production instance with public signup closed must have one explicit
    // owner identity; the create hook below verifies and canonicalizes the
    // submitted address before it assigns the admin role.
    adminBootstrapSignupEnabled:
      !signupEnabled &&
      userCount === 0 &&
      (env.NODE_ENV !== "production" || ADMIN_EMAIL !== undefined),
    userCount,
  };
}

/**
 * The database hook is the authorization boundary for a production bootstrap,
 * because the HTTP gate cannot safely trust a request body as an identity.
 *
 * In production, every case/whitespace variant of the configured owner maps
 * to the same persisted email before Prisma reaches @@unique(email). Thus two
 * concurrent bootstrap requests can produce at most one user row. Local and
 * test first-user creation retains its zero-config behavior and preserves the
 * submitted address.
 */
export function resolveBootstrapAdminIdentity(email: unknown): {
  allowed: boolean;
  canonicalEmail?: string;
} {
  if (env.NODE_ENV !== "production") return { allowed: true };
  if (typeof email !== "string" || ADMIN_EMAIL === undefined) return { allowed: false };
  if (email.trim().toLowerCase() !== ADMIN_EMAIL) return { allowed: false };
  return { allowed: true, canonicalEmail: ADMIN_EMAIL };
}
