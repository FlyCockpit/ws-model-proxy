import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  AdvancedSection,
  FormActionBar,
  FormSection,
} from "@ws-model-proxy/ui/components/form-page";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { buttonVariants } from "@ws-model-proxy/ui/lib/button-variants";
import { toast } from "@ws-model-proxy/ui/lib/toast";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";
import { InlineRetry } from "@/components/inline-retry";
import { LabelledSelect } from "@/components/labelled-select";
import { PageHeading } from "@/components/page-stub";
import { RuntimeSpecFields } from "@/components/runtimes/runtime-spec-fields";
import { useAppForm } from "@/hooks/use-app-form";
import { rejectedDefinesWarning } from "@/lib/define-rejections";
import { focusField, focusFirstInvalid } from "@/lib/form-focus";
import { refusalText } from "@/lib/refusal-text";
import { fillTargets } from "@/lib/runtime-preset-fill";
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
  staticData: { pendingShape: "form" },
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
          {preset ? null : (
            <p className="text-sm text-muted-foreground">{t("dashboard:runtime.pickPresetHint")}</p>
          )}
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
  const formRef = useRef<HTMLFormElement>(null);
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
      note: z.string().max(500, t("dashboard:runtime.form.noteTooLong")),
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
    // Errors sit next to their fields; once React shows them, the first one gets focus (its
    // collapsed section opens).
    onSubmitInvalid: () => focusFirstInvalid(formRef.current),
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
        const rejected = rejectedDefinesWarning(t, result.define);
        if (rejected) toast.warning(rejected);
        await navigate({
          to: "/$lang/runtimes/$runtimeId",
          params: { lang, runtimeId: result.runtime.id },
        });
      } catch (error) {
        toast.error(refusalText(error, t("dashboard:runtime.createFailed")));
      }
    },
  });

  const basics = (kind: RuntimeKind) => (
    <FormSection
      id="runtime-basics"
      aria-label={t("dashboard:runtime.form.basics")}
      title={t("dashboard:runtime.form.basics")}
    >
      <form.Field name="name">
        {(field) => {
          const error = firstMessage(field.state.meta.errors);
          return (
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="runtime-name">{t("dashboard:runtime.form.name")}</Label>
              <Input
                id="runtime-name"
                className="h-11"
                value={field.state.value}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "runtime-name-error" : "runtime-name-hint"}
                onBlur={field.handleBlur}
                onChange={(event) => {
                  const previous = slugify(field.state.value);
                  field.handleChange(event.target.value);
                  const slug = form.getFieldValue("slug");
                  if (slug === "" || slug === previous)
                    form.setFieldValue("slug", slugify(event.target.value));
                }}
              />
              <form.Subscribe selector={(state) => state.values.slug}>
                {(slug) => (
                  <p id="runtime-name-hint" className="text-xs break-words text-muted-foreground">
                    {slug
                      ? t("dashboard:runtime.form.slugShown", { slug })
                      : t("dashboard:runtime.form.nameHint")}
                  </p>
                )}
              </form.Subscribe>
              {error ? (
                <p id="runtime-name-error" className="text-sm text-destructive">
                  {error}
                </p>
              ) : null}
            </div>
          );
        }}
      </form.Field>
      {kind === "ALWAYS_ON" ? (
        <form.Field name="nodeId">
          {(field) => {
            const error = firstMessage(field.state.meta.errors);
            const a11y = {
              invalid: error !== null,
              describedBy: error ? "runtime-node-error" : undefined,
            };
            return (
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor="runtime-node">{t("dashboard:runtime.form.node")}</Label>
                {nodes.isPending ? (
                  <Skeleton className="h-11 w-full" />
                ) : nodes.isSuccess ? (
                  <LabelledSelect
                    id="runtime-node"
                    value={field.state.value}
                    onValueChange={field.handleChange}
                    options={[
                      { value: "", label: t("dashboard:runtime.form.pickNode") },
                      ...nodes.data.nodes.map((node) => ({
                        value: node.id,
                        label: node.name ?? node.slug,
                      })),
                    ]}
                    {...a11y}
                  />
                ) : (
                  <>
                    <Input
                      id="runtime-node"
                      className="h-11 font-mono"
                      value={field.state.value}
                      aria-invalid={a11y.invalid || undefined}
                      aria-describedby={describe(a11y.describedBy, "runtime-node-hint")}
                      onChange={(event) => field.handleChange(event.target.value)}
                    />
                    <p id="runtime-node-hint" className="text-xs text-muted-foreground">
                      {t("dashboard:runtime.form.nodeIdHint")}
                    </p>
                  </>
                )}
                {error ? (
                  <p id="runtime-node-error" className="text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
              </div>
            );
          }}
        </form.Field>
      ) : null}
    </FormSection>
  );

  const nameAndNote = (
    <form.Subscribe selector={(state) => [state.values.slug, state.values.note] as const}>
      {([slug, note]) => (
        <AdvancedSection
          gridClassName="lg:grid-cols-1"
          title={t("dashboard:runtime.form.nameAndNote")}
          summary={[
            t("dashboard:runtime.form.summarySlug", { slug: slug || "—" }),
            note.trim()
              ? t("dashboard:runtime.form.summaryNote")
              : t("dashboard:runtime.form.summaryNoNote"),
          ].join(" · ")}
        >
          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            <form.Field name="slug">
              {(field) => {
                const error = firstMessage(field.state.meta.errors);
                return (
                  <div className="min-w-0 space-y-1.5">
                    <Label htmlFor="runtime-slug">{t("dashboard:runtime.form.slug")}</Label>
                    <Input
                      id="runtime-slug"
                      className="h-11 font-mono"
                      autoCapitalize="none"
                      spellCheck={false}
                      value={field.state.value}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={describe(
                        error ? "runtime-slug-error" : undefined,
                        "runtime-slug-hint",
                      )}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                    />
                    <p id="runtime-slug-hint" className="text-xs text-muted-foreground">
                      {t("dashboard:runtime.form.slugHint")}
                    </p>
                    {error ? (
                      <p id="runtime-slug-error" className="text-sm text-destructive">
                        {error}
                      </p>
                    ) : null}
                  </div>
                );
              }}
            </form.Field>
            <form.Field name="note">
              {(field) => (
                <div className="min-w-0 space-y-1.5">
                  <Label htmlFor="runtime-note">{t("dashboard:runtime.form.note")}</Label>
                  <Input
                    id="runtime-note"
                    className="h-11"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                    aria-invalid={field.state.meta.errors.length > 0 || undefined}
                    aria-describedby={
                      field.state.meta.errors.length > 0 ? "runtime-note-error" : undefined
                    }
                  />
                  {field.state.meta.errors.length > 0 ? (
                    <p id="runtime-note-error" className="text-sm text-destructive">
                      {t("dashboard:runtime.form.noteTooLong")}
                    </p>
                  ) : null}
                </div>
              )}
            </form.Field>
          </div>
        </AdvancedSection>
      )}
    </form.Subscribe>
  );

  const targets = fillTargets(preset.fill);

  return (
    <form
      ref={formRef}
      noValidate
      aria-labelledby="runtime-form-title"
      className="flex min-w-0 flex-col gap-8"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        form.handleSubmit();
      }}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <h2
          id="runtime-form-title"
          ref={revealOnMount}
          className="scroll-mt-4 text-lg font-semibold"
        >
          {t(`dashboard:runtime.presets.${preset.id}.title`)}
        </h2>
        {targets.length > 0 ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">{t("dashboard:runtime.form.fillTitle")}</span>
            {targets.map((target) => (
              <Button
                key={`${target.labelKey}-${target.target}`}
                type="button"
                variant="outline"
                size="touch"
                onClick={() => focusField(`runtime-spec-${target.target}`)}
              >
                {t(`dashboard:${target.labelKey}`)}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      <form.Subscribe selector={(state) => state.values.kind}>
        {(kind) => (
          <RuntimeSpecFields
            form={form}
            fields="spec"
            kind={kind}
            idPrefix="runtime-spec"
            basics={basics(kind)}
            advanced={nameAndNote}
            howItRunsSummary={t(`dashboard:runtime.kindChoice.${kind}.title`)}
            howItRuns={
              <form.Field name="kind">
                {(field) => (
                  <KindChoice
                    value={field.state.value}
                    serviceOnly={isService(preset)}
                    onChange={(next) => {
                      field.handleChange(next);
                      form.setFieldValue(
                        "spec",
                        switchEditorKind(form.getFieldValue("spec"), next),
                      );
                    }}
                  />
                )}
              </form.Field>
            }
          />
        )}
      </form.Subscribe>
      <form.Subscribe selector={(state) => state}>
        {({ isSubmitting, values }) => (
          <FormActionBar>
            {/* What will be created, before the actions (primary last). */}
            <div className="min-w-0 basis-full text-sm break-words text-muted-foreground sm:mr-auto sm:basis-0 sm:flex-1">
              <CreateSummary values={values} />
            </div>
            <Link
              to="/$lang/runtimes"
              params={{ lang }}
              className={buttonVariants({ variant: "outline", size: "touch" })}
            >
              {t("common:actions.cancel")}
            </Link>
            <Button type="submit" size="touch" disabled={isSubmitting}>
              {isSubmitting ? t("common:actions.saving") : t("dashboard:runtime.create")}
            </Button>
          </FormActionBar>
        )}
      </form.Subscribe>
    </form>
  );
}

function firstMessage(errors: Array<{ message?: string } | string | undefined>): string | null {
  for (const error of errors) {
    const message = typeof error === "string" ? error : error?.message;
    if (message) return message;
  }
  return null;
}

function describe(...ids: Array<string | undefined>): string | undefined {
  const list = ids.filter((id): id is string => id !== undefined);
  return list.length > 0 ? list.join(" ") : undefined;
}

/** What Create will make, in one line, and what comes after. */
function CreateSummary({
  values,
}: {
  values: { name: string; kind: RuntimeKind; spec: SpecEditorValues };
}) {
  const { t } = useTranslation(["dashboard"]);
  const { draft, tab } = values.spec;
  const what =
    tab === "json"
      ? t("dashboard:runtime.form.summaryJson")
      : values.kind === "ALWAYS_ON"
        ? draft.baseUrl
        : draft.serves
          ? [
              t(`dashboard:runtime.specForm.engines.${draft.engine}`),
              draft.models
                .map((model) => model.id)
                .filter(Boolean)
                .join(", "),
            ]
              .filter(Boolean)
              .join(" · ")
          : t("dashboard:runtime.specForm.service");
  return (
    <span className="flex min-w-0 flex-col">
      <span data-testid="runtime-create-summary" className="break-words text-foreground">
        {t("dashboard:runtime.form.willCreate", {
          name: values.name.trim() || t("dashboard:runtime.form.unnamed"),
          kind: t(`dashboard:runtime.kindChoice.${values.kind}.title`),
          what,
        })}
      </span>
      <span className="text-xs">
        {values.kind === "ALWAYS_ON"
          ? t("dashboard:runtime.form.nextAlwaysOn")
          : t("dashboard:runtime.form.nextStartable")}
      </span>
    </span>
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

/**
 * Brings a just-picked preset's form into view (on a phone it starts below the preset cards).
 * A module-level callback ref, so it runs once per mount, not on every render.
 */
function revealOnMount(element: HTMLElement | null) {
  element?.scrollIntoView?.({ block: "start" });
}
