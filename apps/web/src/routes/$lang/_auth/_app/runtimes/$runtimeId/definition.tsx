import { createFileRoute } from "@tanstack/react-router";

import { PageStub } from "@/components/page-stub";

export const Route = createFileRoute("/$lang/_auth/_app/runtimes/$runtimeId/definition")({
  component: RuntimeDefinitionPage,
});

function RuntimeDefinitionPage() {
  return <PageStub page="runtimeDefinition" />;
}
