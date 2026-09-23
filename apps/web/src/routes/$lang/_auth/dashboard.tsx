import { createFileRoute } from "@tanstack/react-router";

import { DashboardFrame } from "@/components/dashboard-frame";

export const Route = createFileRoute("/$lang/_auth/dashboard")({
  component: DashboardLayout,
});

function DashboardLayout() {
  const { lang } = Route.useParams();
  return <DashboardFrame lang={lang} />;
}
