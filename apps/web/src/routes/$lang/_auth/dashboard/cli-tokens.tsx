import { createFileRoute } from "@tanstack/react-router";

import { CliTokensSection } from "@/components/forwarder-dashboard-sections";

export const Route = createFileRoute("/$lang/_auth/dashboard/cli-tokens")({
  component: CliTokensPage,
});

function CliTokensPage() {
  return <CliTokensSection />;
}
