import { useCallback, useEffect, useRef, useState } from "react";
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
export type ConsentPhase = "review" | "submitting" | "denied" | "invalid";

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

  const submit = useCallback(async (accept: boolean) => {
    setPhase("submitting");
    try {
      // The signed oauth_query is attached by oauthProviderClient() from
      // window.location.search; this call sends ONLY the accept decision.
      const result = await authClient.oauth2.consent({ accept });
      if (disposed.current) return;
      if (result.error) {
        // invalid_signature / expired transaction / missing oauth query: the
        // transaction cannot be completed from this page.
        setPhase("invalid");
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
      setPhase(accept ? "invalid" : "denied");
    } catch {
      if (!disposed.current) setPhase("invalid");
    }
  }, []);

  return { phase, submit };
}
