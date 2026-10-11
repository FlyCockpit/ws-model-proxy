import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Card, CardContent } from "@ws-model-proxy/ui/components/card";
import { Layers, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { PageHeading } from "@/components/page-stub";
import { NewProfileDialog } from "@/components/profiles/new-profile-dialog";
import { ProfileCard, ProfileCardSkeleton } from "@/components/profiles/profile-card";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/profiles/")({
  component: ProfilesPage,
});

function ProfilesPage() {
  const { lang } = Route.useParams();
  const { t } = useTranslation(["dashboard"]);
  const [creating, setCreating] = useState(false);
  const profiles = useQuery(orpc.profiles.list.queryOptions());
  const nodes = useQuery(orpc.nodes.list.queryOptions());
  const nodeList = nodes.data?.nodes ?? [];
  const nodeById = new Map(nodeList.map((node) => [node.id, node]));

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <PageHeading page="profiles" />
        <Button className="min-h-[44px]" onClick={() => setCreating(true)}>
          <Plus aria-hidden="true" />
          {t("dashboard:profiles.new.button")}
        </Button>
      </div>
      {profiles.isPending ? (
        <div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <ProfileCardSkeleton />
          <ProfileCardSkeleton />
        </div>
      ) : profiles.isError ? (
        <InlineRetry
          message={t("dashboard:profiles.loadFailed")}
          onRetry={() => profiles.refetch()}
        />
      ) : profiles.data.profiles.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-start gap-3 py-6">
            <Layers aria-hidden="true" className="size-6 text-muted-foreground" />
            <div className="space-y-1">
              <p className="font-medium">{t("dashboard:profiles.emptyTitle")}</p>
              <p className="text-sm text-muted-foreground">
                {t("dashboard:profiles.emptyDescription")}
              </p>
            </div>
            <Button className="min-h-[44px]" onClick={() => setCreating(true)}>
              <Plus aria-hidden="true" />
              {t("dashboard:profiles.new.button")}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <ul className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {profiles.data.profiles.map((profile) => (
            <li key={profile.id} className="min-w-0">
              <ProfileCard profile={profile} nodeById={nodeById} lang={lang} />
            </li>
          ))}
        </ul>
      )}
      <NewProfileDialog open={creating} onOpenChange={setCreating} nodes={nodeList} lang={lang} />
    </div>
  );
}
