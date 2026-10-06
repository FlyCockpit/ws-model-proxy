import { createFileRoute } from "@tanstack/react-router";

import { RelayMetadataSection } from "@/components/forwarder-dashboard-sections";

export const Route = createFileRoute("/$lang/_auth/dashboard/request-log")({
  component: RelayMetadataPage,
});

function RelayMetadataPage() {
  return <RelayMetadataSection />;
}
