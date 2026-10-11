import { Link } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ws-model-proxy/ui/components/card";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Play } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { StatusPill } from "@/components/nodes/node-badges";
import type { NodeSummary, ProfileView } from "@/components/nodes/node-types";
import { TimeAgo } from "@/components/time-ago";

import { ApplyProfileDialog } from "./apply-profile-dialog";

export function ProfileCard({
  profile,
  nodeById,
  lang,
}: {
  profile: ProfileView;
  nodeById: ReadonlyMap<string, NodeSummary>;
  lang: string;
}) {
  const { t } = useTranslation(["dashboard"]);
  const [applying, setApplying] = useState(false);
  const outdated = profile.items.some((item) => item.pinOutdated);
  const holds = new Set(profile.holds.map((hold) => hold.nodeId));
  return (
    <Card className="min-w-0">
      <CardHeader className="gap-2">
        <CardTitle className="min-w-0 text-base">
          <Link
            to="/$lang/profiles/$profileId"
            params={{ lang, profileId: profile.id }}
            className="inline-flex min-h-[44px] items-center truncate hover:underline"
          >
            {profile.name}
          </Link>
        </CardTitle>
        <div className="flex flex-wrap gap-1.5">
          {profile.satisfied ? (
            <StatusPill tone="success">{t("dashboard:profiles.satisfied")}</StatusPill>
          ) : (
            <StatusPill tone="muted">{t("dashboard:profiles.notSatisfied")}</StatusPill>
          )}
          {outdated ? (
            <StatusPill tone="warning">{t("dashboard:profiles.pinsOutdated")}</StatusPill>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div>
          <p className="text-xs text-muted-foreground">{t("dashboard:profiles.nodes")}</p>
          <p className="flex flex-wrap gap-x-2">
            {profile.nodeIds.map((nodeId) => (
              <span key={nodeId}>
                {nodeById.get(nodeId)?.slug ?? nodeId}
                {holds.has(nodeId) ? ` (${t("dashboard:profiles.holdShort")})` : ""}
              </span>
            ))}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{t("dashboard:profiles.items")}</p>
          {profile.items.length === 0 ? (
            <p className="text-muted-foreground">{t("dashboard:profiles.noItems")}</p>
          ) : (
            <ul>
              {profile.items.map((item) => (
                <li key={item.id}>
                  {item.runtimeSlug} v{item.versionNumber} ·{" "}
                  {t("dashboard:profiles.running", { now: item.runningNow, count: item.count })}
                </li>
              ))}
            </ul>
          )}
        </div>
        {profile.lastApply ? (
          <p className="text-xs text-muted-foreground">
            {t("dashboard:profiles.lastApplied")} <TimeAgo value={profile.lastApply.at} />
          </p>
        ) : null}
        <Button className="min-h-[44px]" onClick={() => setApplying(true)}>
          <Play aria-hidden="true" />
          {t("dashboard:profiles.apply.button")}
        </Button>
      </CardContent>
      <ApplyProfileDialog profile={profile} open={applying} onOpenChange={setApplying} />
    </Card>
  );
}

export function ProfileCardSkeleton() {
  return (
    <Card aria-hidden="true">
      <CardHeader className="gap-2">
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-5 w-24" />
      </CardHeader>
      <CardContent className="space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-11 w-24" />
      </CardContent>
    </Card>
  );
}
