import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { runtimeSpecSchema } from "@ws-model-proxy/api/lib/runtime-spec";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
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
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Textarea } from "@ws-model-proxy/ui/components/textarea";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { FieldErrors } from "@/components/field-errors";
import { InlineRetry } from "@/components/inline-retry";
import { NativeSelect } from "@/components/native-select";
import { PageHeading } from "@/components/page-stub";
import { refusalText } from "@/lib/refusal-text";
import { SLUG_PATTERN, slugify } from "@/lib/slugify";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_auth/_app/runtimes/new")({
  component: NewRuntimePage,
});

type Preset = Awaited<
  ReturnType<AppRouterClient["runtimes"]["presets"]["list"]>
>["presets"][number];

function NewRuntimePage() {
  const { t } = useTranslation(["dashboard", "common"]);
  const presets = useQuery(orpc.runtimes.presets.list.queryOptions());
  const [preset, setPreset] = useState<Preset | null>(null);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeading page="runtimeNew" />
      {presets.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2" aria-hidden="true">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      ) : presets.isError ? (
        <InlineRetry
          message={t("dashboard:runtime.presetsFailed")}
          onRetry={() => presets.refetch()}
        />
      ) : (
        <section className="flex min-w-0 flex-col gap-3">
          <h2 className="text-lg font-semibold">{t("dashboard:runtime.pickPreset")}</h2>
          <ul className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {presets.data.presets.map((option) => (
              <li key={option.id}>
                <button
                  type="button"
                  aria-pressed={preset?.id === option.id}
                  onClick={() => setPreset(option)}
                  className={cn(
                    "flex min-h-11 w-full flex-col items-start gap-1 rounded-xl border p-4 text-left",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    preset?.id === option.id ? "border-primary bg-muted" : "hover:bg-muted/50",
                  )}
                >
                  <span className="font-medium">
                    {t(`dashboard:runtime.presets.${option.id}.title`)}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {t(`dashboard:runtime.presets.${option.id}.hint`)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {preset ? <RuntimeForm key={preset.id} preset={preset} /> : null}
    </div>
  );
}

function RuntimeForm({ preset }: { preset: Preset }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const { lang } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const alwaysOn = preset.kind === "ALWAYS_ON";
  const nodes = useQuery({ ...orpc.nodes.list.queryOptions(), enabled: alwaysOn, retry: false });
  const create = useMutation({
    ...orpc.runtimes.create.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });

  const schema = z.object({
    name: z.string().trim().min(1, t("dashboard:runtime.form.nameRequired")).max(120),
    slug: z
      .string()
      .regex(SLUG_PATTERN, t("dashboard:pool.form.slugInvalid"))
      .refine((slug) => !/^i-[a-z0-9]{12}$/.test(slug), t("dashboard:runtime.form.slugReserved")),
    nodeId: alwaysOn
      ? z.string().trim().min(1, t("dashboard:runtime.form.nodeRequired"))
      : z.string(),
    spec: z.string().superRefine((text, ctx) => {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        ctx.addIssue({ code: "custom", message: t("dashboard:runtime.form.specNotJson") });
        return;
      }
      const parsed = runtimeSpecSchema.safeParse(value);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        ctx.addIssue({
          code: "custom",
          message: t("dashboard:runtime.form.specInvalid", {
            path: issue?.path.join(".") || "spec",
            detail: issue?.message ?? "",
          }),
        });
      }
    }),
    note: z.string().max(500),
  });

  const form = useForm({
    defaultValues: {
      name: "",
      slug: "",
      nodeId: "",
      spec: JSON.stringify(preset.spec, null, 2),
      note: "",
    },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const spec = runtimeSpecSchema.parse(JSON.parse(value.spec));
      try {
        const result = await create.mutateAsync({
          slug: value.slug,
          name: value.name.trim(),
          kind: preset.kind,
          preset: preset.id,
          spec,
          ...(alwaysOn ? { nodeId: value.nodeId.trim() } : {}),
          ...(value.note.trim() ? { note: value.note.trim() } : {}),
        });
        await queryClient.invalidateQueries({ queryKey: orpc.runtimes.key() });
        toast.success(t("dashboard:runtime.created"));
        if (result.warnings.includes("binds_all_interfaces"))
          toast.warning(t("dashboard:runtime.bindsAllInterfaces"));
        await navigate({
          to: "/$lang/runtimes/$runtimeId",
          params: { lang, runtimeId: result.runtime.id },
        });
      } catch (error) {
        toast.error(refusalText(error, t("dashboard:runtime.createFailed")));
      }
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {t(`dashboard:runtime.presets.${preset.id}.title`)}
        </CardTitle>
        <CardDescription>
          {preset.fill.length > 0
            ? t("dashboard:runtime.form.fill", { fields: preset.fill.join(", ") })
            : null}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            form.handleSubmit();
          }}
        >
          <form.Field name="name">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor="runtime-name">{t("dashboard:runtime.form.name")}</Label>
                <Input
                  id="runtime-name"
                  className="h-11"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => {
                    const previous = slugify(field.state.value);
                    field.handleChange(event.target.value);
                    const slug = form.getFieldValue("slug");
                    if (slug === "" || slug === previous)
                      form.setFieldValue("slug", slugify(event.target.value));
                  }}
                />
                <FieldErrors field={field} />
              </div>
            )}
          </form.Field>
          <form.Field name="slug">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor="runtime-slug">{t("dashboard:runtime.form.slug")}</Label>
                <Input
                  id="runtime-slug"
                  className="h-11 font-mono"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldErrors field={field} />
              </div>
            )}
          </form.Field>
          {alwaysOn ? (
            <form.Field name="nodeId">
              {(field) => (
                <div className="space-y-1.5">
                  <Label htmlFor="runtime-node">{t("dashboard:runtime.form.node")}</Label>
                  {nodes.isPending ? (
                    <Skeleton className="h-11 w-full" />
                  ) : nodes.isSuccess ? (
                    <NativeSelect
                      id="runtime-node"
                      value={field.state.value}
                      onChange={(event) => field.handleChange(event.target.value)}
                    >
                      <option value="">{t("dashboard:runtime.form.pickNode")}</option>
                      {nodes.data.nodes.map((node) => (
                        <option key={node.id} value={node.id}>
                          {node.name ?? node.slug}
                        </option>
                      ))}
                    </NativeSelect>
                  ) : (
                    <>
                      <Input
                        id="runtime-node"
                        className="h-11 font-mono"
                        value={field.state.value}
                        onChange={(event) => field.handleChange(event.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        {t("dashboard:runtime.form.nodeIdHint")}
                      </p>
                    </>
                  )}
                  <FieldErrors field={field} />
                </div>
              )}
            </form.Field>
          ) : null}
          <form.Field name="spec">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor="runtime-spec">{t("dashboard:runtime.form.spec")}</Label>
                <Textarea
                  id="runtime-spec"
                  rows={18}
                  spellCheck={false}
                  className="font-mono text-xs"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t("dashboard:runtime.form.specHint")}
                </p>
                <FieldErrors field={field} />
              </div>
            )}
          </form.Field>
          <form.Field name="note">
            {(field) => (
              <div className="space-y-1.5">
                <Label htmlFor="runtime-note">{t("dashboard:runtime.form.note")}</Label>
                <Input
                  id="runtime-note"
                  className="h-11"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </div>
            )}
          </form.Field>
          <form.Subscribe selector={(state) => state.isSubmitting}>
            {(submitting) => (
              <Button type="submit" size="touch" disabled={submitting}>
                {submitting ? t("common:actions.saving") : t("dashboard:runtime.create")}
              </Button>
            )}
          </form.Subscribe>
        </form>
      </CardContent>
    </Card>
  );
}
