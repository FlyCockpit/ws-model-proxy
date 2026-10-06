import { createFileRoute } from "@tanstack/react-router";

import { PageStub } from "@/components/page-stub";

export const Route = createFileRoute("/$lang/_auth/_app/access/contributions")({
  component: AccessContributionsPage,
});

function AccessContributionsPage() {
  return <PageStub page="accessContributions" />;
}
