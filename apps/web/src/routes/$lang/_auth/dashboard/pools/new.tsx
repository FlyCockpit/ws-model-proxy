import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useTranslation } from "react-i18next";
import {
  allDirectModels,
  resolveCapacityAvailability,
} from "@/components/forwarder-dashboard-sections";
import { GuardedPoolSetupWizard } from "@/components/guarded-pool-setup-wizard";
import { InlineRetry } from "@/components/inline-retry";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/dashboard/pools/new")({
  component: NewPoolPage,
});

function NewPoolPage() {
  const { lang } = Route.useParams();
  const { t } = useTranslation("dashboard");
  const navigate = useNavigate();
  const devices = useQuery(orpc.forwarderManagement.listCliDevices.queryOptions());
  const appConfig = useQuery(orpc.appConfig.queryOptions());
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
      open
      page
      onOpenChange={() => undefined}
      directModels={allDirectModels(devices.data ?? [])}
      capacityEnabled={capacityAvailability === "enabled"}
      protocolAdaptationAvailable={appConfig.data?.protocolAdaptationAvailable ?? false}
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
