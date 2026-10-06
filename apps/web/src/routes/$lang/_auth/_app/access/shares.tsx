import { createFileRoute } from "@tanstack/react-router";

import { PageStub } from "@/components/page-stub";

export const Route = createFileRoute("/$lang/_auth/_app/access/shares")({
  component: AccessSharesPage,
});

function AccessSharesPage() {
  return <PageStub page="accessShares" />;
}
