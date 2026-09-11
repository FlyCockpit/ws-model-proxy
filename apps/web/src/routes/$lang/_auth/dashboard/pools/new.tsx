import { createFileRoute } from "@tanstack/react-router";
import { NewPoolPage } from "@/components/guarded-pool-new-page";

export const Route = createFileRoute("/$lang/_auth/dashboard/pools/new")({
  component: NewPoolPage,
});
