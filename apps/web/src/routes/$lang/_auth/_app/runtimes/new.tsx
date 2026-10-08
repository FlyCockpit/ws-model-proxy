import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
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
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { FieldErrors } from "@/components/field-errors";
import { InlineRetry } from "@/components/inline-retry";
import { NativeSelect } from "@/components/native-select";
import { PageHeading } from "@/components/page-stub";
import { RuntimeSpecFields } from "@/components/runtimes/runtime-spec-fields";
import { useAppForm } from "@/hooks/use-app-form";
import { refusalText } from "@/lib/refusal-text";
import {
  editorValues,
  type RuntimeKind,
  readSpecEditor,
  type SpecEditorValues,
  switchEditorKind,
} from "@/lib/runtime-spec-draft";
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

/** A service (no models) is startable only: wsmp cannot connect to it as a server. */
function isService(preset: Preset): boolean {
  return preset.spec.models === undefined && preset.spec.address === undefined;
}

function RuntimeForm({ preset }: { preset: Preset }) {
  const { t } = useTranslation(["dashboard", "common"]);
  const { lang } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const nodes = useQuery({ ...orpc.nodes.list.queryOptions(), retry: false });
  const create = useMutation({
    ...orpc.runtimes.create.mutationOptions(),
    meta: { skipGlobalErrorToast: true },
  });
  const messages = (kind: RuntimeKind) => ({
    notJson: t("dashboard:runtime.form.specNotJson"),
    wrongKind: t(`dashboard:runtime.specForm.wrongKind.${kind}`),
  });

  const schema = z
    .object({
      name: z.string().trim().min(1, t("dashboard:runtime.form.nameRequired")).max(120),
      slug: z
        .string()
        .regex(SLUG_PATTERN, t("dashboard:pool.form.slugInvalid"))
        .refine((slug) => !/^i-[a-z0-9]{12}$/.test(slug), t("dashboard:runtime.form.slugReserved")),
      kind: z.enum(["ALWAYS_ON", "STARTABLE"]),
      nodeId: z.string(),
      spec: z.custom<SpecEditorValues>(),
      note: z.string().max(500),
    })
    .superRefine((value, ctx) => {
      if (value.kind === "ALWAYS_ON" && value.nodeId.trim() === "")
        ctx.addIssue({
          code: "custom",
          path: ["nodeId"],
          message: t("dashboard:runtime.form.nodeRequired"),
        });
      const reading = readSpecEditor(value.spec, value.kind, messages(value.kind));
      if (!reading.ok)
        for (const issue of reading.issues)
          ctx.addIssue({ code: "custom", path: ["spec", ...issue.path], message: issue.message });
    });

  const form = useAppForm({
    defaultValues: {
      name: "",
      slug: "",
      kind: preset.kind as RuntimeKind,
      nodeId: "",
      spec: editorValues(preset.spec),
      note: "",
    },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const reading = readSpecEditor(value.spec, value.kind, messages(value.kind));
      if (!reading.ok) return;
      const alwaysOn = value.kind === "ALWAYS_ON";
      try {
        const result = await create.mutateAsync({
          slug: value.slug,
          name: value.name.trim(),
          kind: value.kind,
          preset: preset.id,
          spec: reading.spec,
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
          <form.Field name="kind">
            {(field) => (
              <KindChoice
                value={field.state.value}
                serviceOnly={isService(preset)}
                onChange={(kind) => {
                  field.handleChange(kind);
                  form.setFieldValue("spec", switchEditorKind(form.getFieldValue("spec"), kind));
                }}
              />
            )}
          </form.Field>
          <form.Subscribe selector={(state) => state.values.kind}>
            {(kind) => (
              <>
                {kind === "ALWAYS_ON" ? (
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
                <RuntimeSpecFields form={form} fields="spec" kind={kind} idPrefix="runtime-spec" />
              </>
            )}
          </form.Subscribe>
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

/**
 * Always-on or startable (owner decision: until servers are detected automatically, always-on
 * is how a person adds a server they already run). wsmp never starts or stops an always-on one.
 */
function KindChoice({
  value,
  serviceOnly,
  onChange,
}: {
  value: RuntimeKind;
  serviceOnly: boolean;
  onChange: (kind: RuntimeKind) => void;
}) {
  const { t } = useTranslation(["dashboard"]);
  const options: RuntimeKind[] = ["ALWAYS_ON", "STARTABLE"];
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">
        {t("dashboard:runtime.kindChoice.label")}
      </legend>
      <div className="grid min-w-0 gap-2 sm:grid-cols-2">
        {options.map((kind) => {
          const disabled = kind === "ALWAYS_ON" && serviceOnly;
          return (
            <label
              key={kind}
              className={cn(
                "flex min-h-11 min-w-0 cursor-pointer items-start gap-3 rounded-xl border p-4",
                "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                value === kind ? "border-primary bg-muted" : "hover:bg-muted/50",
                disabled && "cursor-not-allowed opacity-60",
              )}
            >
              <input
                type="radio"
                name="runtime-kind"
                value={kind}
                className="mt-1 size-4 shrink-0 accent-primary"
                checked={value === kind}
                disabled={disabled}
                onChange={() => onChange(kind)}
              />
              <span className="flex min-w-0 flex-col gap-1">
                <span className="font-medium">
                  {t(`dashboard:runtime.kindChoice.${kind}.title`)}
                </span>
                <span className="text-sm text-muted-foreground">
                  {disabled
                    ? t("dashboard:runtime.kindChoice.serviceStartable")
                    : t(`dashboard:runtime.kindChoice.${kind}.hint`)}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
