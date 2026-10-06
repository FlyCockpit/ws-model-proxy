import { createFileRoute } from "@tanstack/react-router";

import { PageStub } from "@/components/page-stub";

export const Route = createFileRoute("/$lang/_auth/_app/runtimes/$runtimeId/advanced")({
  component: RuntimeAdvancedPage,
});

function RuntimeAdvancedPage() {
  return <PageStub page="runtimeAdvanced" />;
}
