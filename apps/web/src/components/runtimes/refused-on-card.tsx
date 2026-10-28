import { Link } from "@tanstack/react-router";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { CircleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { StatusPill } from "@/components/status-pill";
import { defineRejectReasonText } from "@/lib/define-rejections";

type RuntimeDetail = Awaited<ReturnType<AppRouterClient["runtimes"]["get"]>>;

/**
 * Nodes that refused a version of this runtime in their last define answer. They never apply it
 * later on their own: the definition must change, or wsmp on the node must be upgraded.
 */
export function RefusedOnCard({
  lang,
  runtime,
}: {
  lang: string;
  runtime: Pick<RuntimeDetail, "id" | "currentVersion" | "refusedOn">;
}) {
  const { t } = useTranslation(["dashboard"]);
  if (runtime.refusedOn.length === 0) return null;
  return (
    <Card className="min-w-0 border-destructive/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-destructive" />
          {t("dashboard:runtime.refusedOn.title", { count: runtime.refusedOn.length })}
        </CardTitle>
        <CardDescription>
          {t("dashboard:runtime.refusedOn.hint")}{" "}
          <Link
            to="/$lang/runtimes/$runtimeId/definition"
            params={{ lang, runtimeId: runtime.id }}
            className="underline"
          >
            {t("dashboard:runtime.refusedOn.editDefinition")}
          </Link>
        </CardDescription>
      </CardHeader>
      <CardContent className="min-w-0">
        <ul className="min-w-0 divide-y">
          {runtime.refusedOn.map((entry) => (
            <li
              key={`${entry.nodeId}:${entry.versionId}`}
              className="flex min-w-0 flex-col gap-1 py-2 text-sm"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Link
                  to="/$lang/nodes/$nodeId"
                  params={{ lang, nodeId: entry.nodeId }}
                  className="inline-flex min-h-[44px] min-w-0 items-center font-mono break-all underline"
                >
                  {entry.nodeSlug}
                </Link>
                <StatusPill tone="bad">{t("dashboard:runtime.refusedOn.refused")}</StatusPill>
                <StatusPill tone="muted">
                  {entry.versionId === runtime.currentVersion.id
                    ? t("dashboard:runtime.refusedOn.currentVersion")
                    : t("dashboard:runtime.refusedOn.olderVersion")}
                </StatusPill>
              </div>
              <p>{defineRejectReasonText(t, entry.reason)}</p>
              {entry.detail ? (
                <p className="min-w-0 text-muted-foreground">
                  {t("dashboard:runtime.refusedOn.at")}{" "}
                  <code className="font-mono text-xs break-all">{entry.detail}</code>
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
