/** Shared contexts for the lane C router tests (people, cookies without CSRF, agents). */
import type { Session } from "@ws-model-proxy/auth";
import type { Context, ContextServices } from "../context";
import type { CallerAuth } from "../contracts/auth-context";

export const OWNER = "owner-1";

export function sessionFor(userId = OWNER): Session {
  return {
    user: {
      id: userId,
      email: `${userId}@example.test`,
      name: "Owner",
      role: "user",
      emailVerified: true,
      twoFactorEnabled: false,
    },
    session: { id: "s", userId, expiresAt: new Date(Date.now() + 60_000) },
  } as Session;
}

export const CALLERS = {
  person: (userId = OWNER): CallerAuth => ({
    kind: "cookie_session",
    userId,
    sessionId: "s",
    csrfVerified: true,
  }),
  cookieWithoutCsrf: (userId = OWNER): CallerAuth => ({
    kind: "cookie_session",
    userId,
    sessionId: "s",
    csrfVerified: false,
  }),
  fullAgent: (userId = OWNER): CallerAuth => ({
    kind: "agent_token",
    userId,
    agentTokenId: "tok-1",
    level: "FULL",
  }),
  oauthAgent: (userId = OWNER): CallerAuth => ({
    kind: "oauth_access_token",
    userId,
    grantId: "grant-1",
    level: "FULL",
  }),
};

export function contextFor(auth: CallerAuth, services?: ContextServices): Context {
  return { auth, session: sessionFor(auth.userId), services };
}
