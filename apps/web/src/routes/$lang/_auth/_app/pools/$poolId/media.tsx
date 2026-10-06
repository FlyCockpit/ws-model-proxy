import { createFileRoute } from "@tanstack/react-router";

import { PageStub } from "@/components/page-stub";

export const Route = createFileRoute("/$lang/_auth/_app/pools/$poolId/media")({
  component: PoolMediaPage,
});

function PoolMediaPage() {
  return <PageStub page="poolMedia" />;
}
