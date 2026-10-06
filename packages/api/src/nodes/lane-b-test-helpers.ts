/**
 * Callers for lane B router tests. The test files mock `@ws-model-proxy/db` themselves (vi.mock
 * is hoisted per file); this module only builds contexts.
 */
import type { Session } from "@ws-model-proxy/auth";
import type { Context } from "../context";
import type { AnonymousAuth, CallerAuth } from "../contracts/auth-context";
import type { NodeRelayServices } from "../lib/node-relay-services";

export const OWNER = "owner-1";

export const session = {
  user: {
    id: OWNER,
    email: "o@example.test",
    name: "Owner",
    role: "user",
    emailVerified: true,
    twoFactorEnabled: true,
  },
  session: { id: "s-1", userId: OWNER, expiresAt: new Date(Date.now() + 3_600_000) },
} as unknown as Session;

export const PERSON: CallerAuth = {
  kind: "cookie_session",
  userId: OWNER,
  sessionId: "s-1",
  csrfVerified: true,
};
export const FULL_AGENT: CallerAuth = {
  kind: "agent_token",
  userId: OWNER,
  agentTokenId: "tok-1",
  level: "FULL",
};
export const READ_AGENT: CallerAuth = {
  kind: "agent_token",
  userId: OWNER,
  agentTokenId: "tok-2",
  level: "READ",
};

/** Every caller that is NOT a verified person. */
export const NOT_A_PERSON: ReadonlyArray<[string, CallerAuth | AnonymousAuth]> = [
  ["Full agent token", FULL_AGENT],
  [
    "OAuth access token",
    { kind: "oauth_access_token", userId: OWNER, grantId: "g", level: "FULL" },
  ],
  ["API key", { kind: "api_key", userId: OWNER, apiKeyId: "k" }],
  [
    "cookie without the CSRF header",
    { kind: "cookie_session", userId: OWNER, sessionId: "s-1", csrfVerified: false },
  ],
];

export function contextFor(auth: CallerAuth | AnonymousAuth, nodes?: NodeRelayServices): Context {
  return { session, auth, services: nodes ? { nodes } : undefined };
}

type Callable = (input: unknown) => Promise<unknown>;

export function procedureAt(client: unknown, path: string): Callable {
  let node: unknown = client;
  for (const key of path.split(".")) node = (node as Record<string, unknown>)[key];
  if (typeof node !== "function") throw new Error(`no procedure at ${path}`);
  return node as Callable;
}
