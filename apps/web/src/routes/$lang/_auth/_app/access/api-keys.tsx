import { createFileRoute } from "@tanstack/react-router";

import { PageStub } from "@/components/page-stub";

export const Route = createFileRoute("/$lang/_auth/_app/access/api-keys")({
  component: AccessApiKeysPage,
});

function AccessApiKeysPage() {
  return <PageStub page="accessApiKeys" />;
}
