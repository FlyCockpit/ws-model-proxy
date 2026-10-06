import { createFileRoute } from "@tanstack/react-router";

import { PageStub } from "@/components/page-stub";

export const Route = createFileRoute("/$lang/_auth/_app/nodes/")({
  component: NodesPage,
});

function NodesPage() {
  return <PageStub page="nodes" />;
}
