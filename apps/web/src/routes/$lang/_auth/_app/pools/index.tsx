import { createFileRoute } from "@tanstack/react-router";

import { PageStub } from "@/components/page-stub";

export const Route = createFileRoute("/$lang/_auth/_app/pools/")({
  component: PoolsPage,
});

function PoolsPage() {
  return <PageStub page="pools" />;
}
