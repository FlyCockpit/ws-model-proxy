import { createFileRoute, redirect } from "@tanstack/react-router";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/$lang/")({
  beforeLoad: async ({ params }) => {
    const session = await authClient.getSession();
    throw redirect({
      to: session.data ? "/$lang/dashboard" : "/$lang/login",
      params: { lang: params.lang },
    });
  },
});
