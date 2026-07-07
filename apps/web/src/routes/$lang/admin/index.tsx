import { createFileRoute, Link } from "@tanstack/react-router";
import { buttonVariants } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { Activity, Database, Settings, Smartphone, Users } from "lucide-react";
import { useTranslation } from "react-i18next";

export const Route = createFileRoute("/$lang/admin/")({
  component: AdminOverview,
});

const ADMIN_LINKS = [
  {
    to: "/$lang/admin/users",
    labelKey: "admin:nav.users",
    descriptionKey: "admin:users.description",
    icon: Users,
  },
  {
    to: "/$lang/admin/devices",
    labelKey: "admin:nav.devices",
    descriptionKey: "admin:devices.description",
    icon: Smartphone,
  },
  {
    to: "/$lang/admin/observability",
    labelKey: "admin:nav.observability",
    descriptionKey: "admin:observability.description",
    icon: Activity,
  },
  {
    to: "/$lang/admin/settings",
    labelKey: "admin:nav.settings",
    descriptionKey: "admin:settings.description",
    icon: Settings,
  },
  {
    to: "/$lang/admin/seed",
    labelKey: "admin:nav.seed",
    descriptionKey: "admin:seedPage.emptyStubNote",
    icon: Database,
  },
] as const;

function AdminOverview() {
  const { lang } = Route.useParams();
  const { t } = useTranslation(["admin", "common"]);

  return (
    <div className="container mx-auto max-w-7xl px-4 py-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("admin:overview.title")}</h1>
        <p className="text-sm text-muted-foreground">{t("admin:overview.description")}</p>
      </header>

      <section className="mt-8 grid grid-cols-12 gap-4">
        {ADMIN_LINKS.map((item) => (
          <Card key={item.to} className="col-span-12 sm:col-span-6 lg:col-span-4">
            <CardHeader className="space-y-2">
              <div className="flex items-center gap-2">
                <item.icon aria-hidden className="size-4 text-muted-foreground" />
                <CardTitle className="text-base">{t(item.labelKey)}</CardTitle>
              </div>
              <CardDescription>{t(item.descriptionKey)}</CardDescription>
            </CardHeader>
            <CardContent>
              <Link
                to={item.to}
                params={{ lang }}
                className={cn(buttonVariants({ variant: "outline", size: "sm" }), "min-h-[44px]")}
              >
                {t("common:actions.manage")}
              </Link>
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}
