import { createFileRoute, redirect } from "@tanstack/react-router";
import { getRouteSession } from "@/server/auth-session";

export const Route = createFileRoute("/$lang/")({
  beforeLoad: async ({ params }) => {
    const session = await getRouteSession();
    throw redirect({
      to: session ? "/$lang/dashboard" : "/$lang/login",
      params: { lang: params.lang },
    });
  },
});
