import { createFileRoute } from "@tanstack/react-router";
import { PoolExternalEquivalentSection } from "@/components/pool-external-equivalent";
import { PoolDetailTab } from "@/components/pool-route-pages";
export const Route = createFileRoute("/$lang/_auth/dashboard/pools/$poolId/fallback")({
  component: PoolFallbackRoute,
});

function PoolFallbackRoute() {
  const { poolId } = Route.useParams();
  return (
    <div className="min-w-0 space-y-6">
      <PoolDetailTab tab="fallback" />
      <PoolExternalEquivalentSection poolId={poolId} />
    </div>
  );
}
