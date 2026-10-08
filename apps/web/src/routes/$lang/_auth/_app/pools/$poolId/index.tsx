import { useForm } from "@tanstack/react-form";
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
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { ResponsiveDialog } from "@ws-model-proxy/ui/components/responsive-dialog";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Textarea } from "@ws-model-proxy/ui/components/textarea";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { CodeSnippet } from "@/components/code-snippet";
import { CopyableCode } from "@/components/copy-button";
import { FieldErrors } from "@/components/field-errors";
import { InlineRetry } from "@/components/inline-retry";
import { NativeSelect } from "@/components/native-select";
import { SegmentedControl } from "@/components/segmented-control";
import { StatusPill } from "@/components/status-pill";
import { callSnippet, type SnippetKind, snippetKinds } from "@/lib/call-snippets";
import { formatMs } from "@/lib/format-metrics";
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

const STATS = ["requests", "errors", "latency_p95", "queue_wait_p95"] as const;

function usePoolInvalidation() {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: orpc.pools.key() });
    await queryClient.invalidateQueries({ queryKey: orpc.models.key() });
    await queryClient.invalidateQueries({ queryKey: orpc.runtimes.key() });
  };
}

/** Runs a pool write: invalidates, toasts, and answers whether it worked. */
function usePoolWrite() {
  const invalidate = usePoolInvalidation();
  return async (work: () => Promise<unknown>, success: string): Promise<boolean> => {
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
        <Skeleton className="h-12 w-2/3 rounded-xl" />
        <div className="grid min-w-0 grid-cols-2 gap-3 md:grid-cols-4">
          {STATS.map((key) => (
            <Skeleton key={key} className="h-20 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  if (pool.isError)
    return <InlineRetry message={t("dashboard:pool.loadFailed")} onRetry={() => pool.refetch()} />;
  return <PoolOverview pool={pool.data} />;
}

function PoolOverview({ pool }: { pool: PoolView }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const [editing, setEditing] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="flex min-w-0 flex-wrap items-center gap-2 text-2xl font-semibold">
            <span className="break-all">{pool.name}</span>
            <StatusPill tone="info">{t(`dashboard:models.type.${pool.modelType}`)}</StatusPill>
          </h1>
          {pool.description ? (
            <p className="text-sm text-muted-foreground">{pool.description}</p>
          ) : null}
        </div>
        <Button variant="outline" size="touch" onClick={() => setEditing(true)}>
          <Pencil aria-hidden="true" />
          {t("dashboard:pool.details.edit")}
        </Button>
      </div>
      <StatsRow poolId={pool.id} />
      <CallCard pool={pool} />
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
      {/* Mounted per opening, so the form starts from the pool as it is now. */}
      {editing ? <EditDetailsDialog pool={pool} onClose={() => setEditing(false)} /> : null}
    </div>
  );
}

// ── Stats ──

function StatsRow({ poolId }: { poolId: string }) {
  const { t, i18n } = useTranslation(["dashboard"]);
  const lang = i18n.language;
  const stats = useQuery(
    orpc.activity.metrics.query.queryOptions({
      input: {
        scope: { pool: poolId },
        metrics: [...STATS],
        range: "24h",
        step: "1h",
        includeTests: false,
      },
    }),
  );
  const none = t("dashboard:overview.kpi.none");
  const count = new Intl.NumberFormat(lang, { notation: "compact", maximumFractionDigits: 1 });
  if (stats.isPending)
    return (
      <div className="grid min-w-0 grid-cols-2 gap-3 md:grid-cols-4" aria-hidden="true">
        {STATS.map((key) => (
          <Skeleton key={key} className="h-20 rounded-xl" />
        ))}
      </div>
    );
  if (stats.isError)
    return (
      <InlineRetry message={t("dashboard:pool.stats.loadFailed")} onRetry={() => stats.refetch()} />
    );
  const totals = stats.data.totals;
  const requests = totals.requests ?? 0;
  const errors = totals.errors ?? 0;
  const tiles = [
    { key: "requests", value: count.format(requests), bad: false },
    { key: "errors", value: count.format(errors), bad: errors > 0 },
    { key: "latency", value: formatMs(totals.latency_p95 ?? null, lang, none), bad: false },
    { key: "queueWait", value: formatMs(totals.queue_wait_p95 ?? null, lang, none), bad: false },
  ];
  return (
    <section className="flex min-w-0 flex-col gap-2" aria-labelledby="pool-stats">
      <h2 id="pool-stats" className="text-sm text-muted-foreground">
        {t("dashboard:pool.stats.title")}
      </h2>
      <dl className="grid min-w-0 grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.key} className="min-w-0 rounded-xl border bg-card p-3">
            <dt className="truncate text-xs text-muted-foreground">
              {t(`dashboard:overview.kpi.${tile.key}`)}
            </dt>
            <dd
              className={cn("text-lg font-semibold tabular-nums", tile.bad && "text-destructive")}
            >
              {tile.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// ── Call this pool ──

function CallCard({ pool }: { pool: PoolView }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const models = useQuery(orpc.models.list.queryOptions());
  const [kind, setKind] = useState<SnippetKind>("curl");
  const kinds = snippetKinds(pool.modelType);
  const shown = kinds.includes(kind) ? kind : "curl";
  const callableId = pool.callableIds[0];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:pool.call.title")}</CardTitle>
        <CardDescription>{t("dashboard:pool.callAsHint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        {pool.callableIds.map((id) => (
          <CopyableCode key={id} value={id} label={t("dashboard:models.copyId", { id })} />
        ))}
        <SegmentedControl
          value={shown}
          onChange={setKind}
          ariaLabel={t("dashboard:pool.call.kind")}
          items={kinds.map((value) => ({ value, label: t(`dashboard:pool.call.kinds.${value}`) }))}
        />
        {models.isPending ? (
          <Skeleton className="h-28 w-full rounded-md" />
        ) : models.isError ? (
          <InlineRetry onRetry={() => models.refetch()} />
        ) : callableId ? (
          <CodeSnippet
            code={callSnippet(shown, models.data.baseUrl, callableId, pool.modelType)}
            copyLabel={t("dashboard:models.copySnippet")}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

// ── Name and description ──

function EditDetailsDialog({ pool, onClose }: { pool: PoolView; onClose: () => void }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const write = usePoolWrite();
  const update = useMutation({
    ...orpc.pools.update.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const form = useForm({
    defaultValues: { name: pool.name, description: pool.description ?? "" },
    validators: {
      onSubmit: z.object({
        name: z.string().trim().min(1, t("dashboard:pool.form.nameRequired")).max(120),
        description: z.string().trim().max(2_000, t("dashboard:pool.details.descriptionTooLong")),
      }),
    },
    onSubmit: async ({ value }) => {
      const ok = await write(
        () =>
          update.mutateAsync({
            poolId: pool.id,
            name: value.name.trim(),
            description: value.description.trim() || null,
          }),
        t("dashboard:pool.saved"),
      );
      if (ok) onClose();
    },
  });
  return (
    <ResponsiveDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t("dashboard:pool.details.title")}
    >
      <form
        className="flex flex-col gap-4 pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          form.handleSubmit();
        }}
      >
        <form.Field name="name">
          {(field) => (
            <div className="space-y-1.5">
              <Label htmlFor="pool-edit-name">{t("dashboard:pool.form.name")}</Label>
              <Input
                id="pool-edit-name"
                className="h-11"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <FieldErrors field={field} />
            </div>
          )}
        </form.Field>
        <form.Field name="description">
          {(field) => (
            <div className="space-y-1.5">
              <Label htmlFor="pool-edit-description">
                {t("dashboard:pool.details.description")}
              </Label>
              <Textarea
                id="pool-edit-description"
                rows={3}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
              />
              <FieldErrors field={field} />
            </div>
          )}
        </form.Field>
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <Button type="submit" size="touch" disabled={submitting}>
              {submitting ? t("common:actions.saving") : t("common:actions.save")}
            </Button>
          )}
        </form.Subscribe>
      </form>
    </ResponsiveDialog>
  );
}

// ── Members ──

function memberLabel(member: PoolMemberView): string {
  return member.runtimeSlug
    ? `${member.runtimeSlug} · ${member.upstreamModelId}`
    : member.upstreamModelId;
}

/** Local (own), then contributed, then cloud members in their try order. */
function memberRank(member: PoolMemberView): number {
  if (member.kind === "CLOUD") return 2_000 + (member.cloudOrder ?? 0);
  return member.shareId ? 1_000 : 0;
}

function MembersCard({ pool }: { pool: PoolView }) {
  const { t, i18n } = useTranslation(["dashboard", "common"]);
  const { lang } = Route.useParams();
  const write = usePoolWrite();
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
  const members = [...pool.members].sort((a, b) => memberRank(a) - memberRank(b));
  const none = t("dashboard:overview.kpi.none");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dashboard:pool.members")}</CardTitle>
        <CardDescription>{t("dashboard:pool.membersHint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("dashboard:pool.noMembers")}</p>
        ) : (
          <ul className="flex min-w-0 flex-col divide-y">
            {members.map((member) => (
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
                    {member.live.p95LatencyMs !== null
                      ? ` · ${t("dashboard:pool.live.p95", {
                          value: formatMs(member.live.p95LatencyMs, i18n.language, none),
                        })}`
                      : ""}
                    {member.live.waiting !== null && member.live.waiting > 0
                      ? ` · ${t("dashboard:pool.live.waiting", { count: member.live.waiting })}`
                      : ""}
                  </p>
                </div>
                <StatusPill tone={MEMBER_STATUS_TONE[member.status]}>
                  {t(`dashboard:pool.memberStatus.${member.status}`)}
                </StatusPill>
                {member.kind === "LOCAL" ? (
                  <MemberWeightForm
                    member={member}
                    pending={update.isPending || removeContributed.isPending}
                    onSave={(weight) =>
                      write(
                        () =>
                          update.mutateAsync({
                            poolId: pool.id,
                            members: { set: [{ memberId: member.id, weight }] },
                          }),
                        t("dashboard:pool.saved"),
                      )
                    }
                  />
                ) : null}
                {member.kind === "LOCAL" && !member.shareId ? (
                  <Button
                    variant="outline"
                    size="touch"
                    disabled={update.isPending}
                    onClick={() =>
                      write(
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
                    write(
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
            write(
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

/** A member's routing weight (1–1000; higher gets more requests). */
function MemberWeightForm({
  member,
  pending,
  onSave,
}: {
  member: PoolMemberView;
  /** Another write to this pool is running. */
  pending: boolean;
  onSave: (weight: number) => Promise<boolean>;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const form = useForm({
    defaultValues: { weight: String(member.weight) },
    validators: {
      onSubmit: z.object({
        weight: z
          .string()
          .trim()
          .regex(/^\d{1,4}$/, t("dashboard:pool.weight.invalid"))
          .refine(
            (value) => Number(value) >= 1 && Number(value) <= 1_000,
            t("dashboard:pool.weight.invalid"),
          ),
      }),
    },
    onSubmit: async ({ value }) => {
      await onSave(Number(value.weight.trim()));
    },
  });
  const id = `member-weight-${member.id}`;
  return (
    <form
      className="flex items-start gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        form.handleSubmit();
      }}
    >
      <form.Field name="weight">
        {(field) => (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1">
              <Label htmlFor={id} className="text-xs text-muted-foreground">
                {t("dashboard:pool.weight.label")}
              </Label>
              <Input
                id={id}
                inputMode="numeric"
                className="h-11 w-20 tabular-nums"
                aria-label={t("dashboard:pool.weight.aria", { member: memberLabel(member) })}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            </div>
            <FieldErrors field={field} />
          </div>
        )}
      </form.Field>
      <form.Subscribe
        selector={(state) => [state.isSubmitting, state.values.weight.trim()] as const}
      >
        {([submitting, weight]) => (
          <Button
            type="submit"
            variant="outline"
            size="touch"
            disabled={submitting || pending || weight === String(member.weight)}
          >
            {t("dashboard:pool.weight.save")}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}
