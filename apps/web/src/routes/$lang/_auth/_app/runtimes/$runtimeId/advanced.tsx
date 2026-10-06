import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import type { RegistryEntry } from "@ws-model-proxy/config/pool-defaults";
import { RUNTIME_ADVANCED, RUNTIME_LIMIT_COLUMNS } from "@ws-model-proxy/config/runtime-defaults";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { type EffectiveView, RegistryOverrideRow } from "@/components/registry-override-row";
import { refusalText } from "@/lib/refusal-text";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/runtimes/$runtimeId/advanced")({
  component: RuntimeAdvancedPage,
});

type RuntimeDetail = Awaited<ReturnType<AppRouterClient["runtimes"]["get"]>>;
type Group = "limits" | "advanced";

const SECTIONS: ReadonlyArray<{ group: Group; entries: Record<string, RegistryEntry> }> = [
  { group: "limits", entries: RUNTIME_LIMIT_COLUMNS },
  { group: "advanced", entries: RUNTIME_ADVANCED },
];

function RuntimeAdvancedPage() {
  const { t } = useTranslation(["dashboard", "common"]);
  const { runtimeId } = Route.useParams();
  const runtime = useQuery(orpc.runtimes.get.queryOptions({ input: { runtimeId } }));
  if (runtime.isPending) return <Skeleton className="h-96 w-full rounded-xl" aria-hidden="true" />;
  if (runtime.isError)
    return (
      <InlineRetry message={t("dashboard:runtime.loadFailed")} onRetry={() => runtime.refetch()} />
    );
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t("dashboard:runtime.advanced.intro")}</p>
      {SECTIONS.map((section) => (
        <Card key={section.group}>
          <CardHeader>
            <CardTitle className="text-base">
              {t(`dashboard:runtime.advanced.sections.${section.group}`)}
            </CardTitle>
            <CardDescription>
              {t(`dashboard:runtime.advanced.sectionHints.${section.group}`)}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex min-w-0 flex-col divide-y">
            {Object.entries(section.entries).map(([key, entry]) => (
              <RuntimeRow
                key={`${runtime.data.currentVersion.id}-${key}`}
                runtime={runtime.data}
                group={section.group}
                name={key}
                entry={entry}
              />
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function RuntimeRow({
  runtime,
  group,
  name,
  entry,
}: {
  runtime: RuntimeDetail;
  group: Group;
  name: string;
  entry: RegistryEntry;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const queryClient = useQueryClient();
  const update = useMutation({
    ...orpc.runtimes.update.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const views = runtime.current[group] as unknown as Record<string, EffectiveView>;
  return (
    <RegistryOverrideRow
      id={`runtime-${group}-${name}`}
      label={t(`dashboard:runtime.advanced.keys.${name}`)}
      entry={entry}
      view={views[name]}
      pending={update.isPending}
      onSave={async (value) => {
        try {
          const result = await update.mutateAsync({
            runtimeId: runtime.id,
            [group]: { [name]: value },
          });
          await queryClient.invalidateQueries({ queryKey: orpc.runtimes.key() });
          toast.success(
            t("dashboard:runtime.savedVersion", {
              version: result.version.version,
              live: result.adoptedLive.length,
              restart: result.needsRestart.length,
            }),
          );
          return true;
        } catch (error) {
          toast.error(refusalText(error));
          return false;
        }
      }}
    />
  );
}
