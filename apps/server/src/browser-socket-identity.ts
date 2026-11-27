import { upgradeWebSocket } from "@hono/node-server";
import type { Context } from "hono";

/** Optional consistency fence for cookie sockets, like HTTP X-Expected-User. */
export function hasExpectedBrowserIdentity(c: Context, cookieOwner: string): boolean {
  const expected = c.req.queries("expectedUser");
  // An omitted/empty owner adds no constraint; only a supplied mismatch refuses.
  // This never grants authentication or changes bearer/API-key admission.
  return !expected?.some((owner) => owner !== "" && owner !== cookieOwner);
}

/** Upgrade only to deliver a distinct browser-visible refusal, admitting no work. */
export const rejectBrowserIdentity = upgradeWebSocket(() => ({
  onOpen(_event, ws) {
    // Kept in sync with web/lib/document-identity.ts.
    ws.close(4409, "identity_changed");
  },
}));
