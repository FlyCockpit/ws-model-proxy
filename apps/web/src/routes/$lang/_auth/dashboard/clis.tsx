import { createFileRoute } from "@tanstack/react-router";

import { CliEndpointsModelsSection } from "@/components/forwarder-dashboard-sections";

export const Route = createFileRoute("/$lang/_auth/dashboard/clis")({
  component: CliEndpointsModelsPage,
});

function CliEndpointsModelsPage() {
  const { lang } = Route.useParams();
  return <CliEndpointsModelsSection lang={lang} />;
}
