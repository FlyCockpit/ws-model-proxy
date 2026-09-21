import { useQuery } from "@tanstack/react-query";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useMcpConsentSubmit } from "@/hooks/use-mcp-consent-submit";
import { authClient } from "@/lib/auth-client";
import {
  explainableMcpScopes,
  mcpSearchFingerprint,
  parseMcpOAuthSearch,
  toMcpPublicClientInfo,
} from "@/lib/mcp-oauth-search";

/**
 * MCP OAuth consent page UI (Phase 6) — rendered by the
 * `/$lang/mcp-consent` route, which owns availability + session gating.
 *
 * Requires a usable signed OAuth transaction in the URL. Canonical client
 * data comes from the session-authenticated GET /oauth2/public-client
 * (display-safe fields only; the remote `logo_uri` is never fetched or
 * rendered). Approval and denial both submit through POST /oauth2/consent
 * with `accept: true | false`; the page navigates ONLY on a server response
 * carrying `redirect === true` plus a nonempty `url` — including denial,
 * where Better Auth returns the client's redirect_uri with
 * `error=access_denied`. `oauth2.continue` is NOT used here: this deployment
 * has no upstream account/post-login continuation screen, and
 * `continue({ postLogin: true })` must never be treated as proof of
 * reauthentication.
 */

/**
 * All transient state (the consent phase from useMcpConsentSubmit) is bound
 * to the OAuth TRANSACTION via a `key` remount (R85 N2): TanStack does NOT
 * remount a route component on search change (installed Match.tsx renders
 * through without remountDeps), so a replaced transaction (new `sig` in the
 * URL) would otherwise leave the page stuck in a prior transaction's
 * invalid/denied/submitting terminal state. Keying on the search fingerprint
 * gives every transaction a fresh, transaction-scoped phase — including a
 * disposed-guard that voids the replaced transaction's in-flight completion.
 */
export function McpConsentPage({ search }: { search: Record<string, unknown> }) {
  const fingerprint = useMemo(() => mcpSearchFingerprint(search), [search]);
  return <McpConsentTransaction key={fingerprint} search={search} />;
}

function McpConsentTransaction({ search }: { search: Record<string, unknown> }) {
  const info = useMemo(() => parseMcpOAuthSearch(search), [search]);
  const { t } = useTranslation(["auth", "common"]);
  const { phase, submit } = useMcpConsentSubmit();

  const client = useQuery({
    queryKey: ["mcp-consent-client", info.clientId],
    enabled: info.usable,
    retry: false,
    queryFn: async () => {
      if (info.clientId === null) throw new Error("missing client_id");
      const result = await authClient.oauth2.publicClient({ query: { client_id: info.clientId } });
      if (result.error) throw result.error;
      return toMcpPublicClientInfo(result.data);
    },
  });

  if (phase === "denied") {
    return (
      <ConsentTerminalCard
        title={t("auth:mcpConsent.deniedTitle")}
        description={t("auth:mcpConsent.deniedDescription")}
      />
    );
  }

  if (
    phase === "invalid" ||
    !info.usable ||
    client.isError ||
    (client.isSuccess && client.data === null)
  ) {
    // "invalid" is the terminal phase for consent API errors (invalid
    // signature / expired transaction), thrown failures, and approval
    // responses without a redirect (R83/R84 F4) — the approval buttons must
    // NOT reappear for a transaction that can no longer be completed.
    return (
      <ConsentTerminalCard
        title={t("auth:mcpConsent.invalidTitle")}
        description={t("auth:mcpConsent.invalidDescription")}
      />
    );
  }

  if (client.isPending || phase === "submitting") {
    return (
      <div className="flex min-w-0 items-center justify-center px-4 py-10">
        <div className="w-full max-w-md space-y-4">
          <Skeleton className="mx-auto h-8 w-48" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      </div>
    );
  }

  const clientInfo = client.data;
  const clientName = clientInfo?.name ?? clientInfo?.clientId ?? t("auth:mcpConsent.unknownClient");
  const scopeRows = explainableMcpScopes(info.scopes);

  return (
    <div className="flex min-w-0 items-center justify-center px-4 py-10">
      <Card className="w-full min-w-0 max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">{t("auth:mcpConsent.title")}</CardTitle>
          <CardDescription className="min-w-0 break-words">
            {t("auth:mcpConsent.description", { client: clientName })}
          </CardDescription>
          {clientInfo?.uri != null ? (
            <p className="min-w-0 truncate text-xs text-muted-foreground">{clientInfo.uri}</p>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3">
            <p className="text-sm font-medium">{t("auth:mcpConsent.scopesTitle")}</p>
            <ul className="space-y-3">
              {scopeRows.length === 0 ? (
                <li className="text-sm text-muted-foreground">{t("auth:mcpConsent.noScopes")}</li>
              ) : (
                scopeRows.map((row) => (
                  <li key={row.raw} className="min-w-0 space-y-1">
                    <p className="min-w-0 break-words text-sm font-medium">
                      {row.key === null
                        ? t("auth:mcpConsent.scopes.additionalName", { scope: row.raw })
                        : t(`auth:mcpConsent.scopes.${row.key}.name`)}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {row.key === null
                        ? t("auth:mcpConsent.scopes.additionalDescription")
                        : t(`auth:mcpConsent.scopes.${row.key}.description`)}
                    </p>
                  </li>
                ))
              )}
            </ul>
            <p className="text-xs text-muted-foreground">{t("auth:mcpConsent.manageNote")}</p>
          </div>
          <div className="space-y-2">
            {/* Submitting renders the skeleton above, so these are only
                reachable in the review phase. */}
            <Button className="min-h-[44px] w-full" onClick={() => void submit(true)}>
              {t("auth:mcpConsent.accept")}
            </Button>
            <Button
              variant="outline"
              className="min-h-[44px] w-full"
              onClick={() => void submit(false)}
            >
              {t("auth:mcpConsent.deny")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ConsentTerminalCard({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-w-0 items-center justify-center px-4 py-10">
      <Card className="w-full min-w-0 max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">{title}</CardTitle>
          <CardDescription className="min-w-0 break-words">{description}</CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
