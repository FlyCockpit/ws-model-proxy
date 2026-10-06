import { createFileRoute } from "@tanstack/react-router";

import { PageStub } from "@/components/page-stub";

export const Route = createFileRoute("/$lang/_auth/_app/activity/requests")({
  component: ActivityRequestsPage,
});

function ActivityRequestsPage() {
  return <PageStub page="activityRequests" />;
}
