import { createFileRoute } from "@tanstack/react-router";

import { PageStub } from "@/components/page-stub";

export const Route = createFileRoute("/$lang/_auth/_app/pools/$poolId/cloud")({
  component: PoolCloudPage,
});

function PoolCloudPage() {
  return <PageStub page="poolCloud" />;
}
