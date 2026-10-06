import { createFileRoute } from "@tanstack/react-router";

import { InferenceCapacityPage } from "@/components/pool-route-pages";

export const Route = createFileRoute("/$lang/_auth/dashboard/runtimes")({
  component: InferenceCapacityPage,
});
