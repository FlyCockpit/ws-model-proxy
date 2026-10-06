import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { Label } from "@ws-model-proxy/ui/components/label";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Switch } from "@ws-model-proxy/ui/components/switch";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { NativeSelect } from "@/components/native-select";
import { StatusPill } from "@/components/status-pill";
import type { PoolView } from "@/lib/pool-ui";
import { refusalText } from "@/lib/refusal-text";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/pools/$poolId/cloud")({
  component: PoolCloudPage,
});

const MODES = ["OFF", "OWNER", "OWNER_AND_SHARES"] as const;

function PoolCloudPage() {
  const { t } = useTranslation(["dashboard", "common"]);
  const { poolId } = Route.useParams();
  const pool = useQuery(orpc.pools.get.queryOptions({ input: { poolId } }));
  if (pool.isPending) return <Skeleton className="h-64 w-full rounded-xl" aria-hidden="true" />;
  if (pool.isError)
    return <InlineRetry message={t("dashboard:pool.loadFailed")} onRetry={() => pool.refetch()} />;
  return <CloudSettings pool={pool.data} />;
}

function CloudSettings({ pool }: { pool: PoolView }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const { lang } = Route.useParams();
  const queryClient = useQueryClient();
  const setMode = useMutation({
    ...orpc.pools.cloud.setMode.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const setWarm = useMutation({
    ...orpc.pools.cloud.setPaidWarmProtection.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const run = async (work: () => Promise<unknown>): Promise<boolean> => {
    try {
      await work();
      await queryClient.invalidateQueries({ queryKey: orpc.pools.key() });
      await queryClient.invalidateQueries({ queryKey: orpc.models.key() });
      toast.success(t("dashboard:pool.saved"));
      return true;
    } catch (error) {
      toast.error(refusalText(error));
      return false;
    }
  };
  const cloudMembers = pool.members.filter((member) => member.kind === "CLOUD");
  const providerModels = useQuery(orpc.providers.models.list.queryOptions({ input: {} }));
  const [choice, setChoice] = useState("");
  const updatePool = useMutation({
    ...orpc.pools.update.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const inUse = new Set(cloudMembers.map((member) => member.providerModelId));
  const candidates = (providerModels.data?.models ?? []).filter(
    (model) => model.enabled && model.type === pool.modelType && !inUse.has(model.id),
  );
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("dashboard:pool.cloud.title")}</CardTitle>
          <CardDescription>{t("dashboard:pool.cloud.hint")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="cloud-mode">{t("dashboard:pool.cloud.mode")}</Label>
            <NativeSelect
              id="cloud-mode"
              value={pool.cloud.mode}
              disabled={setMode.isPending}
              onChange={(event) =>
                run(() =>
                  setMode.mutateAsync({
                    poolId: pool.id,
                    mode: event.target.value as (typeof MODES)[number],
                  }),
                )
              }
            >
              {MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {t(`dashboard:pool.cloud.modes.${mode}`)}
                </option>
              ))}
            </NativeSelect>
            <p className="text-xs text-muted-foreground">{t("dashboard:pool.cloud.humanOnly")}</p>
          </div>
          <div className="flex min-h-11 items-center gap-3">
            <Switch
              id="cloud-warm"
              checked={pool.cloud.paidWarmProtection}
              disabled={setWarm.isPending}
              onCheckedChange={(checked) =>
                run(() => setWarm.mutateAsync({ poolId: pool.id, enabled: checked === true }))
              }
            />
            <Label htmlFor="cloud-warm">{t("dashboard:pool.cloud.paidWarm")}</Label>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("dashboard:pool.cloud.members")}</CardTitle>
          <CardDescription>
            {t("dashboard:pool.cloud.membersHint")}{" "}
            <Link to="/$lang/providers" params={{ lang }} className="underline underline-offset-4">
              {t("dashboard:providers.title")}
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {cloudMembers.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("dashboard:pool.cloud.noMembers")}</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {cloudMembers.map((member) => (
                <li key={member.id} className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="font-mono text-sm">{(member.cloudOrder ?? 0) + 1}.</span>
                  <span className="break-all font-mono text-sm">{member.upstreamModelId}</span>
                  <StatusPill tone="info">
                    {t(`dashboard:pool.memberStatus.${member.status}`)}
                  </StatusPill>
                  <Button
                    variant="ghost"
                    size="icon-touch"
                    aria-label={t("dashboard:pool.removeMember", {
                      member: member.upstreamModelId,
                    })}
                    disabled={updatePool.isPending}
                    onClick={() =>
                      run(() =>
                        updatePool.mutateAsync({
                          poolId: pool.id,
                          cloudMembers: cloudMembers
                            .filter((other) => other.id !== member.id)
                            .flatMap((other) =>
                              other.providerModelId
                                ? [{ providerModelId: other.providerModelId }]
                                : [],
                            ),
                        }),
                      )
                    }
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ol>
          )}
          <form
            className="mt-4 flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              if (!choice) return;
              run(() =>
                updatePool.mutateAsync({
                  poolId: pool.id,
                  cloudMembers: [
                    ...cloudMembers.flatMap((member) =>
                      member.providerModelId ? [{ providerModelId: member.providerModelId }] : [],
                    ),
                    { providerModelId: choice },
                  ],
                }),
              ).then((ok) => {
                if (ok) setChoice("");
              });
            }}
          >
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor="cloud-add">{t("dashboard:pool.cloud.add")}</Label>
              {providerModels.isPending ? (
                <Skeleton className="h-11 w-full" />
              ) : providerModels.isError ? (
                <InlineRetry onRetry={() => providerModels.refetch()} />
              ) : (
                <NativeSelect
                  id="cloud-add"
                  value={choice}
                  onChange={(event) => setChoice(event.target.value)}
                >
                  <option value="">{t("dashboard:pool.cloud.pickModel")}</option>
                  {candidates.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.displayName ?? model.upstreamModelId}
                    </option>
                  ))}
                </NativeSelect>
              )}
              {providerModels.isSuccess && candidates.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("dashboard:pool.cloud.noCandidates")}
                </p>
              ) : null}
            </div>
            <Button
              type="submit"
              size="touch"
              disabled={!choice || updatePool.isPending || cloudMembers.length >= 16}
            >
              {t("dashboard:pool.add")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
