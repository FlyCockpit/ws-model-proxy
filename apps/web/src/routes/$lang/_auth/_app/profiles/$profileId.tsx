import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { StatusPill } from "@/components/nodes/node-badges";
import { ProfileEditor } from "@/components/profiles/profile-editor";
import { isNotFound } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/profiles/$profileId")({
  component: ProfileEditorPage,
});

function ProfileEditorPage() {
  const { lang, profileId } = Route.useParams();
  const { t } = useTranslation(["dashboard"]);
  const profile = useQuery(orpc.profiles.get.queryOptions({ input: { profileId } }));
  const nodes = useQuery(orpc.nodes.list.queryOptions());

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Link
        to="/$lang/profiles"
        params={{ lang }}
        className="inline-flex min-h-[44px] w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        {t("dashboard:profiles.editor.back")}
      </Link>
      {profile.isPending || nodes.isPending ? (
        <div aria-hidden="true" className="space-y-4">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : profile.isError || nodes.isError ? (
        <InlineRetry
          message={
            isNotFound(profile.error)
              ? t("dashboard:profiles.editor.notFound")
              : t("dashboard:profiles.loadFailed")
          }
          onRetry={() => {
            profile.refetch();
            nodes.refetch();
          }}
        />
      ) : (
        <>
          <div className="min-w-0 space-y-1">
            <h1 className="text-2xl font-semibold">{profile.data.name}</h1>
            <div className="flex flex-wrap gap-1.5">
              {profile.data.satisfied ? (
                <StatusPill tone="success">{t("dashboard:profiles.satisfied")}</StatusPill>
              ) : (
                <StatusPill tone="muted">{t("dashboard:profiles.notSatisfied")}</StatusPill>
              )}
            </div>
          </div>
          {/* Keyed by the saved version so the form starts from what the server has. */}
          <ProfileEditor
            key={`${profile.data.id}-${profile.data.updatedAt}`}
            profile={profile.data}
            nodes={nodes.data.nodes}
            lang={lang}
          />
        </>
      )}
    </div>
  );
}
