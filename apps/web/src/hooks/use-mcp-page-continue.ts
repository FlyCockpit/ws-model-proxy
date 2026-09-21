import { useEffect } from "react";
import { mcpPageHref } from "@/lib/mcp-oauth-search";

/**
 * Derived-state navigation for the MCP login page's authenticated "continue"
 * branch (Phase 6).
 *
 * The transition to the consent page must preserve the RAW signed OAuth
 * query (client_id, scope, resource, state, code_challenge, sig, …)
 * byte-for-byte. TanStack Router reserializes search on every navigation —
 * including `search: true` and href-based `buildLocation` round trips
 * (installed @tanstack/router-core dist router.js `buildLocation`/
 * `buildAndCommitLocation`) — which collapses Better Auth's REPEATED
 * `ba_param` keys into one JSON-array parameter and kills the signature
 * (R83/R84 F1, probe-pinned in mcp-page-transition.dom.test.ts). The hook
 * therefore performs a full same-origin DOCUMENT navigation built from the
 * browser's own `window.location.search`, the one client-side source that
 * never round-trips. This is a custom hook (not an inline effect in the
 * route file) per the repo's React rules.
 *
 * Fires only on the rising edge of `shouldContinue` (the dependency array is
 * the boolean itself), so a consent-page render that stays put does not loop.
 * The production default assign is a MODULE-LEVEL constant (R85/R86 N3): an
 * inline default arrow would be recreated on every render, sit in the effect
 * deps, and re-navigate on any ordinary rerender while `shouldContinue`
 * stays true. Injected test doubles are referentially stable by construction,
 * so the effect deps never churn.
 */
const browserAssign = (href: string): void => {
  window.location.assign(href);
};

export function useMcpPageContinue(
  shouldContinue: boolean,
  lang: string,
  assign: (href: string) => void = browserAssign,
) {
  useEffect(() => {
    if (!shouldContinue) return;
    assign(mcpPageHref(lang, "mcp-consent", window.location.search));
  }, [shouldContinue, lang, assign]);
}
