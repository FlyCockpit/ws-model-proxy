import { createFileRoute } from "@tanstack/react-router";

import { PoolsListPage } from "@/components/pool-route-pages";

export const Route = createFileRoute("/$lang/_auth/dashboard/pools/")({
  component: PoolsIndexPage,
});

function PoolsIndexPage() {
  const { lang } = Route.useParams();
  return <PoolsListPage lang={lang} />;
}
