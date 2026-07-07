import { createFileRoute } from "@tanstack/react-router";

import { ModelApiTokensSection } from "@/components/forwarder-dashboard-sections";

export const Route = createFileRoute("/$lang/_auth/dashboard/model-api-tokens")({
  component: ModelApiTokensPage,
});

function ModelApiTokensPage() {
  return <ModelApiTokensSection />;
}
