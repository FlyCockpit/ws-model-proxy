import { createFileRoute } from "@tanstack/react-router";

import { PageStub } from "@/components/page-stub";

export const Route = createFileRoute("/$lang/_auth/_app/nodes/$nodeId")({
  component: NodeDetailPage,
});

function NodeDetailPage() {
  return <PageStub page="nodeDetail" />;
}
