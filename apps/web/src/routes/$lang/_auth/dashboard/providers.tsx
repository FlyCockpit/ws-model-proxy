import { createFileRoute } from "@tanstack/react-router";
import { ProvidersPage } from "@/components/providers-page";
export const Route = createFileRoute("/$lang/_auth/dashboard/providers")({
  component: ProvidersPage,
});
