import { createFileRoute } from "@tanstack/react-router";

import { PageStub } from "@/components/page-stub";

export const Route = createFileRoute("/$lang/_auth/_app/pools/$poolId/advanced")({
  component: PoolAdvancedPage,
});

function PoolAdvancedPage() {
  return <PageStub page="poolAdvanced" />;
}
