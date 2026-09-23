import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { Flag } from "lucide-react";
import { useTranslation } from "react-i18next";

type DeploymentFeatures = Awaited<ReturnType<AppRouterClient["appConfig"]>>["deploymentFeatures"];

function onOff(value: boolean, onLabel: string, offLabel: string): string {
  return value ? onLabel : offLabel;
}

export function DeploymentFeaturesPanel({ features }: { features: DeploymentFeatures }) {
  const { t } = useTranslation("admin");
  const onLabel = t("settings.deploymentFeatures.on");
  const offLabel = t("settings.deploymentFeatures.off");
  const egress = features.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED;
  const rows = [
    {
      name: "WMP_PUBLIC_PROVIDER_EGRESS_ENABLED",
      value: onOff(egress.enabled, onLabel, offLabel),
      description: t("settings.deploymentFeatures.flags.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED"),
    },
    {
      name: "keyringConfigured",
      value: egress.keyringConfigured
        ? t("settings.deploymentFeatures.configured")
        : t("settings.deploymentFeatures.missing"),
      description: t("settings.deploymentFeatures.flags.keyringConfigured"),
    },
    {
      name: "ready",
      value: egress.ready
        ? t("settings.deploymentFeatures.ready")
        : t("settings.deploymentFeatures.notReady"),
      description: t("settings.deploymentFeatures.flags.ready"),
    },
    {
      name: "WMP_MCP_ENABLED",
      value: onOff(features.WMP_MCP_ENABLED, onLabel, offLabel),
      description: t("settings.deploymentFeatures.flags.WMP_MCP_ENABLED"),
    },
    {
      name: "WMP_MCP_PAT_ALLOW_NO_EXPIRY",
      value: onOff(features.WMP_MCP_PAT_ALLOW_NO_EXPIRY, onLabel, offLabel),
      description: t("settings.deploymentFeatures.flags.WMP_MCP_PAT_ALLOW_NO_EXPIRY"),
    },
    {
      name: "WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS",
      value: onOff(features.WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS, onLabel, offLabel),
      description: t("settings.deploymentFeatures.flags.WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS"),
    },
    {
      name: "SIGNUP_ENABLED",
      value: onOff(features.SIGNUP_ENABLED, onLabel, offLabel),
      description: t("settings.deploymentFeatures.flags.SIGNUP_ENABLED"),
    },
  ] as const;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Flag className="size-5" />
          {t("settings.deploymentFeatures.title")}
        </CardTitle>
        <CardDescription>{t("settings.deploymentFeatures.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {rows.map((row) => (
            <li
              key={row.name}
              className="flex min-w-0 flex-col gap-1 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
            >
              <div className="min-w-0">
                <p className="break-all font-mono text-sm">{row.name}</p>
                <p className="text-sm text-muted-foreground">{row.description}</p>
              </div>
              <p className="shrink-0 text-sm font-medium">{row.value}</p>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
