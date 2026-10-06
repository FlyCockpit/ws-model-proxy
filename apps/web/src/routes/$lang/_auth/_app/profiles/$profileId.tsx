import { createFileRoute } from "@tanstack/react-router";

import { PageStub } from "@/components/page-stub";

export const Route = createFileRoute("/$lang/_auth/_app/profiles/$profileId")({
  component: ProfileEditorPage,
});

function ProfileEditorPage() {
  return <PageStub page="profileEditor" />;
}
