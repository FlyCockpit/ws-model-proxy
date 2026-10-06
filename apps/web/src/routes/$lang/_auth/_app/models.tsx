import { createFileRoute } from "@tanstack/react-router";

import { PageStub } from "@/components/page-stub";

export const Route = createFileRoute("/$lang/_auth/_app/models")({
  component: ModelsPage,
});

function ModelsPage() {
  return <PageStub page="models" />;
}
