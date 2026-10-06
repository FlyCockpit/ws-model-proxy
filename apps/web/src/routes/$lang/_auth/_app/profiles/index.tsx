import { createFileRoute } from "@tanstack/react-router";

import { PageStub } from "@/components/page-stub";

export const Route = createFileRoute("/$lang/_auth/_app/profiles/")({
  component: ProfilesPage,
});

function ProfilesPage() {
  return <PageStub page="profiles" />;
}
