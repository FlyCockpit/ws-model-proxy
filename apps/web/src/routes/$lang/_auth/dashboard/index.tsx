import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { env } from "@ws-model-proxy/env/web";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import PullToRefresh from "@/components/pull-to-refresh";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/dashboard/")({
  component: DashboardPage,
});

function DashboardPage() {
  const { session } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const {
    isPending: appSettingsIsPending,
    isError: appSettingsIsError,
    refetch: refetchAppSettings,
  } = useQuery(orpc.settings.getAll.queryOptions());
  const { t } = useTranslation(["common", "dashboard"]);
  const appName = env.VITE_APP_NAME;

  const handleRefresh = useCallback(async () => {
    await queryClient.invalidateQueries();
  }, [queryClient]);

  return (
    <PullToRefresh onRefresh={handleRefresh}>
      {appSettingsIsPending ? (
        <DashboardSkeleton />
      ) : appSettingsIsError ? (
        <InlineRetry
          className="py-12"
          message={t("dashboard:loadFailed")}
          onRetry={refetchAppSettings}
        />
      ) : (
        <section className="rounded-md border bg-background p-4">
          <h2 className="text-lg font-semibold">
            {t("common:welcome")} {t("common:appName", { name: appName })}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("dashboard:welcomeBack", { name: session.user.name })}
          </p>
        </section>
      )}
    </PullToRefresh>
  );
}

function DashboardSkeleton() {
  return (
    <div className="rounded-md border p-4">
      <div className="space-y-4">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-5 w-64" />
      </div>
    </div>
  );
}
