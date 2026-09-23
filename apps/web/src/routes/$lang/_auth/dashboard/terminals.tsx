import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/$lang/_auth/dashboard/terminals")({
  component: TerminalsRoute,
});

/**
 * The dashboard frame renders the terminal workspace itself, so open terminals
 * survive navigating to other dashboard pages. This route only selects it.
 */
function TerminalsRoute() {
  return null;
}
