import { Link } from "@tanstack/react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@ws-model-proxy/ui/components/card";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Server } from "lucide-react";
import { useTranslation } from "react-i18next";

import { TimeAgo } from "@/components/time-ago";

import { ConnectionBadge, formatGb, NodeFlags, TrustBadge } from "./node-badges";
import type { NodeSummary } from "./node-types";

export function NodeCard({ node, lang }: { node: NodeSummary; lang: string }) {
  const { t } = useTranslation(["dashboard"]);
  const free = formatGb(node.liveFreeMemoryGb, lang);
  return (
    <Card className="min-w-0">
      <CardHeader className="gap-2">
        <CardTitle className="flex min-w-0 items-center gap-2 text-base">
          <Server aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <Link
            to="/$lang/nodes/$nodeId"
            params={{ lang, nodeId: node.id }}
            className="inline-flex min-h-[44px] min-w-0 items-center truncate hover:underline"
          >
            {node.name ?? node.slug}
          </Link>
        </CardTitle>
        <div className="flex flex-wrap gap-1.5">
          <ConnectionBadge connection={node.connection} />
          <TrustBadge trust={node.trust} />
          <NodeFlags node={node} />
        </div>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">{t("dashboard:nodes.card.hardware")}</dt>
          <dd>
            {node.hardwareKind
              ? t(`dashboard:nodes.hardwareKind.${node.hardwareKind}`)
              : t("dashboard:nodes.card.unknown")}
          </dd>
          <dt className="text-muted-foreground">{t("dashboard:nodes.card.freeMemory")}</dt>
          <dd>{free ?? t("dashboard:nodes.card.unknown")}</dd>
          <dt className="text-muted-foreground">{t("dashboard:nodes.card.running")}</dt>
          <dd>
            {t("dashboard:nodes.card.runningValue", {
              instances: node.runningInstances,
              alwaysOn: node.alwaysOnRuntimes,
            })}
          </dd>
          <dt className="text-muted-foreground">{t("dashboard:nodes.card.lastSeen")}</dt>
          <dd>
            <TimeAgo value={node.lastHeartbeatAt} />
          </dd>
        </dl>
        {node.needsYou > 0 ? (
          <p className="text-xs font-medium text-state-warning-foreground dark:text-state-warning">
            {t("dashboard:nodes.card.needsYou", { count: node.needsYou })}
          </p>
        ) : null}
        {node.labels.length > 0 ? (
          <ul className="flex flex-wrap gap-1" aria-label={t("dashboard:nodes.card.labels")}>
            {node.labels.map((label) => (
              <li key={label} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                {label}
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function NodeCardSkeleton() {
  return (
    <Card aria-hidden="true">
      <CardHeader className="gap-2">
        <Skeleton className="h-5 w-1/2" />
        <div className="flex gap-1.5">
          <Skeleton className="h-5 w-16" />
          <Skeleton className="h-5 w-20" />
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
      </CardContent>
    </Card>
  );
}
