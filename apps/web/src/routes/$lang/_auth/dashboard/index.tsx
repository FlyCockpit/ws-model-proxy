import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";

import { OverviewPage } from "@/components/overview/overview-page";
import PullToRefresh from "@/components/pull-to-refresh";

export const Route = createFileRoute("/$lang/_auth/dashboard/")({
  component: DashboardOverviewRoute,
});

function DashboardOverviewRoute() {
  const { lang } = Route.useParams();
  const queryClient = useQueryClient();

  const handleRefresh = useCallback(async () => {
    await queryClient.invalidateQueries();
  }, [queryClient]);

  return (
    <PullToRefresh onRefresh={handleRefresh}>
      <OverviewPage lang={lang} />
    </PullToRefresh>
  );
}
