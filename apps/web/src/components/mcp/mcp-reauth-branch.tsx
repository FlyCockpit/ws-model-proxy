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
import { useTranslation } from "react-i18next";
import { McpInvalidRequestCard } from "@/components/mcp/mcp-invalid-request-card";
import { useMcpPageContinue } from "@/hooks/use-mcp-page-continue";
import { useMcpReauthSignOut } from "@/hooks/use-mcp-reauth-sign-out";
import { mcpReauthStatusQueryKey } from "@/lib/mcp-oauth-search";
import { getMcpReauthStatus } from "@/server/mcp-reauth";

/**
 * Tombstone-reauthorization branch of the MCP login page (Phase 6).
 * Extracted from `routes/$lang/mcp-login.tsx` for DOM testability (same
 * precedent as McpConsentPage) — the route supplies the session, transaction
 * fingerprint, and parsed search; this component owns the reauth DECISION.
 *
 * Decision freshness (Part H pass 3 — R85/R86 N1):
 * - The probe cache key derives from `session.id` (NOT the user id): the
 *   grant generation is HMAC(sessionId, clientId), so the same user with a
 *   replaced session is a different generation with a different decision.
 * - `gcTime: 0` — no retained data: every mount waits for a fresh probe,
 *   which also covers same-session revocation between mounts.
 * - Navigation fires only when the CURRENT key's probe has freshly
 *   SUCCEEDED and is idle (R87/R88 P2): `status === "success" &&
 *   fetchStatus === "idle"`. `!isFetching` alone was insufficient — the
 *   installed @tanstack/query-core 5.101.4 reducer RETAINS previous `data`
 *   after a failed refetch with `fetchStatus: "idle"`
 *   (build/modern/query.cjs "error" case spreads `...state` and only flips
 *   status/fetchStatus), an offline query starts `fetchStatus: "paused"`
 *   (query.cjs getDefaultState via retryer.cjs `canFetch`, "fetching" only
 *   when online), and `gcTime: 0` eviction is an asynchronous
 *   `timeoutManager.setTimeout` (removable.cjs scheduleGc) so same-client
 *   re-entry can still observe retained data. Retained data therefore only
 *   ever renders UI — it can never navigate or expose actions.
 */

export interface McpReauthBranchProps {
  /** The authenticated session; only `id` participates in the cache key. */
  session: { id: string };
  /** `client_id` from the signed transaction (null only transiently). */
  clientId: string | null;
  /** Deterministic fingerprint of the parsed signed search. */
  fingerprint: string;
  lang: string;
}

export function McpReauthBranch({ session, clientId, fingerprint, lang }: McpReauthBranchProps) {
  const { t } = useTranslation(["auth", "common"]);
  const { signOutForReauth, isSigningOut, signOutFailed } = useMcpReauthSignOut();

  const reauth = useQuery({
    // Keyed to the SESSION identity AND the signed transaction fingerprint:
    // a replaced session (same user) or a different transaction can never
    // reuse another generation's cached "continue"/"reauth" decision. Cheap
    // probe — NO retained data (gcTime 0): every mount waits for a fresh
    // decision, which also covers same-session revocation re-entry. The
    // sign-out hook additionally invalidates the key prefix.
    queryKey: mcpReauthStatusQueryKey(session.id, clientId ?? "", fingerprint),
    enabled: clientId !== null,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    queryFn: async () => {
      if (clientId === null) throw new Error("missing client_id");
      return getMcpReauthStatus({ data: { clientId } });
    },
  });

  // Fresh-decision gate (R87/R88 P2): actionable UI (navigation, the enabled
  // sign-out action) requires a fresh CURRENT-KEY SUCCESS that has settled —
  // `status === "success" && fetchStatus === "idle" && error === null`.
  // Anything else (pending, fetching, offline-paused, or a probe that FAILED
  // while retaining previous data) renders the skeleton or invalid card
  // below and NEVER acts on retained data.
  const decisionFresh =
    reauth.status === "success" && reauth.fetchStatus === "idle" && reauth.error === null;

  // Live generation: continue to the consent page. The hook performs a
  // raw-query document navigation (see use-mcp-page-continue.ts) so the
  // signed transaction survives byte-identically (R83/R84 F1). Gated on
  // `decisionFresh` so only a fresh CURRENT-key success navigates.
  useMcpPageContinue(decisionFresh && reauth.data?.status === "continue", lang);

  if (reauth.status === "error") {
    // The fresh probe failed (query-core retains previous `data` after an
    // error — it must NOT be acted on). The session may have ended between
    // render and probe; neither outcome can be acted on here — send the
    // user to re-run the transaction from the application rather than
    // guessing a continuation.
    return <McpInvalidRequestCard />;
  }

  if (!decisionFresh) {
    // No fresh settled success yet: initial pending, fresh fetch in flight,
    // or offline-paused (fetchStatus "paused" — the probe has not run).
    // Skeleton only: no navigation, no actions.
    return <McpReauthSkeleton />;
  }

  if (reauth.data?.status === "no-session") {
    // A fresh probe says the session is gone — same terminal card.
    return <McpInvalidRequestCard />;
  }

  if (reauth.data?.status !== "reauth") {
    // "continue" already navigates via the effect hook; this render is a
    // transient frame only.
    return <McpReauthSkeleton />;
  }

  return (
    <div className="flex min-w-0 items-center justify-center px-4 py-10">
      <Card className="w-full min-w-0 max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">{t("auth:mcpLogin.reauthTitle")}</CardTitle>
          <CardDescription className="min-w-0 break-words">
            {t("auth:mcpLogin.reauthDescription", { client: clientId ?? "" })}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Button
            className="min-h-[44px] w-full"
            onClick={() => void signOutForReauth()}
            disabled={isSigningOut}
          >
            {isSigningOut ? t("auth:mcpLogin.signingOut") : t("auth:mcpLogin.reauthConfirm")}
          </Button>
          {signOutFailed ? (
            // Localized sign-out failure state (R83/R84 F4): a failed
            // sign-out keeps the session — and this card — in place with a
            // visible explanation instead of silently re-enabling the button.
            <p className="min-w-0 break-words text-center text-sm text-destructive">
              {t("auth:mcpLogin.signOutFailed")}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function McpReauthSkeleton() {
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
