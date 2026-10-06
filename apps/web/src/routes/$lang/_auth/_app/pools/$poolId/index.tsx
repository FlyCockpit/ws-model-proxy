import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@ws-model-proxy/ui/components/card";
import { Label } from "@ws-model-proxy/ui/components/label";
import { ResponsiveDialog } from "@ws-model-proxy/ui/components/responsive-dialog";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { CopyableCode } from "@/components/copy-button";
import { InlineRetry } from "@/components/inline-retry";
import { NativeSelect } from "@/components/native-select";
import { StatusPill } from "@/components/status-pill";
import {
  MEMBER_STATUS_TONE,
  type PoolMemberView,
  type PoolView,
  parseMemberChoice,
  servedModelChoices,
} from "@/lib/pool-ui";
import { refusalText } from "@/lib/refusal-text";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/pools/$poolId/")({
  component: PoolOverviewPage,
});

function usePoolInvalidation() {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: orpc.pools.key() });
    await queryClient.invalidateQueries({ queryKey: orpc.models.key() });
    await queryClient.invalidateQueries({ queryKey: orpc.runtimes.key() });
  };
}

function PoolOverviewPage() {
  const { t } = useTranslation(["dashboard", "common"]);
  const { poolId } = Route.useParams();
  const pool = useQuery({
    ...orpc.pools.get.queryOptions({ input: { poolId } }),
    refetchInterval: (query) =>
      query.state.data?.members.some((member) => member.status === "starting") ? 3_000 : false,
  });

  if (pool.isPending)
    return (
      <div className="flex flex-col gap-4" aria-hidden="true">
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  if (pool.isError)
    return <InlineRetry message={t("dashboard:pool.loadFailed")} onRetry={() => pool.refetch()} />;
  return <PoolOverview pool={pool.data} />;
}

function PoolOverview({ pool }: { pool: PoolView }) {
  const { t } = useTranslation(["dashboard", "common"]);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="min-w-0 space-y-1">
        <h1 className="flex min-w-0 flex-wrap items-center gap-2 text-2xl font-semibold">
          <span className="break-all">{pool.name}</span>
          <StatusPill tone="info">{t(`dashboard:models.type.${pool.modelType}`)}</StatusPill>
        </h1>
        {pool.description ? (
          <p className="text-sm text-muted-foreground">{pool.description}</p>
        ) : null}
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("dashboard:pool.callAs")}</CardTitle>
          <CardDescription>{t("dashboard:pool.callAsHint")}</CardDescription>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-2">
          {pool.callableIds.map((id) => (
            <CopyableCode key={id} value={id} label={t("dashboard:models.copyId", { id })} />
          ))}
        </CardContent>
      </Card>
      <MembersCard pool={pool} />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("dashboard:pool.runsOn")}</CardTitle>
        </CardHeader>
        <CardContent>
          {pool.runsOn.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("dashboard:pool.runsOnNone")}</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {pool.runsOn.map((node) => (
                <li key={node.nodeId}>
                  <StatusPill tone={node.mine ? "good" : "info"}>
                    {t("dashboard:pool.runsOnNode", { node: node.slug, count: node.instances })}
                  </StatusPill>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
      <DeletePool pool={pool} />
    </div>
  );
}

function memberLabel(member: PoolMemberView): string {
  return member.runtimeSlug
    ? `${member.runtimeSlug} · ${member.upstreamModelId}`
    : member.upstreamModelId;
}

function MembersCard({ pool }: { pool: PoolView }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const { lang } = Route.useParams();
  const invalidate = usePoolInvalidation();
  const runtimes = useQuery(orpc.runtimes.list.queryOptions());
  const [choice, setChoice] = useState("");
  const update = useMutation({
    ...orpc.pools.update.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const removeContributed = useMutation({
    ...orpc.pools.members.removeContributed.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const inPool = new Set(
    pool.members.map((member) => `${member.runtimeId ?? ""}::${member.upstreamModelId}`),
  );
  const choices = servedModelChoices(runtimes.data?.runtimes ?? [], pool.modelType).filter(
    (option) => !inPool.has(option.value),
  );

  const run = async (work: () => Promise<unknown>, success: string): Promise<boolean> => {
    try {
      await work();
      await invalidate();
      toast.success(success);
      return true;
    } catch (error) {
      toast.error(refusalText(error));
      return false;
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:pool.members")}</CardTitle>
        <CardDescription>{t("dashboard:pool.membersHint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        {pool.members.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("dashboard:pool.noMembers")}</p>
        ) : (
          <ul className="flex min-w-0 flex-col divide-y">
            {pool.members.map((member) => (
              <li key={member.id} className="flex min-w-0 flex-wrap items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <p className="break-all font-mono text-sm">
                    {member.runtimeId ? (
                      <Link
                        to="/$lang/runtimes/$runtimeId"
                        params={{ lang, runtimeId: member.runtimeId }}
                        className="underline-offset-4 hover:underline"
                      >
                        {memberLabel(member)}
                      </Link>
                    ) : (
                      memberLabel(member)
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {member.kind === "CLOUD"
                      ? t("dashboard:pool.cloudMember", { order: (member.cloudOrder ?? 0) + 1 })
                      : member.contributorEmail
                        ? t("dashboard:pool.contributedBy", { email: member.contributorEmail })
                        : t("dashboard:pool.instancesLive", {
                            running: member.live.running,
                            total: member.live.instances,
                          })}
                  </p>
                </div>
                <StatusPill tone={MEMBER_STATUS_TONE[member.status]}>
                  {t(`dashboard:pool.memberStatus.${member.status}`)}
                </StatusPill>
                {member.kind === "LOCAL" && !member.shareId ? (
                  <Button
                    variant="outline"
                    size="touch"
                    disabled={update.isPending}
                    onClick={() =>
                      run(
                        () =>
                          update.mutateAsync({
                            poolId: pool.id,
                            members: {
                              set: [
                                {
                                  memberId: member.id,
                                  state: member.state === "ACTIVE" ? "DISABLED" : "ACTIVE",
                                },
                              ],
                            },
                          }),
                        t("dashboard:pool.saved"),
                      )
                    }
                  >
                    {member.state === "ACTIVE"
                      ? t("dashboard:pool.disableMember")
                      : t("dashboard:pool.enableMember")}
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="icon-touch"
                  aria-label={t("dashboard:pool.removeMember", { member: memberLabel(member) })}
                  disabled={update.isPending || removeContributed.isPending}
                  onClick={() =>
                    run(
                      () =>
                        member.shareId
                          ? removeContributed.mutateAsync({ memberId: member.id })
                          : update.mutateAsync({
                              poolId: pool.id,
                              members: { remove: [member.id] },
                            }),
                      t("dashboard:pool.memberRemoved"),
                    )
                  }
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            const member = parseMemberChoice(choice);
            if (!member) return;
            run(
              () => update.mutateAsync({ poolId: pool.id, members: { add: [member] } }),
              t("dashboard:pool.memberAdded"),
            ).then((ok) => {
              if (ok) setChoice("");
            });
          }}
        >
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor="pool-add-member">{t("dashboard:pool.addMember")}</Label>
            {runtimes.isPending ? (
              <Skeleton className="h-11 w-full" />
            ) : (
              <NativeSelect
                id="pool-add-member"
                value={choice}
                onChange={(event) => setChoice(event.target.value)}
              >
                <option value="">{t("dashboard:pool.pickServedModel")}</option>
                {choices.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </NativeSelect>
            )}
          </div>
          <Button type="submit" size="touch" disabled={!choice || update.isPending}>
            {t("dashboard:pool.add")}
          </Button>
        </form>
        {!runtimes.isPending && choices.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("dashboard:pool.form.noServedModels")}{" "}
            <Link to="/$lang/runtimes/new" params={{ lang }} className="underline">
              {t("dashboard:runtime.new")}
            </Link>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function DeletePool({ pool }: { pool: PoolView }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const { lang } = Route.useParams();
  const navigate = useNavigate();
  const invalidate = usePoolInvalidation();
  const [open, setOpen] = useState(false);
  const remove = useMutation({
    ...orpc.pools.delete.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  return (
    <>
      <div>
        <Button variant="destructive" size="touch" onClick={() => setOpen(true)}>
          {t("dashboard:pool.delete")}
        </Button>
      </div>
      <ResponsiveDialog
        open={open}
        onOpenChange={setOpen}
        title={t("dashboard:pool.deleteTitle", { name: pool.name })}
        description={t("dashboard:pool.deleteHint")}
        footer={
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button variant="outline" size="touch" onClick={() => setOpen(false)}>
              {t("common:actions.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="touch"
              disabled={remove.isPending}
              onClick={async () => {
                try {
                  await remove.mutateAsync({ poolId: pool.id });
                  setOpen(false);
                  // Leave first: the deleted pool's own query must not refetch.
                  await navigate({ to: "/$lang/pools", params: { lang } });
                  await invalidate();
                } catch (error) {
                  toast.error(refusalText(error));
                }
              }}
            >
              {remove.isPending ? t("common:actions.deleting") : t("common:actions.delete")}
            </Button>
          </div>
        }
      >
        <span />
      </ResponsiveDialog>
    </>
  );
}
