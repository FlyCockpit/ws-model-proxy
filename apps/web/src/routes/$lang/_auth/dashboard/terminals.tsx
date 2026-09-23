import { createFileRoute } from "@tanstack/react-router";

import { TerminalsPage } from "@/components/terminals-page";

export const Route = createFileRoute("/$lang/_auth/dashboard/terminals")({
  component: TerminalsRoute,
});

function TerminalsRoute() {
  return <TerminalsPage />;
}
