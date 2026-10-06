import { createFileRoute } from "@tanstack/react-router";

import { PageStub } from "@/components/page-stub";

export const Route = createFileRoute("/$lang/_auth/_app/overview")({
  component: OverviewPage,
});

function OverviewPage() {
  return <PageStub page="overview" />;
}
