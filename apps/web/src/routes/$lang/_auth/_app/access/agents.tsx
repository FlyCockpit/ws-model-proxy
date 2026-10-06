import { createFileRoute } from "@tanstack/react-router";

import { PageStub } from "@/components/page-stub";

export const Route = createFileRoute("/$lang/_auth/_app/access/agents")({
  component: AccessAgentsPage,
});

function AccessAgentsPage() {
  return <PageStub page="accessAgents" />;
}
