import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/$lang/_auth/_app/access/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/$lang/access/api-keys", params: { lang: params.lang } });
  },
});
