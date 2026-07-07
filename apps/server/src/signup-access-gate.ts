import { getSignupAccessState, SIGNUP_DISABLED_MESSAGE } from "@ws-model-proxy/auth/signup-policy";
import type { MiddlewareHandler } from "hono";

export const signupAccessGate: MiddlewareHandler = async (c, next) => {
  const signupAccess = await getSignupAccessState();
  if (signupAccess.signupEnabled || signupAccess.adminBootstrapSignupEnabled) {
    return next();
  }

  return c.json({ error: SIGNUP_DISABLED_MESSAGE }, 403);
};
