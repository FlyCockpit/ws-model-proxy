import { createFileRoute } from "@tanstack/react-router";

import { PageStub } from "@/components/page-stub";

export const Route = createFileRoute("/$lang/_auth/_app/runtimes/$runtimeId/")({
  component: RuntimeOverviewPage,
});

function RuntimeOverviewPage() {
  return <PageStub page="runtimeOverview" />;
}
