import prisma from "@ws-model-proxy/db";
import { SIGNUP_ENABLED } from "@ws-model-proxy/env/server";

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
    adminBootstrapSignupEnabled: !signupEnabled && userCount === 0,
    userCount,
  };
}
