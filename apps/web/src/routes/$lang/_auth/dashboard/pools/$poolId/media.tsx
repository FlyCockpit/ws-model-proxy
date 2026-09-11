import { createFileRoute } from "@tanstack/react-router";
import { PoolDetailTab } from "@/components/pool-route-pages";
export const Route = createFileRoute("/$lang/_auth/dashboard/pools/$poolId/media")({
  component: () => <PoolDetailTab tab="media" />,
});
