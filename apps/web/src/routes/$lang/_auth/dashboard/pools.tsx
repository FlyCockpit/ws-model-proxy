import { createFileRoute } from "@tanstack/react-router";

import { PoolsSection } from "@/components/forwarder-dashboard-sections";

export const Route = createFileRoute("/$lang/_auth/dashboard/pools")({
  component: PoolsPage,
});

function PoolsPage() {
  return <PoolsSection />;
}
