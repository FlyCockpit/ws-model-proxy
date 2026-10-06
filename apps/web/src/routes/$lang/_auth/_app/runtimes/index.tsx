import { createFileRoute } from "@tanstack/react-router";

import { PageStub } from "@/components/page-stub";

export const Route = createFileRoute("/$lang/_auth/_app/runtimes/")({
  component: RuntimesPage,
});

function RuntimesPage() {
  return <PageStub page="runtimes" />;
}
