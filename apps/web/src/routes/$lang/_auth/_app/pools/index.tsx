import { useForm, useStore } from "@tanstack/react-form";
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
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { ArrowRight, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { CopyableCode } from "@/components/copy-button";
import { FieldErrors } from "@/components/field-errors";
import { InlineRetry } from "@/components/inline-retry";
import { NativeSelect } from "@/components/native-select";
import { PageHeading } from "@/components/page-stub";
import { SegmentedControl } from "@/components/segmented-control";
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
                        <PoolFlow pool={pool} />
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
      {/* Mounted per opening, so a cancelled sheet starts over. */}
      {creating ? <NewPoolDialog onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

/** Where requests go, in order: own local members, contributed members, then the cloud. */
function PoolFlow({ pool }: { pool: PoolView }) {
  const { t } = useTranslation(["dashboard"]);
  const local = pool.members.filter((member) => member.kind === "LOCAL" && !member.shareId);
  const contributed = pool.members.filter((member) => member.kind === "LOCAL" && member.shareId);
  const cloud = pool.members.filter((member) => member.kind === "CLOUD");
  const cloudOff = pool.cloud.mode === "OFF";
  const steps = [
    { key: "local", count: local.length, off: false },
    { key: "contributed", count: contributed.length, off: false },
    { key: "cloud", count: cloud.length, off: cloudOff },
  ] as const;
  return (
    <ol
      className="flex min-w-0 flex-wrap items-center gap-1 text-xs"
      aria-label={t("dashboard:pool.flow.label")}
    >
      {steps.map((step, index) => (
        <li key={step.key} className="flex items-center gap-1">
          {index > 0 ? (
            <ArrowRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
          ) : null}
          <span
            className={cn(
              "rounded-md border px-2 py-1 tabular-nums",
              step.count === 0 || step.off ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {step.off
              ? t("dashboard:pool.flow.cloudOff", { count: step.count })
              : t(`dashboard:pool.flow.${step.key}`, { count: step.count })}
          </span>
        </li>
      ))}
    </ol>
  );
}

type ServedChoice = ReturnType<typeof servedModelChoices>[number] & { type: ModelType };
const CLOUD_MODES = ["OWNER", "OWNER_AND_SHARES"] as const;

/** A name suggestion from a served model id (`Qwen/Qwen3-8B` → `Qwen3-8B`). */
function nameFromModel(model: string): string {
  return model.split("/").filter(Boolean).at(-1) ?? model;
}

function NewPoolDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const { lang } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const runtimes = useQuery(orpc.runtimes.list.queryOptions());
  const create = useMutation({
    ...orpc.pools.create.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const setMode = useMutation({
    ...orpc.pools.cloud.setMode.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const update = useMutation({
    ...orpc.pools.update.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const served: ServedChoice[] = MODEL_TYPES.flatMap((type) =>
    servedModelChoices(runtimes.data?.runtimes ?? [], type).map((choice) => ({ ...choice, type })),
  );
  const schema = z.object({
    member: z.string(),
    type: z.enum(MODEL_TYPES),
    name: z.string().trim().min(1, t("dashboard:pool.form.nameRequired")).max(120),
    slug: z.string().regex(SLUG_PATTERN, t("dashboard:pool.form.slugInvalid")),
    cloud: z.enum(["local", "cloud"]),
    mode: z.enum(CLOUD_MODES),
    providerModel: z.string(),
  });
  const defaultValues: z.infer<typeof schema> = {
    member: "",
    type: "LLM",
    name: "",
    slug: "",
    cloud: "local",
    mode: "OWNER",
    providerModel: "",
  };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const member = parseMemberChoice(value.member);
      let pool: { id: string };
      try {
        pool = await create.mutateAsync({
          name: value.name.trim(),
          slug: value.slug,
          type: value.type,
          ...(member ? { members: [member] } : {}),
        });
      } catch (error) {
        toast.error(refusalText(error, t("dashboard:pool.createFailed")));
        return;
      }
      // The cloud step runs after the pool exists (cloud spend is set by a person, as on Cloud).
      let cloudFailed = false;
      if (value.cloud === "cloud") {
        try {
          await setMode.mutateAsync({ poolId: pool.id, mode: value.mode });
          if (value.providerModel)
            await update.mutateAsync({
              poolId: pool.id,
              cloudMembers: [{ providerModelId: value.providerModel }],
            });
        } catch (error) {
          cloudFailed = true;
          toast.error(`${t("dashboard:pool.newSheet.cloudFailed")} ${refusalText(error)}`.trim());
        }
      }
      await queryClient.invalidateQueries({ queryKey: orpc.pools.key() });
      await queryClient.invalidateQueries({ queryKey: orpc.models.key() });
      await queryClient.invalidateQueries({ queryKey: orpc.runtimes.key() });
      if (!cloudFailed) toast.success(t("dashboard:pool.created"));
      onClose();
      await navigate(
        cloudFailed
          ? { to: "/$lang/pools/$poolId/cloud", params: { lang, poolId: pool.id } }
          : { to: "/$lang/pools/$poolId", params: { lang, poolId: pool.id } },
      );
    },
  });

  const cloud = useStore(form.store, (state) => state.values.cloud);
  const type = useStore(form.store, (state) => state.values.type);
  const providerModels = useQuery({
    ...orpc.providers.models.list.queryOptions({ input: {} }),
    enabled: cloud === "cloud",
  });
  const cloudCandidates = (providerModels.data?.models ?? []).filter(
    (model) => model.enabled && model.type === type,
  );

  /** Picking a served model sets the type and suggests a name and slug (until edited). */
  const pickMember = (value: string) => {
    const previous = served.find((choice) => choice.value === form.getFieldValue("member"));
    const next = served.find((choice) => choice.value === value);
    form.setFieldValue("member", value);
    if (!next) return;
    form.setFieldValue("type", next.type);
    form.setFieldValue("providerModel", "");
    const name = form.getFieldValue("name");
    const previousName = previous ? nameFromModel(previous.model) : "";
    if (name === "" || name === previousName) {
      const suggestion = nameFromModel(next.model);
      form.setFieldValue("name", suggestion);
      const slug = form.getFieldValue("slug");
      if (slug === "" || slug === slugify(name)) form.setFieldValue("slug", slugify(suggestion));
    }
  };

  return (
    <ResponsiveDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
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
        <form.Field name="member">
          {(field) => (
            <div className="space-y-1.5">
              <Label htmlFor="pool-member">{t("dashboard:pool.newSheet.servedModel")}</Label>
              {runtimes.isPending ? (
                <Skeleton className="h-11 w-full" />
              ) : runtimes.isError ? (
                <InlineRetry onRetry={() => runtimes.refetch()} />
              ) : (
                <NativeSelect
                  id="pool-member"
                  value={field.state.value}
                  onChange={(event) => pickMember(event.target.value)}
                >
                  <option value="">{t("dashboard:pool.newSheet.startEmpty")}</option>
                  {MODEL_TYPES.map((type) => {
                    const ofType = served.filter((choice) => choice.type === type);
                    return ofType.length > 0 ? (
                      <optgroup key={type} label={t(`dashboard:models.type.${type}`)}>
                        {ofType.map((choice) => (
                          <option key={choice.value} value={choice.value}>
                            {choice.label}
                          </option>
                        ))}
                      </optgroup>
                    ) : null;
                  })}
                </NativeSelect>
              )}
              {runtimes.isSuccess && served.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("dashboard:pool.form.noServedModels")}{" "}
                  <Link to="/$lang/runtimes/new" params={{ lang }} className="underline">
                    {t("dashboard:runtime.new")}
                  </Link>
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t("dashboard:pool.newSheet.servedModelHint")}
                </p>
              )}
            </div>
          )}
        </form.Field>
        <form.Subscribe selector={(state) => state.values.member}>
          {(member) =>
            member ? null : (
              <form.Field name="type">
                {(field) => (
                  <div className="space-y-1.5">
                    <Label htmlFor="pool-type">{t("dashboard:pool.form.type")}</Label>
                    <NativeSelect
                      id="pool-type"
                      value={field.state.value}
                      onChange={(event) => {
                        field.handleChange(event.target.value as ModelType);
                        form.setFieldValue("providerModel", "");
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
            )
          }
        </form.Subscribe>
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
        <form.Field name="cloud">
          {(field) => (
            <div className="space-y-1.5">
              <p className="text-sm font-medium">{t("dashboard:pool.newSheet.cloud")}</p>
              <SegmentedControl
                value={field.state.value}
                onChange={(next) => field.handleChange(next)}
                ariaLabel={t("dashboard:pool.newSheet.cloud")}
                items={[
                  { value: "local", label: t("dashboard:pool.newSheet.localOnly") },
                  { value: "cloud", label: t("dashboard:pool.newSheet.withCloud") },
                ]}
              />
              <p className="text-xs text-muted-foreground">
                {field.state.value === "local"
                  ? t("dashboard:pool.newSheet.localOnlyHint")
                  : t("dashboard:pool.newSheet.withCloudHint")}
              </p>
            </div>
          )}
        </form.Field>
        {cloud === "cloud" ? (
          <div className="flex flex-col gap-4 rounded-md border border-dashed p-3">
            <form.Field name="mode">
              {(field) => (
                <div className="space-y-1.5">
                  <Label htmlFor="pool-cloud-mode">{t("dashboard:pool.cloud.mode")}</Label>
                  <NativeSelect
                    id="pool-cloud-mode"
                    value={field.state.value}
                    onChange={(event) =>
                      field.handleChange(event.target.value as (typeof CLOUD_MODES)[number])
                    }
                  >
                    {CLOUD_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {t(`dashboard:pool.cloud.modes.${mode}`)}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              )}
            </form.Field>
            <form.Field name="providerModel">
              {(field) => (
                <div className="space-y-1.5">
                  <Label htmlFor="pool-cloud-model">
                    {t("dashboard:pool.newSheet.firstCloudMember")}
                  </Label>
                  {providerModels.isPending ? (
                    <Skeleton className="h-11 w-full" />
                  ) : providerModels.isError ? (
                    <InlineRetry onRetry={() => providerModels.refetch()} />
                  ) : (
                    <NativeSelect
                      id="pool-cloud-model"
                      value={field.state.value}
                      onChange={(event) => field.handleChange(event.target.value)}
                    >
                      <option value="">{t("dashboard:pool.newSheet.noCloudMember")}</option>
                      {cloudCandidates.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.displayName ?? model.upstreamModelId}
                        </option>
                      ))}
                    </NativeSelect>
                  )}
                  {providerModels.isSuccess && cloudCandidates.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {t("dashboard:pool.cloud.noCandidates")}
                    </p>
                  ) : null}
                </div>
              )}
            </form.Field>
            <p className="text-xs text-muted-foreground">{t("dashboard:pool.cloud.humanOnly")}</p>
          </div>
        ) : null}
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
