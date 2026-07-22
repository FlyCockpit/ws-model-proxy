import { createFileRoute, redirect } from "@tanstack/react-router";
import { getRouteSession } from "@/server/auth-session";

export const Route = createFileRoute("/$lang/")({
  beforeLoad: async ({ params }) => {
    const resolution = await getRouteSession();
    if (resolution.status === "error") throw new Error("Route session unavailable");
    throw redirect({
      to: resolution.session ? "/$lang/dashboard" : "/$lang/login",
      params: { lang: params.lang },
    });
  },
});
