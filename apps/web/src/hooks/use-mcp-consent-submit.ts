import { useCallback, useEffect, useRef, useState } from "react";
import type { EditableAgentAccess } from "@/lib/agent-access";
import { authClient } from "@/lib/auth-client";
import { resolveOauthRedirectUrl } from "@/lib/mcp-oauth-search";

/**
 * Consent submission with transaction/page lifetime ownership
 * (Phase 6, Part H pass 3 — R85 N2).
 *
 * The terminal phase belongs to ONE transaction rendering. The consent page
 * remounts this hook (`key={fingerprint}` on the transaction-scoped inner
 * component), and the hook additionally guards its own lifetime: the effect
 * cleanup sets a disposed flag on unmount, so an obsolete completion (the
 * transaction was replaced, or the page unmounted) can NEITHER setState NOR
 * call `window.location.assign` — navigation authority dies with the
 * transaction that earned it. The ONLY navigation signal is still the
 * server-issued contract `redirect === true` + nonempty `url`
 * (resolveOauthRedirectUrl); denial carries the client's redirect_uri with
 * `error=access_denied` through the same contract.
 */
export type ConsentPhase = "review" | "submitting" | "denied" | "invalid" | "error";

/** Better Auth's consent body plus the access fields read by the server consent hooks. */
type ConsentBody = NonNullable<Parameters<typeof authClient.oauth2.consent>[0]> & {
  scopes?: EditableAgentAccess["scopes"];
  nodeIds?: string[] | null;
};

export function useMcpConsentSubmit() {
  const [phase, setPhase] = useState<ConsentPhase>("review");
  const disposed = useRef(false);

  // Setup RESTORES the active lifetime before returning the cleanup that
  // ends it (R87/R88 P1): the app mounts under root <React.StrictMode>
  // (apps/web/src/client.tsx), whose development effect replay runs
  // setup → cleanup → setup on the SAME instance. A cleanup-only flag
  // stayed `true` forever after that replay, permanently discarding the
  // redirect response of a LIVE submission. Restoring in setup keeps the
  // genuine unmount/replacement suppression (cleanup still runs — and is
  // never followed by another setup — on a real unmount or `key`
  // replacement).
  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
    };
  }, []);

  // The OAuth client plugin attaches the signed oauth_query from the raw URL.
  // Denial carries only the decision; access always comes from the person's form.
  const submit = useCallback(async (accept: boolean, access?: EditableAgentAccess) => {
    setPhase("submitting");
    try {
      // The signed oauth_query is attached by oauthProviderClient() from
      // window.location.search; the body carries the person's decision and chosen access.
      const body: ConsentBody = accept && access !== undefined ? { accept, ...access } : { accept };
      const result = await authClient.oauth2.consent(body);
      if (disposed.current) return;
      if (result.error) {
        // The provider uses invalid_signature for failed signature OR expiry verification.
        // Other failures (including a generic 400) must not claim the signature expired.
        setPhase(isInvalidConsentTransaction(result.error) ? "invalid" : "error");
        return;
      }
      const url = resolveOauthRedirectUrl(result.data);
      if (url !== null) {
        // The ONLY navigation signal: server-issued redirect === true + url
        // (consent success AND denial both arrive this way — denial carries
        // the client's redirect_uri with error=access_denied).
        window.location.assign(url);
        return;
      }
      setPhase(accept ? "error" : "denied");
    } catch {
      if (!disposed.current) setPhase("error");
    }
  }, []);

  return { phase, submit };
}

function isInvalidConsentTransaction(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (
    ("code" in error && error.code === "invalid_signature") ||
    ("error" in error && error.error === "invalid_signature")
  );
}
