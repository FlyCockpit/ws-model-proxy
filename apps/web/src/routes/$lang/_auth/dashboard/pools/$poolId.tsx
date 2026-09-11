import { createFileRoute } from "@tanstack/react-router";

import { PoolDetailPage } from "@/components/pool-route-pages";

export const Route = createFileRoute("/$lang/_auth/dashboard/pools/$poolId")({
  component: PoolDetailRoute,
});

function PoolDetailRoute() {
  const { lang, poolId } = Route.useParams();
  return <PoolDetailPage lang={lang} poolId={poolId} />;
}
