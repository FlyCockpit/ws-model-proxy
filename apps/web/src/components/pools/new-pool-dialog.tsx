import { useForm, useStore } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { ResponsiveDialog } from "@ws-model-proxy/ui/components/responsive-dialog";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useTranslation } from "react-i18next";
import z from "zod";

import { FieldErrors } from "@/components/field-errors";
import { InlineRetry } from "@/components/inline-retry";
import { NativeSelect } from "@/components/native-select";
import { SegmentedControl } from "@/components/segmented-control";
import { type CreatedPool, useCreatePool } from "@/hooks/use-create-pool";
import { MODEL_TYPES, type ModelType, parseMemberChoice, servedModelChoices } from "@/lib/pool-ui";
import { refusalText } from "@/lib/refusal-text";
import { SLUG_PATTERN, slugify } from "@/lib/slugify";
import { orpc } from "@/utils/orpc";

export type NewPoolInitial = { name: string; slug: string; type: ModelType; member: string };

type ServedChoice = ReturnType<typeof servedModelChoices>[number] & { type: ModelType };
const CLOUD_MODES = ["OWNER", "OWNER_AND_SHARES"] as const;

/** A name suggestion from a served model id (`Qwen/Qwen3-8B` → `Qwen3-8B`). */
function nameFromModel(model: string): string {
  return model.split("/").filter(Boolean).at(-1) ?? model;
}

/**
 * Pools → "New pool", served model first: picking one of your served models sets the type and
 * suggests a name and slug; an optional cloud step runs once the pool exists. Opens the new pool
 * (its Cloud tab when the cloud step failed) unless `onCreated` takes the result. Callers remount
 * it (a fresh `key`) per opening, so a cancelled sheet starts over.
 */
export function NewPoolDialog({
  open,
  onOpenChange,
  lang,
  initial,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lang: string;
  initial?: NewPoolInitial;
  onCreated?: (pool: CreatedPool) => void;
}) {
  const { t } = useTranslation(["dashboard", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const runtimes = useQuery({ ...orpc.runtimes.list.queryOptions(), enabled: open });
  const { create } = useCreatePool();
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
    ...initial,
  };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const member = parseMemberChoice(value.member);
      let pool: CreatedPool;
      try {
        pool = await create({
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
        await queryClient.invalidateQueries({ queryKey: orpc.pools.key() });
      }
      if (!cloudFailed) toast.success(t("dashboard:pool.created"));
      onOpenChange(false);
      if (onCreated) onCreated(pool);
      else
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
    const suggested = previous ? [nameFromModel(previous.model), previous.model.slice(0, 120)] : [];
    if (name === "" || suggested.includes(name)) {
      const suggestion = nameFromModel(next.model);
      form.setFieldValue("name", suggestion);
      const slug = form.getFieldValue("slug");
      if (slug === "" || slug === slugify(name)) form.setFieldValue("slug", slugify(suggestion));
    }
  };

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
