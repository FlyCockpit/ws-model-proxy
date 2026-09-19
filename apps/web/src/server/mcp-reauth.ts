import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

/**
 * Tombstone probe for the MCP login route's authenticated branch (MCP plan
 * Phase 6). When Better Auth's `postLogin.shouldRedirect` detects that the
 * current session/client grant generation is tombstoned, it redirects the
 * browser to the MCP login page with the signed `oauth_query` preserved.
 * This server function answers the page's follow-up question — "is THIS
 * session's generation for THIS client revoked?" — with the exact same
 * derivation the grant integration uses:
 *
 *   referenceId = HMAC(BETTER_AUTH_SECRET, sessionId, clientId)
 *   tombstoned  = McpGrant(userId, clientId, referenceId).revokedAt != null
 *
 * Fail direction: a session-resolution or storage error resolves to
 * `"continue"`. This is a UX probe only — the authoritative tombstone
 * enforcement lives elsewhere: `postLogin.shouldRedirect` READS the
 * tombstone (isMcpGrantGenerationTombstoned) to send the browser here, and
 * the token-issuance claims hooks (mcp-grant.ts `issueMcpGrantClaims`)
 * reject revoked generations when minting code/refresh/introspection
 * tokens. `postLogin.consentReferenceId` only DERIVES the HMAC reference —
 * it performs no revocation check, and the consent path itself does NOT
 * reject a fallback continuation. A stale "continue" can therefore never
 * mint a token; at worst it shows the consent page once more before
 * issuance fails closed.
 *
 * The client ID is only ever used as an exact `(userId, clientId, referenceId)`
 * lookup key derived from the caller's OWN cookie session — no caller-supplied
 * user ID is accepted (invariant 6), and cookies are the only accepted
 * credential (cookieSessionHeaders strips `authorization`).
 */
export const getMcpReauthStatus = createServerFn({ method: "GET" })
  .validator((input: unknown): { clientId: string } => {
    if (typeof input !== "object" || input === null) {
      throw new Error("Invalid MCP reauth probe input");
    }
    const clientId = (input as Record<string, unknown>).clientId;
    if (typeof clientId !== "string" || clientId.length === 0) {
      throw new Error("clientId is required");
    }
    return { clientId };
  })
  .handler(
    async ({
      data,
    }: {
      data: { clientId: string };
    }): Promise<{ status: "no-session" } | { status: "reauth" } | { status: "continue" }> => {
      // The dynamic imports run INSIDE this catch (R83/R84 F7): an
      // initialization failure must resolve to the same safe fallback as an
      // operational failure — never escape as an escaped server error that
      // start-server-core would serialize to the client.
      try {
        const [{ auth }, { cookieSessionHeaders }] = await Promise.all([
          import("@ws-model-proxy/auth"),
          import("@ws-model-proxy/auth/cookie-session"),
        ]);
        const session = await auth.api.getSession({
          headers: cookieSessionHeaders(getRequestHeaders()),
        });
        const sessionId = session?.session?.id;
        const userId = session?.user?.id;
        if (typeof sessionId !== "string" || sessionId.length === 0)
          return { status: "no-session" };
        if (typeof userId !== "string" || userId.length === 0) return { status: "no-session" };

        const [{ deriveMcpConsentReferenceId, isMcpGrantGenerationTombstoned }, { env }] =
          await Promise.all([
            import("@ws-model-proxy/auth/mcp-grant"),
            import("@ws-model-proxy/env/server"),
          ]);
        const referenceId = deriveMcpConsentReferenceId({
          secret: env.BETTER_AUTH_SECRET,
          sessionId,
          clientId: data.clientId,
        });
        const tombstoned = await isMcpGrantGenerationTombstoned({
          userId,
          clientId: data.clientId,
          referenceId,
        });
        return { status: tombstoned ? "reauth" : "continue" };
      } catch {
        // Fail toward "continue" (see the doc comment): consent/token-time
        // enforcement is authoritative and fails closed.
        return { status: "continue" };
      }
    },
  );
