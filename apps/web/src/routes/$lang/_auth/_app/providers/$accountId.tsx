import { createFileRoute } from "@tanstack/react-router";

import { PageStub } from "@/components/page-stub";

export const Route = createFileRoute("/$lang/_auth/_app/providers/$accountId")({
  component: ProviderDetailPage,
});

function ProviderDetailPage() {
  return <PageStub page="providerDetail" />;
}
