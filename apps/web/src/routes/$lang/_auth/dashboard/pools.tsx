import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/$lang/_auth/dashboard/pools")({
  component: PoolsLayout,
});

function PoolsLayout() {
  return <Outlet />;
}
