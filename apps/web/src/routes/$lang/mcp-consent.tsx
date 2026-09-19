import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { McpConsentPage } from "@/components/mcp/mcp-consent-page";
import { mcpPageHref } from "@/lib/mcp-oauth-search";
import { decideMcpConsentRouteAccess } from "@/lib/route-session-access";
import { getRouteSession } from "@/server/auth-session";
import { getMcpWebAvailability } from "@/server/mcp-availability";
import { getRawRequestSearch } from "@/server/raw-request-search";

/**
 * MCP OAuth consent page (MCP plan Phase 6) — `packages/auth/src/mcp-config.ts`
 * `MCP_CONSENT_PAGE_PATH_DEFAULT`.
 *
 * Requires a browser session (unauthenticated visitors are sent to the MCP
 * login page with the signed query preserved byte-identically) and a usable
 * signed OAuth transaction in the URL. The UI lives in
 * `@/components/mcp/mcp-consent-page` (DOM-testable without a router).
 */
export const Route = createFileRoute("/$lang/mcp-consent")({
  // Pass the ENTIRE search through unchanged: the signed OAuth parameters are
  // the transaction (consent re-validates them from the forwarded
  // oauth_query).
  validateSearch: (search: Record<string, unknown>) => search,
  beforeLoad: async ({ params }) => {
    const availability = await getMcpWebAvailability();
    if (!availability.enabled) throw notFound();
    const decision = decideMcpConsentRouteAccess(await getRouteSession());
    if (decision.kind === "error") throw new Error("Route session unavailable");
    if (decision.kind === "redirect-to-mcp-login") {
      // The signed OAuth query must survive this transition BYTE-IDENTICALLY.
      // TanStack Router reserializes search on every navigation (installed
      // router-core dist router.js buildLocation/buildAndCommitLocation —
      // `search: true`, href navigations, and even `location.searchStr` are
      // parse→stringify round trips), which collapses Better Auth's REPEATED
      // `ba_param` keys and kills the signature (R83/R84 F1). The href is
      // therefore built from the RAW query — `window.location.search` in the
      // browser, the raw request URL on the server — and `reloadDocument:
      // true` makes the client execute it as a document navigation
      // (`window.location.href = href`, raw string; the server serves the
      // 302 with the same raw Location). Probe-pinned in
      // mcp-page-transition.dom.test.ts.
      const rawSearch =
        typeof window === "undefined" ? await getRawRequestSearch() : window.location.search;
      throw redirect({
        href: mcpPageHref(params.lang, "mcp-login", rawSearch),
        reloadDocument: true,
      });
    }
  },
  component: ConsentRouteComponent,
});

function ConsentRouteComponent() {
  const search = Route.useSearch() as Record<string, unknown>;
  return <McpConsentPage search={search} />;
}
