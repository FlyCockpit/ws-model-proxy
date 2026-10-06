import { createFileRoute } from "@tanstack/react-router";

import { PageStub } from "@/components/page-stub";

export const Route = createFileRoute("/$lang/_auth/_app/terminals")({
  component: TerminalsPage,
});

function TerminalsPage() {
  return <PageStub page="terminals" />;
}
