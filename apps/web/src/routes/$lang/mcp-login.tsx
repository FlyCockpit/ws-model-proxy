import { useQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { SignInCard } from "@/components/auth/sign-in-card";
import { McpInvalidRequestCard } from "@/components/mcp/mcp-invalid-request-card";
import { McpReauthBranch } from "@/components/mcp/mcp-reauth-branch";
import { useAuthSession } from "@/hooks/use-auth-session";
import { authClient } from "@/lib/auth-client";
import {
  type McpOAuthSearchInfo,
  mcpPreloginClientQueryKey,
  mcpSearchFingerprint,
  parseMcpOAuthSearch,
  toMcpPublicClientInfo,
} from "@/lib/mcp-oauth-search";
import { getMcpWebAvailability } from "@/server/mcp-availability";

/**
 * MCP OAuth login page (MCP plan Phase 6) — the same localized route Better
 * Auth's `postLogin.page` points at (`packages/auth/src/mcp-config.ts`,
 * `MCP_LOGIN_PAGE_PATH_DEFAULT`).
 *
 * The signed OAuth transaction arrives as individual query parameters in the
 * URL (client_id, scope, … sig). Nothing here reconstructs an authorize URL
 * or appends OAuth state to sign-in calls: Better Auth's
 * `oauthProviderClient()` fetch plugin on `authClient` forwards exactly the
 * signed parameters as `oauth_query` on every non-GET auth request, and the
 * sign-in APIs are called UNCHANGED from the shared SignInCard.
 *
 * Branches:
 *  - flag off            → beforeLoad throws notFound() before any work.
 *  - unusable URL        → localized invalid-request card (no network calls).
 *  - anonymous           → display-safe prelogin client data (POST
 *                          /oauth2/public-client-prelogin; enabled only by
 *                          `allowPublicClientPrelogin` and a valid signature)
 *                          plus the shared sign-in flow in "mcp" mode.
 *  - authenticated + tombstoned generation → "Sign in again to reauthorize"
 *                          card; confirming signs out with
 *                          `disableRedirect: true` WITHOUT navigating (the
 *                          signed query stays in this URL) and the anonymous
 *                          branch takes over in place. A genuinely new
 *                          session creates a NEW generation —
 *                          `oauth2.continue({ postLogin: true })` is never
 *                          used as proof of reauthentication.
 *  - authenticated + live generation → continue to the consent page with the
 *                          search preserved verbatim.
 */
export const Route = createFileRoute("/$lang/mcp-login")({
  // Pass the ENTIRE search through unchanged: the signed OAuth parameters are
  // the transaction. Any filtering here would strip signed state.
  validateSearch: (search: Record<string, unknown>) => search,
  beforeLoad: async () => {
    const availability = await getMcpWebAvailability();
    if (!availability.enabled) throw notFound();
  },
  component: McpLoginPage,
});

function McpLoginPage() {
  const { lang } = Route.useParams();
  const search = Route.useSearch() as Record<string, unknown>;
  const info = useMemo(() => parseMcpOAuthSearch(search), [search]);
  const fingerprint = useMemo(() => mcpSearchFingerprint(search), [search]);
  const { state } = useAuthSession();

  if (!info.usable) {
    return <McpInvalidRequestCard />;
  }

  if (state.status === "pending") {
    return <McpPageSkeleton />;
  }

  if (state.status === "authenticated" || (state.status === "error" && state.session !== null)) {
    // Session identity for the reauth probe: the SESSION id, not the user id
    // (R85/R86 N1) — the grant generation derives from the session id, so
    // the same user with a replaced session is a different generation.
    // McpReauthBranch owns the decision (fresh probe per key, gcTime 0,
    // navigation gated on !isFetching) and is extracted for DOM testing.
    if (state.session === null) throw new Error("Route session unavailable");
    // Fail closed if the session record (and its id) is ever absent — the
    // user id must NEVER be substituted as the generation identity.
    const sessionId = state.session.session?.id;
    if (sessionId === undefined) throw new Error("Route session id unavailable");
    return (
      <McpReauthBranch
        session={{ id: sessionId }}
        clientId={info.clientId}
        lang={lang}
        fingerprint={fingerprint}
      />
    );
  }

  return <McpAnonymousLogin info={info} lang={lang} fingerprint={fingerprint} />;
}

function McpPageSkeleton() {
  return (
    <div className="flex min-w-0 items-center justify-center px-4 py-10">
      <div className="w-full max-w-md space-y-6">
        <div className="space-y-2 text-center">
          <Skeleton className="mx-auto h-8 w-40" />
          <Skeleton className="mx-auto h-4 w-56" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </div>
    </div>
  );
}

/**
 * Display-safe prelogin client data. The POST carries the signed oauth_query
 * (attached by oauthProviderClient()); the server rejects an invalid or
 * expired signature, so any error here renders the invalid-request card —
 * the flow can NOT continue without a valid transaction. The response's
 * text fields (name/uri) are the only thing rendered; the `icon` field is
 * deliberately dropped at the projection boundary (never fetched, never
 * shown — an untrusted remote logo).
 */
function useMcpPreloginClient(clientId: string | null, fingerprint: string, enabled: boolean) {
  return useQuery({
    // Keyed to client AND the signed transaction fingerprint (R83/R84 F5):
    // a cached success can never be reused for a different/expired signed
    // query. Cheap probe — NO retained data (gcTime 0, R85/R86 N1): every
    // mount waits for a fresh prelogin decision instead of acting on a
    // cached success/error while the fresh probe refetches.
    queryKey: mcpPreloginClientQueryKey(clientId ?? "", fingerprint),
    enabled: enabled && clientId !== null,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    queryFn: async () => {
      const result = await authClient.oauth2.publicClientPrelogin({
        client_id: clientId as string,
      });
      if (result.error) throw result.error;
      return toMcpPublicClientInfo(result.data);
    },
  });
}

function McpAnonymousLogin({
  info,
  lang,
  fingerprint,
}: {
  info: McpOAuthSearchInfo;
  lang: string;
  fingerprint: string;
}) {
  const { t } = useTranslation(["auth", "common"]);
  const prelogin = useMcpPreloginClient(info.clientId, fingerprint, true);

  if (prelogin.isError) {
    // Invalid signature / expired transaction: the signed endpoints would
    // reject every next step, so fail into the terminal invalid card.
    return <McpInvalidRequestCard />;
  }

  const client = prelogin.data ?? null;
  const description =
    client?.name != null
      ? t("auth:mcpLogin.clientDescription", { client: client.name })
      : prelogin.isPending
        ? undefined
        : t("auth:mcpLogin.description");

  // No viewport frame here: the shared SignInCard already owns its frame
  // (sign-in-card.tsx), and the root shell owns viewport height — nesting
  // another frame inside it duplicated shell geometry (R83/R84 F6).
  return (
    <div className="mx-auto w-full min-w-0 max-w-md space-y-4 px-4">
      {client?.uri != null ? (
        <p className="min-w-0 truncate text-center text-xs text-muted-foreground">{client.uri}</p>
      ) : null}
      <SignInCard lang={lang} mode="mcp" mcpDescription={description} />
    </div>
  );
}
