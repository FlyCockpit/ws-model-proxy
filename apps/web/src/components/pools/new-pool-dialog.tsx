import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { ResponsiveDialog } from "@ws-model-proxy/ui/components/responsive-dialog";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useTranslation } from "react-i18next";
import z from "zod";

import { FieldErrors } from "@/components/field-errors";
import { NativeSelect } from "@/components/native-select";
import { type CreatedPool, useCreatePool } from "@/hooks/use-create-pool";
import { MODEL_TYPES, type ModelType, parseMemberChoice, servedModelChoices } from "@/lib/pool-ui";
import { refusalText } from "@/lib/refusal-text";
import { SLUG_PATTERN, slugify } from "@/lib/slugify";
import { orpc } from "@/utils/orpc";

export type NewPoolInitial = { name: string; slug: string; type: ModelType; member: string };

/**
 * Pools → "New pool": name, slug, type and an optional first member (one of your served models).
 * Opens the new pool unless `onCreated` takes the result (Welcome stays on its step).
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
  const runtimes = useQuery({ ...orpc.runtimes.list.queryOptions(), enabled: open });
  const { create } = useCreatePool();
  const schema = z.object({
    name: z.string().trim().min(1, t("dashboard:pool.form.nameRequired")).max(120),
    slug: z.string().regex(SLUG_PATTERN, t("dashboard:pool.form.slugInvalid")),
    type: z.enum(MODEL_TYPES),
    member: z.string(),
  });
  const form = useForm({
    defaultValues: initial ?? { name: "", slug: "", type: "LLM" as ModelType, member: "" },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const member = parseMemberChoice(value.member);
      try {
        const pool = await create({
          name: value.name.trim(),
          slug: value.slug,
          type: value.type,
          ...(member ? { members: [member] } : {}),
        });
        toast.success(t("dashboard:pool.created"));
        onOpenChange(false);
        form.reset();
        if (onCreated) onCreated(pool);
        else await navigate({ to: "/$lang/pools/$poolId", params: { lang, poolId: pool.id } });
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
