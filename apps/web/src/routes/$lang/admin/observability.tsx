import { createFileRoute } from "@tanstack/react-router";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useTranslation } from "react-i18next";

export const Route = createFileRoute("/$lang/admin/observability")({
  component: AdminObservability,
});

/** Every node, runtime, pool and the request log across accounts (built in W10). */
function AdminObservability() {
  const { t } = useTranslation(["admin", "dashboard"]);
  return (
    <div className="container mx-auto min-w-0 max-w-7xl space-y-6 px-4 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("admin:observability.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("admin:observability.description")}</p>
      </header>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("dashboard:comingSoon.title")}</CardTitle>
          <CardDescription>{t("dashboard:comingSoon.description")}</CardDescription>
        </CardHeader>
        <CardContent aria-hidden="true" className="space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}
