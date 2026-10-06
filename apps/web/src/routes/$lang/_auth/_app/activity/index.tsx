import { createFileRoute } from "@tanstack/react-router";

import { PageStub } from "@/components/page-stub";

export const Route = createFileRoute("/$lang/_auth/_app/activity/")({
  component: ActivityPage,
});

function ActivityPage() {
  return <PageStub page="activity" />;
}
