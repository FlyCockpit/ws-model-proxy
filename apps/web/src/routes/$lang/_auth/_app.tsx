import { createFileRoute } from "@tanstack/react-router";

import { AppFrame } from "@/components/app-frame";

export const Route = createFileRoute("/$lang/_auth/_app")({
  component: AppLayout,
});

function AppLayout() {
  const { lang } = Route.useParams();
  return <AppFrame lang={lang} />;
}
