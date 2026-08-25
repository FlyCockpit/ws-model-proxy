import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { validateForwarderPoolSlug } from "@ws-model-proxy/config/forwarder-identifiers";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Checkbox } from "@ws-model-proxy/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@ws-model-proxy/ui/components/dialog";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ShieldCheck } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { orpc } from "@/utils/orpc";

type LocalModel = { id: string; canonicalModelId: string };
const surfaces = ["OPENAI_CHAT_COMPLETIONS", "OPENAI_RESPONSES", "ANTHROPIC_MESSAGES"] as const;

export function GuardedPoolSetupWizard({
  open,
  onOpenChange,
  directModels,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  directModels: LocalModel[];
}) {
  const { t } = useTranslation(["common", "dashboard"]);
  const queryClient = useQueryClient();
  const formRef = useRef<HTMLFormElement>(null);
  const [step, setStep] = useState(0);
  const [stepErrors, setStepErrors] = useState<Record<string, string>>({});
  const candidates = useQuery(
    orpc.forwarderManagement.listGuardedOverflowCandidates.queryOptions(),
  );
  const create = useMutation(
    orpc.forwarderManagement.createGuardedModelPool.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() });
        toast.success(t("dashboard:pools.created"));
        setStep(0);
        onOpenChange(false);
      },
      onError: () => toast.error(t("dashboard:pools.wizard.atomicFailure")),
    }),
  );
  const schema = z
    .object({
      slug: z
        .string()
        .trim()
        .refine((value) => validateForwarderPoolSlug(value).ok),
      name: z.string().trim().min(1).max(120),
      localModelIds: z.array(z.string()).min(1),
      physicalConcurrencyLimit: z.number().int().min(1).max(10_000),
      physicalMaxContext: z.number().int().min(1).max(100_000_000),
      memberConcurrencyLimit: z.number().int().min(1).max(10_000),
      memberContextCeiling: z.number().int().min(1).max(100_000_000),
      reservedSlots: z.number().int().min(0).max(10_000),
      localWaitBudgetMs: z.number().int().min(0).max(600_000),
      recommendedSurface: z.enum(surfaces),
      providerModelIds: z.array(z.string()).max(32),
      providerConcurrencyLimit: z.number().int().min(1).max(10_000),
      dailySpendLimit: z
        .string()
        .regex(/^\d+(?:\.\d{1,9})?$/)
        .refine((value) => Number(value) > 0),
      publicEgressAcknowledged: z.boolean(),
    })
    .superRefine((value, ctx) => {
      if (value.reservedSlots > value.memberConcurrencyLimit)
        ctx.addIssue({ code: "custom", path: ["reservedSlots"] });
      if (value.memberContextCeiling > value.physicalMaxContext)
        ctx.addIssue({ code: "custom", path: ["memberContextCeiling"] });
      if (value.providerModelIds.length > 0 && !value.publicEgressAcknowledged)
        ctx.addIssue({ code: "custom", path: ["publicEgressAcknowledged"] });
    });
  const form = useForm({
    defaultValues: {
      slug: "",
      name: "",
      localModelIds: [] as string[],
      physicalConcurrencyLimit: 1,
      physicalMaxContext: 32_768,
      memberConcurrencyLimit: 1,
      memberContextCeiling: 31_744,
      reservedSlots: 0,
      localWaitBudgetMs: 30_000,
      recommendedSurface: "OPENAI_RESPONSES" as (typeof surfaces)[number],
      providerModelIds: [] as string[],
      providerConcurrencyLimit: 1,
      dailySpendLimit: "10.00",
      publicEgressAcknowledged: false,
    },
    validators: { onSubmit: schema },
    onSubmit: ({ value }) =>
      create.mutateAsync({
        slug: value.slug.trim(),
        name: value.name.trim(),
        localModelIds: value.localModelIds,
        recommendedSurface: value.recommendedSurface,
        physicalConcurrencyLimit: value.physicalConcurrencyLimit,
        physicalMaxContext: value.physicalMaxContext,
        memberConcurrencyLimit: value.memberConcurrencyLimit,
        memberContextCeiling: value.memberContextCeiling,
        reservedSlots: value.reservedSlots,
        localWaitBudgetMs: value.localWaitBudgetMs,
        publicEgressAcknowledged: value.publicEgressAcknowledged,
        providerModels: value.providerModelIds.map((providerModelId) => ({
          providerModelId,
          concurrencyLimit: value.providerConcurrencyLimit,
          dailySpendLimit: value.dailySpendLimit,
        })),
      }),
  });
  const stepFields = [
    ["slug", "name", "localModelIds"],
    [
      "physicalConcurrencyLimit",
      "physicalMaxContext",
      "memberConcurrencyLimit",
      "memberContextCeiling",
      "reservedSlots",
      "localWaitBudgetMs",
    ],
    [
      "recommendedSurface",
      "providerModelIds",
      "providerConcurrencyLimit",
      "dailySpendLimit",
      "publicEgressAcknowledged",
    ],
  ] as const;
  const validateStep = () => {
    const result = schema.safeParse(form.state.values);
    const relevant = new Set(stepFields[step] ?? []);
    const errors: Record<string, string> = {};
    if (!result.success) {
      for (const issue of result.error.issues) {
        const field = String(issue.path[0] ?? "");
        if (relevant.has(field as never))
          errors[field] = t(`dashboard:pools.wizard.errors.${field}`);
      }
    }
    setStepErrors(errors);
    if (Object.keys(errors).length > 0) {
      requestAnimationFrame(() =>
        formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus(),
      );
      return false;
    }
    return true;
  };
  const errorProps = (name: string) => ({
    "aria-invalid": Boolean(stepErrors[name]),
    "aria-describedby": stepErrors[name] ? `wizard-${name}-error` : undefined,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(92vh,56rem)] overflow-x-hidden overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("dashboard:pools.wizard.title")}</DialogTitle>
          <DialogDescription>{t("dashboard:pools.wizard.description")}</DialogDescription>
        </DialogHeader>
        <p className="text-sm font-medium" aria-live="polite">
          {t("dashboard:pools.wizard.step", { current: step + 1, total: 4 })}
        </p>
        <form
          ref={formRef}
          className="space-y-5"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (step < 3) {
              if (validateStep()) setStep((current) => current + 1);
            } else void form.handleSubmit();
          }}
        >
          {step === 0 ? (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                {(["slug", "name"] as const).map((name) => (
                  <form.Field key={name} name={name}>
                    {(field) => (
                      <div className="space-y-2">
                        <Label htmlFor={`guarded-${name}`}>{t(`dashboard:pools.${name}`)}</Label>
                        <Input
                          id={`guarded-${name}`}
                          className="min-h-11"
                          value={field.state.value}
                          onChange={(event) => field.handleChange(event.target.value)}
                          {...errorProps(name)}
                        />
                        {stepErrors[name] ? (
                          <p id={`wizard-${name}-error`} className="text-sm text-destructive">
                            {stepErrors[name]}
                          </p>
                        ) : null}
                      </div>
                    )}
                  </form.Field>
                ))}
              </div>
              <form.Field name="localModelIds">
                {(field) => (
                  <fieldset
                    className="space-y-2"
                    {...errorProps("localModelIds")}
                    tabIndex={stepErrors.localModelIds ? -1 : undefined}
                  >
                    <legend className="text-sm font-medium">
                      {t("dashboard:pools.wizard.localModels")}
                    </legend>
                    <div className="max-h-56 divide-y overflow-x-clip overflow-y-auto rounded-md border">
                      {directModels.map((model) => (
                        <label key={model.id} className="flex min-h-11 items-center gap-3 p-3">
                          <Checkbox
                            checked={field.state.value.includes(model.id)}
                            onCheckedChange={(checked) =>
                              field.handleChange(
                                checked === true
                                  ? [...field.state.value, model.id]
                                  : field.state.value.filter((id) => id !== model.id),
                              )
                            }
                          />
                          <code className="break-all font-mono text-xs">
                            {model.canonicalModelId}
                          </code>
                        </label>
                      ))}
                    </div>
                    {stepErrors.localModelIds ? (
                      <p id="wizard-localModelIds-error" className="text-sm text-destructive">
                        {stepErrors.localModelIds}
                      </p>
                    ) : null}
                  </fieldset>
                )}
              </form.Field>
            </div>
          ) : null}
          {step === 1 ? (
            <div className="space-y-4">
              <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
                {t("dashboard:pools.wizard.capacityDistinctHint")}
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                {(
                  [
                    "physicalConcurrencyLimit",
                    "physicalMaxContext",
                    "memberConcurrencyLimit",
                    "memberContextCeiling",
                    "reservedSlots",
                    "localWaitBudgetMs",
                  ] as const
                ).map((name) => (
                  <form.Field key={name} name={name}>
                    {(field) => (
                      <div className="space-y-2">
                        <Label htmlFor={`guarded-${name}`}>
                          {t(`dashboard:pools.wizard.fields.${name}`)}
                        </Label>
                        <Input
                          id={`guarded-${name}`}
                          className="min-h-11"
                          type="number"
                          min={name === "reservedSlots" || name === "localWaitBudgetMs" ? 0 : 1}
                          value={field.state.value}
                          onChange={(event) => field.handleChange(Number(event.target.value))}
                          {...errorProps(name)}
                        />
                        {stepErrors[name] ? (
                          <p id={`wizard-${name}-error`} className="text-sm text-destructive">
                            {stepErrors[name]}
                          </p>
                        ) : null}
                      </div>
                    )}
                  </form.Field>
                ))}
              </div>
            </div>
          ) : null}
          {step === 2 ? (
            <div className="space-y-4">
              <form.Field name="recommendedSurface">
                {(field) => (
                  <div className="space-y-2">
                    <Label htmlFor="guarded-surface">
                      {t("dashboard:pools.wizard.fields.recommendedSurface")}
                    </Label>
                    <select
                      id="guarded-surface"
                      className="h-11 w-full rounded-md border bg-background px-3 text-sm"
                      value={field.state.value}
                      onChange={(event) =>
                        field.handleChange(event.target.value as typeof field.state.value)
                      }
                    >
                      {surfaces.map((surface) => (
                        <option key={surface} value={surface}>
                          {t(`dashboard:pools.wizard.surfaces.${surface}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </form.Field>
              <form.Field name="providerModelIds">
                {(field) => (
                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium">
                      {t("dashboard:pools.wizard.providerOrder")}
                    </legend>
                    <p className="text-sm text-muted-foreground">
                      {t("dashboard:pools.wizard.providerOrderExact")}
                    </p>
                    <div className="divide-y rounded-md border">
                      {candidates.data?.map((candidate) => {
                        const order = field.state.value.indexOf(candidate.id);
                        return (
                          <div key={candidate.id} className="flex min-h-11 items-center gap-3 p-3">
                            <Checkbox
                              checked={order >= 0}
                              onCheckedChange={(checked) =>
                                field.handleChange(
                                  checked === true
                                    ? [...field.state.value, candidate.id]
                                    : field.state.value.filter((id) => id !== candidate.id),
                                )
                              }
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block text-sm font-medium">
                                {candidate.displayName ?? candidate.upstreamModelId}
                              </span>
                              <span className="block text-xs text-muted-foreground">
                                {candidate.providerAccount.label} · {candidate.pricing.currency}
                              </span>
                            </span>
                            {order >= 0 ? (
                              <span className="flex gap-1">
                                <Button
                                  type="button"
                                  size="icon-touch"
                                  variant="ghost"
                                  disabled={order === 0}
                                  aria-label={t("dashboard:pools.wizard.moveProviderUp")}
                                  onClick={() => {
                                    const next = [...field.state.value];
                                    [next[order - 1], next[order]] = [
                                      next[order]!,
                                      next[order - 1]!,
                                    ];
                                    field.handleChange(next);
                                  }}
                                >
                                  <ArrowUp className="size-4" />
                                </Button>
                                <Button
                                  type="button"
                                  size="icon-touch"
                                  variant="ghost"
                                  disabled={order === field.state.value.length - 1}
                                  aria-label={t("dashboard:pools.wizard.moveProviderDown")}
                                  onClick={() => {
                                    const next = [...field.state.value];
                                    [next[order], next[order + 1]] = [
                                      next[order + 1]!,
                                      next[order]!,
                                    ];
                                    field.handleChange(next);
                                  }}
                                >
                                  <ArrowDown className="size-4" />
                                </Button>
                              </span>
                            ) : null}
                          </div>
                        );
                      })}
                      {!candidates.data?.length ? (
                        <p className="p-3 text-sm text-muted-foreground">
                          {t("dashboard:pools.wizard.noReadyProviders")}
                        </p>
                      ) : null}
                    </div>
                  </fieldset>
                )}
              </form.Field>
              <form.Subscribe selector={(state) => state.values.providerModelIds.length}>
                {(count) =>
                  count > 0 ? (
                    <div className="space-y-4 rounded-md bg-amber-500/10 p-4 text-amber-950 dark:text-amber-50">
                      <p className="text-sm">{t("dashboard:pools.wizard.egressWarning")}</p>
                      <div className="grid gap-4 sm:grid-cols-2">
                        {(["providerConcurrencyLimit", "dailySpendLimit"] as const).map((name) => (
                          <form.Field key={name} name={name}>
                            {(field) => (
                              <div className="space-y-2">
                                <Label htmlFor={`guarded-${name}`}>
                                  {t(`dashboard:pools.wizard.fields.${name}`)}
                                </Label>
                                <Input
                                  id={`guarded-${name}`}
                                  className="min-h-11"
                                  type={name === "providerConcurrencyLimit" ? "number" : "text"}
                                  value={field.state.value}
                                  onChange={(event) =>
                                    field.handleChange(
                                      name === "providerConcurrencyLimit"
                                        ? Number(event.target.value)
                                        : event.target.value,
                                    )
                                  }
                                  {...errorProps(name)}
                                />
                                {stepErrors[name] ? (
                                  <p
                                    id={`wizard-${name}-error`}
                                    className="text-sm text-destructive"
                                  >
                                    {stepErrors[name]}
                                  </p>
                                ) : null}
                              </div>
                            )}
                          </form.Field>
                        ))}
                      </div>
                      <form.Field name="publicEgressAcknowledged">
                        {(field) => (
                          <label
                            className="flex min-h-11 items-start gap-3"
                            {...errorProps("publicEgressAcknowledged")}
                          >
                            <Checkbox
                              checked={field.state.value}
                              onCheckedChange={(checked) => field.handleChange(checked === true)}
                            />
                            <span className="text-sm">
                              {t("dashboard:pools.wizard.fields.publicEgressAcknowledged")}
                            </span>
                          </label>
                        )}
                      </form.Field>
                      {stepErrors.publicEgressAcknowledged ? (
                        <p
                          id="wizard-publicEgressAcknowledged-error"
                          className="text-sm text-destructive"
                        >
                          {stepErrors.publicEgressAcknowledged}
                        </p>
                      ) : null}
                    </div>
                  ) : null
                }
              </form.Subscribe>
            </div>
          ) : null}
          {step === 3 ? (
            <form.Subscribe selector={(state) => state.values}>
              {(values) => (
                <div className="space-y-4">
                  <div className="flex gap-3 rounded-md bg-primary/10 p-4 text-sm">
                    <ShieldCheck className="size-5 shrink-0 text-primary" />
                    <p>
                      {t("dashboard:pools.wizard.atomicReview", {
                        local: values.localModelIds.length,
                        providers: values.providerModelIds.length,
                        spend: values.dailySpendLimit,
                      })}
                    </p>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {t("dashboard:pools.wizard.atomicRollback")}
                  </p>
                </div>
              )}
            </form.Subscribe>
          ) : null}
          <DialogFooter className="gap-2 sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              size="touch"
              disabled={step === 0 || create.isPending}
              onClick={() => {
                setStepErrors({});
                setStep((current) => Math.max(0, current - 1));
              }}
            >
              <ArrowLeft className="size-4" />
              {t("dashboard:pools.wizard.back")}
            </Button>
            <Button
              type="submit"
              size="touch"
              disabled={create.isPending || directModels.length === 0}
            >
              {step === 3 ? (
                create.isPending ? (
                  t("common:actions.saving")
                ) : (
                  t("dashboard:pools.wizard.create")
                )
              ) : (
                <>
                  {t("dashboard:pools.wizard.next")}
                  <ArrowRight className="size-4" />
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
