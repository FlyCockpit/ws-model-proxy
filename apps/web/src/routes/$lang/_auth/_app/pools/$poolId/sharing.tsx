import { createFileRoute } from "@tanstack/react-router";

import { PageStub } from "@/components/page-stub";

export const Route = createFileRoute("/$lang/_auth/_app/pools/$poolId/sharing")({
  component: PoolSharingPage,
});

function PoolSharingPage() {
  return <PageStub page="poolSharing" />;
}
