import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useTranslation } from "react-i18next";
import {
  allDirectModels,
  resolveCapacityAvailability,
} from "@/components/forwarder-dashboard-sections";
import { GuardedPoolSetupWizard } from "@/components/guarded-pool-setup-wizard";
import { InlineRetry } from "@/components/inline-retry";
import { useDeploymentAudience } from "@/hooks/use-deployment-audience";
import { anthropicMessagesEnabledFromConfig } from "@/lib/deployment-feature-gate";
import { providerEgressFromAppConfig } from "@/lib/guarded-pool-wizard-validation";
import { orpc } from "@/utils/orpc";

/**
 * Page body for /pools/new. Lives outside the route file (which the TanStack
 * router plugin split-wraps) so the gate-flip remount behavior is testable;
 * the route file is a thin registration wrapper.
 *
 * The egress gate fails closed while appConfig is pending or errored: an
 * absent or loading snapshot yields no gate, and React Query RETAINS the last
 * successful data after setting status "error" on a failed refetch, so the
 * stale snapshot alone must not keep the gate open. Error-settled renders
 * treat the gate as disabled until a refetch succeeds.
 */
export function NewPoolPage() {
  const { lang } = useParams({ from: "/$lang/_auth/dashboard/pools/new" });
  const { t } = useTranslation("dashboard");
  const navigate = useNavigate();
  const { isAdmin: isDeploymentAdmin } = useDeploymentAudience();
  const devices = useQuery(orpc.forwarderManagement.listCliDevices.queryOptions());
  // This page is one of ~10 appConfig consumers sharing a long staleTime, so a
  // warm cache would usually pin the wizard's egress gate to a stale snapshot.
  // This observer always refetches on mount; the shared defaults are untouched.
  const appConfig = useQuery({
    ...orpc.appConfig.queryOptions(),
    refetchOnMount: "always",
  });
  // Fail-closed: an absent, loading, or ERRORED appConfig behaves like egress
  // disabled. A failed refetch retains its stale snapshot (e.g. a stale
  // providerEgressEnabled:true), so the snapshot alone must not hold the gate
  // open for the rest of the session. A warm-cache refetch still in flight
  // keeps serving the snapshot (accepted RTT residual; submits in that window
  // are rejected server-side with PROVIDER_EGRESS_DISABLED).
  const providerEgressEnabled = providerEgressFromAppConfig(appConfig.data) && !appConfig.isError;
  const anthropicMessagesEnabled = anthropicMessagesEnabledFromConfig(
    appConfig.data,
    appConfig.isError,
  );
  const capacityAvailability = resolveCapacityAvailability(
    appConfig.data?.capacityEnabled,
    appConfig.isError,
  );

  if (devices.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (devices.isError)
    return <InlineRetry message={t("pools.loadFailed")} onRetry={() => void devices.refetch()} />;

  return (
    <GuardedPoolSetupWizard
      // Remount on a SETTLED gate flip so form state re-initializes with the
      // filtered defaults; without this, a true→false flip leaves checked but
      // disabled provider checkboxes the user cannot clear (stuck on Next).
      // Accepted trade-off: a pending→settled transition after first paint also
      // remounts once, discarding input entered during that single refetch RTT.
      // Residual window: a submit during the background refetch RTT with a
      // stale-true snapshot is rejected server-side with
      // PROVIDER_EGRESS_DISABLED and surfaced via the inline create-failure copy.
      key={appConfig.isPending ? "pending" : String(providerEgressEnabled)}
      open
      page
      onOpenChange={() => undefined}
      directModels={allDirectModels(devices.data ?? [])}
      capacityEnabled={capacityAvailability === "enabled"}
      protocolAdaptationAvailable={appConfig.data?.protocolAdaptationAvailable ?? false}
      providerEgressEnabled={providerEgressEnabled}
      anthropicMessagesEnabled={anthropicMessagesEnabled}
      isDeploymentAdmin={isDeploymentAdmin}
      onSuccess={(poolId) => {
        if (poolId) {
          void navigate({
            to: "/$lang/dashboard/pools/$poolId",
            params: { lang, poolId },
          });
          return;
        }
        void navigate({ to: "/$lang/dashboard/pools", params: { lang } });
      }}
    />
  );
}
