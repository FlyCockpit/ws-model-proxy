import { createFileRoute, redirect } from "@tanstack/react-router";
import { resolveRouteSession } from "@/lib/route-session";

export const Route = createFileRoute("/$lang/")({
  beforeLoad: async ({ params }) => {
    const resolution = await resolveRouteSession();
    if (resolution.status === "error") throw new Error("Route session unavailable");
    throw redirect({
      to: resolution.session ? "/$lang/overview" : "/$lang/login",
      params: { lang: params.lang },
    });
  },
});
