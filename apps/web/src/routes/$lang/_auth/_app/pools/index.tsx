import { useForm } from "@tanstack/react-form";
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
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { ResponsiveDialog } from "@ws-model-proxy/ui/components/responsive-dialog";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { CopyableCode } from "@/components/copy-button";
import { FieldErrors } from "@/components/field-errors";
import { InlineRetry } from "@/components/inline-retry";
import { NativeSelect } from "@/components/native-select";
import { PageHeading } from "@/components/page-stub";
import { Sparkline } from "@/components/sparkline";
import { type PillTone, StatusPill } from "@/components/status-pill";
import {
  MODEL_TYPES,
  type ModelType,
  type PoolView,
  parseMemberChoice,
  servedModelChoices,
} from "@/lib/pool-ui";
import { refusalText } from "@/lib/refusal-text";
import { SLUG_PATTERN, slugify } from "@/lib/slugify";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/pools/")({
  component: PoolsPage,
});

function poolHealth(pool: PoolView): { tone: PillTone; key: string } {
  const statuses = pool.members.map((member) => member.status);
  if (statuses.includes("serving")) return { tone: "good", key: "serving" };
  if (statuses.includes("starting")) return { tone: "busy", key: "starting" };
  if (pool.members.length === 0) return { tone: "muted", key: "empty" };
  return { tone: "muted", key: "unavailable" };
}

function PoolsPage() {
  const { t } = useTranslation(["dashboard", "common"]);
  const { lang } = Route.useParams();
  const pools = useQuery(orpc.pools.list.queryOptions());
  const [creating, setCreating] = useState(false);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <PageHeading page="pools" />
        <Button size="touch" onClick={() => setCreating(true)}>
          <Plus aria-hidden="true" />
          {t("dashboard:pool.new")}
        </Button>
      </div>
      {pools.isPending ? (
        <div className="grid gap-3 md:grid-cols-2" aria-hidden="true">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      ) : pools.isError ? (
        <InlineRetry message={t("dashboard:pool.loadFailed")} onRetry={() => pools.refetch()} />
      ) : (
        <>
          {pools.data.pools.length === 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("dashboard:pool.emptyTitle")}</CardTitle>
                <CardDescription>{t("dashboard:pool.emptyHint")}</CardDescription>
              </CardHeader>
            </Card>
          ) : (
            <ul className="grid min-w-0 gap-3 md:grid-cols-2">
              {pools.data.pools.map((pool) => {
                const health = poolHealth(pool);
                return (
                  <li key={pool.id} className="min-w-0">
                    <Card className="h-full">
                      <CardHeader>
                        <CardTitle className="flex min-w-0 flex-wrap items-center gap-2 text-base">
                          <Link
                            to="/$lang/pools/$poolId"
                            params={{ lang, poolId: pool.id }}
                            className="inline-flex min-h-11 items-center break-all underline-offset-4 hover:underline"
                          >
                            {pool.name}
                          </Link>
                          <StatusPill tone={health.tone}>
                            {t(`dashboard:pool.health.${health.key}`)}
                          </StatusPill>
                          <StatusPill tone="info">
                            {t(`dashboard:models.type.${pool.modelType}`)}
                          </StatusPill>
                          {pool.cloud.mode !== "OFF" ? (
                            <StatusPill tone="busy">{t("dashboard:pool.cloudOn")}</StatusPill>
                          ) : null}
                        </CardTitle>
                        <CardDescription>
                          {t("dashboard:pool.memberCount", { count: pool.members.length })}
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="flex min-w-0 flex-col gap-2">
                        {pool.callableIds.map((id) => (
                          <CopyableCode
                            key={id}
                            value={id}
                            label={t("dashboard:models.copyId", { id })}
                          />
                        ))}
                        <div className="flex items-center gap-3 text-sm text-muted-foreground">
                          <Sparkline
                            values={pool.traffic24h.sparkline}
                            label={t("dashboard:pool.traffic", {
                              count: pool.traffic24h.requests,
                            })}
                          />
                          <span>
                            {t("dashboard:pool.traffic", { count: pool.traffic24h.requests })}
                          </span>
                        </div>
                      </CardContent>
                    </Card>
                  </li>
                );
              })}
            </ul>
          )}
          {pools.data.sharedWithMe.length > 0 ? (
            <section className="flex min-w-0 flex-col gap-3">
              <h2 className="text-lg font-semibold">{t("dashboard:pool.sharedWithMe")}</h2>
              <ul className="grid min-w-0 gap-3 md:grid-cols-2">
                {pools.data.sharedWithMe.map((shared) => (
                  <li key={shared.poolId} className="min-w-0">
                    <Card>
                      <CardContent className="flex min-w-0 flex-col gap-2 pt-4">
                        <p className="text-sm text-muted-foreground">
                          {t("dashboard:models.sharedBy", { owner: shared.ownerEmail })}
                        </p>
                        {shared.canUse
                          ? shared.callableIds.map((id) => (
                              <CopyableCode
                                key={id}
                                value={id}
                                label={t("dashboard:models.copyId", { id })}
                              />
                            ))
                          : null}
                        <div className="flex flex-wrap gap-2">
                          {shared.canUse ? (
                            <StatusPill tone="good">{t("dashboard:pool.canUse")}</StatusPill>
                          ) : null}
                          {shared.canContribute ? (
                            <StatusPill tone="info">{t("dashboard:pool.canContribute")}</StatusPill>
                          ) : null}
                        </div>
                      </CardContent>
                    </Card>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
      <NewPoolDialog open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function NewPoolDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const { lang } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const runtimes = useQuery({ ...orpc.runtimes.list.queryOptions(), enabled: open });
  const create = useMutation({
    ...orpc.pools.create.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const schema = z.object({
    name: z.string().trim().min(1, t("dashboard:pool.form.nameRequired")).max(120),
    slug: z.string().regex(SLUG_PATTERN, t("dashboard:pool.form.slugInvalid")),
    type: z.enum(MODEL_TYPES),
    member: z.string(),
  });
  const form = useForm({
    defaultValues: { name: "", slug: "", type: "LLM" as ModelType, member: "" },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const member = parseMemberChoice(value.member);
      try {
        const pool = await create.mutateAsync({
          name: value.name.trim(),
          slug: value.slug,
          type: value.type,
          ...(member ? { members: [member] } : {}),
        });
        await queryClient.invalidateQueries({ queryKey: orpc.pools.key() });
        await queryClient.invalidateQueries({ queryKey: orpc.models.key() });
        toast.success(t("dashboard:pool.created"));
        onOpenChange(false);
        form.reset();
        await navigate({ to: "/$lang/pools/$poolId", params: { lang, poolId: pool.id } });
      } catch (error) {
        toast.error(refusalText(error, t("dashboard:pool.createFailed")));
      }
    },
  });

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("dashboard:pool.new")}
      description={t("dashboard:pool.newHint")}
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
              <Label htmlFor="pool-name">{t("dashboard:pool.form.name")}</Label>
              <Input
                id="pool-name"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => {
                  const previousSuggestion = slugify(field.state.value);
                  field.handleChange(event.target.value);
                  const slug = form.getFieldValue("slug");
                  if (slug === "" || slug === previousSuggestion)
                    form.setFieldValue("slug", slugify(event.target.value));
                }}
                className="h-11"
              />
              <FieldErrors field={field} />
            </div>
          )}
        </form.Field>
        <form.Field name="slug">
          {(field) => (
            <div className="space-y-1.5">
              <Label htmlFor="pool-slug">{t("dashboard:pool.form.slug")}</Label>
              <Input
                id="pool-slug"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
                className="h-11 font-mono"
                autoCapitalize="none"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">{t("dashboard:pool.form.slugHint")}</p>
              <FieldErrors field={field} />
            </div>
          )}
        </form.Field>
        <form.Field name="type">
          {(field) => (
            <div className="space-y-1.5">
              <Label htmlFor="pool-type">{t("dashboard:pool.form.type")}</Label>
              <NativeSelect
                id="pool-type"
                value={field.state.value}
                onChange={(event) => {
                  field.handleChange(event.target.value as ModelType);
                  form.setFieldValue("member", "");
                }}
              >
                {MODEL_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`dashboard:models.type.${type}`)}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
        </form.Field>
        <form.Subscribe selector={(state) => state.values.type}>
          {(type) => (
            <form.Field name="member">
              {(field) => {
                const choices = servedModelChoices(runtimes.data?.runtimes ?? [], type);
                return (
                  <div className="space-y-1.5">
                    <Label htmlFor="pool-member">{t("dashboard:pool.form.firstMember")}</Label>
                    {runtimes.isPending ? (
                      <Skeleton className="h-11 w-full" />
                    ) : (
                      <NativeSelect
                        id="pool-member"
                        value={field.state.value}
                        onChange={(event) => field.handleChange(event.target.value)}
                      >
                        <option value="">{t("dashboard:pool.form.noMember")}</option>
                        {choices.map((choice) => (
                          <option key={choice.value} value={choice.value}>
                            {choice.label}
                          </option>
                        ))}
                      </NativeSelect>
                    )}
                    {!runtimes.isPending && choices.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        {t("dashboard:pool.form.noServedModels")}
                      </p>
                    ) : null}
                  </div>
                );
              }}
            </form.Field>
          )}
        </form.Subscribe>
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <Button type="submit" size="touch" disabled={submitting}>
              {submitting ? t("common:actions.saving") : t("dashboard:pool.create")}
            </Button>
          )}
        </form.Subscribe>
      </form>
    </ResponsiveDialog>
  );
}
