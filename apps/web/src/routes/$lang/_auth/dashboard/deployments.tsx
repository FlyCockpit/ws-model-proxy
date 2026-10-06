import { createFileRoute } from "@tanstack/react-router";
import { DeploymentsPage } from "@/components/deployments-page";
export const Route = createFileRoute("/$lang/_auth/dashboard/deployments")({
  component: DeploymentsPage,
});
