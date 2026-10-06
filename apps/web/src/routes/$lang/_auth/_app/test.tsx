import { createFileRoute } from "@tanstack/react-router";

import { PageStub } from "@/components/page-stub";

export const Route = createFileRoute("/$lang/_auth/_app/test")({
  component: TestPage,
});

function TestPage() {
  return <PageStub page="test" />;
}
