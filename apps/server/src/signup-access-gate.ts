import { isPendingShareInviteToken } from "@ws-model-proxy/auth/share-invite-acceptance";
import { getSignupAccessState, SIGNUP_DISABLED_MESSAGE } from "@ws-model-proxy/auth/signup-policy";
import { parseShareInviteToken, SHARE_INVITE_HEADER } from "@ws-model-proxy/config/share-invite";
import type { MiddlewareHandler } from "hono";

/**
 * Guards `/api/auth/sign-up/*`. With open sign-up off, only the first-admin bootstrap and an
 * invite sign-up get through: the `x-wsmp-invite` header must hold the token of a pending,
 * unexpired share invite. The token is never logged. The user-create hook re-checks both
 * (packages/auth `resolveUserCreatePolicy`), so this gate is the early refusal, not the only one.
 */
export const signupAccessGate: MiddlewareHandler = async (c, next) => {
  const signupAccess = await getSignupAccessState();
  if (signupAccess.signupEnabled || signupAccess.adminBootstrapSignupEnabled) {
    return next();
  }

  const inviteToken = parseShareInviteToken(c.req.header(SHARE_INVITE_HEADER));
  if (inviteToken !== null && (await isPendingShareInviteToken(inviteToken))) {
    return next();
  }

  return c.json({ error: SIGNUP_DISABLED_MESSAGE }, 403);
};
