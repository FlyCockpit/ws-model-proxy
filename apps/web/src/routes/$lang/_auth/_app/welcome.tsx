import { createFileRoute } from "@tanstack/react-router";

import { PageStub } from "@/components/page-stub";

export const Route = createFileRoute("/$lang/_auth/_app/welcome")({
  component: WelcomePage,
});

function WelcomePage() {
  return <PageStub page="welcome" />;
}
