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

import {
  type GuardedWizardLocalModel,
  minimumSelectedPhysicalContext,
  primarySurfaceIsSelectable,
  providerOrderAfterMove,
  providerOrderAfterToggle,
  recommendedPrimarySurface,
} from "@/lib/guarded-pool-wizard-validation";
import { orpc } from "@/utils/orpc";

type LocalModel = GuardedWizardLocalModel & {
  canonicalModelId: string;
};
const surfaces = ["OPENAI_CHAT_COMPLETIONS", "OPENAI_RESPONSES", "ANTHROPIC_MESSAGES"] as const;
export type LimitMode = "LIMITED" | "UNLIMITED";
export type MemberOverride = {
  concurrencyMode: LimitMode;
  concurrencyLimit: number;
  reservedSlots: number;
  borrowPolicy: "NEVER" | "WHEN_IDLE";
  waitBudgetMode: LimitMode;
  waitBudgetMs: number;
  contextCeilingMode: LimitMode;
  contextCeiling: number;
  contextMargin: number;
};

const defaultMemberOverride = (): MemberOverride => ({
  concurrencyMode: "LIMITED",
  concurrencyLimit: 1,
  reservedSlots: 0,
  borrowPolicy: "WHEN_IDLE",
  waitBudgetMode: "LIMITED",
  waitBudgetMs: 30_000,
  contextCeilingMode: "LIMITED",
  contextCeiling: 31_744,
  contextMargin: 1_024,
});
export function deriveMemberOverride(values: {
  memberConcurrencyLimit: number;
  reservedSlots: number;
  borrowPolicy: "NEVER" | "WHEN_IDLE";
  localWaitBudgetMs: number;
  memberContextCeiling: number;
  contextMargin: number;
}): MemberOverride {
  return {
    concurrencyMode: "LIMITED",
    concurrencyLimit: values.memberConcurrencyLimit,
    reservedSlots: values.reservedSlots,
    borrowPolicy: values.borrowPolicy,
    waitBudgetMode: "LIMITED",
    waitBudgetMs: values.localWaitBudgetMs,
    contextCeilingMode: "LIMITED",
    contextCeiling: values.memberContextCeiling,
    contextMargin: values.contextMargin,
  };
}
export function memberContextFitsPhysical(
  override: MemberOverride,
  physicalMaxContext: number | null | undefined,
) {
  return (
    override.contextCeilingMode === "UNLIMITED" ||
    physicalMaxContext == null ||
    override.contextCeiling + override.contextMargin <= physicalMaxContext
  );
}
export const budgetIntegerRule = (mode: LimitMode, value: string) =>
  mode === "LIMITED"
    ? ({ mode, limitValue: Number(value) } as const)
    : ({ mode, limitValue: null } as const);
export const budgetSpendRule = (mode: LimitMode, value: string) =>
  mode === "LIMITED"
    ? ({ mode, limitValue: value } as const)
    : ({ mode, limitValue: null } as const);

export function GuardedPoolSetupWizard({
  open,
  onOpenChange,
  directModels,
  initialStep = 0,
  initialProviderModelIds = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  directModels: LocalModel[];
  initialStep?: 0 | 1 | 2 | 3;
  initialProviderModelIds?: string[];
}) {
  const { t } = useTranslation(["common", "dashboard"]);
  const queryClient = useQueryClient();
  const formRef = useRef<HTMLFormElement>(null);
  const [step, setStep] = useState<number>(initialStep);
  const [stepErrors, setStepErrors] = useState<Record<string, string>>({});
  const [memberOverrides, setMemberOverrides] = useState<Record<string, MemberOverride>>({});
  const [enabledMemberOverrides, setEnabledMemberOverrides] = useState<Record<string, boolean>>({});
  const candidates = useQuery(
    orpc.forwarderManagement.listGuardedOverflowCandidates.queryOptions(),
  );
  const capacities = useQuery({
    ...orpc.capacityManagement.list.queryOptions(),
    retry: false,
  });
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
      memberConcurrencyLimit: z.number().int().min(1).max(10_000),
      memberContextCeiling: z.number().int().min(1).max(100_000_000),
      reservedSlots: z.number().int().min(0).max(10_000),
      localWaitBudgetMs: z.number().int().min(0).max(600_000),
      recommendedSurface: z.enum(surfaces),
      providerModelIds: z.array(z.string()).max(32),
      providerConcurrencyLimit: z.number().int().min(1).max(10_000),
      dailySpendLimit: z.string(),
      publicEgressAcknowledged: z.boolean(),
      physicalCountStrategy: z.enum([
        "TOKENIZER",
        "TEMPLATE_AWARE",
        "ENGINE_REPORTED",
        "CONSERVATIVE_ESTIMATE",
      ]),
      contextMargin: z.number().int().min(0).max(10_000_000),
      borrowPolicy: z.enum(["NEVER", "WHEN_IDLE"]),
      protocolAdaptationEnabled: z.boolean(),
      allowLossyDeveloperRoleCollapse: z.boolean(),
      affinityEnabled: z.boolean(),
      affinityTtlSeconds: z.number().int().min(60).max(604_800),
      affinityMaxRecords: z.number().int().min(100).max(100_000),
      affinityPrefixWeight: z.number().int().min(0).max(10_000),
      affinityConversationWeight: z.number().int().min(0).max(10_000),
      affinityConfirmedCacheWeight: z.number().int().min(0).max(10_000),
      affinityLoadPenaltyWeight: z.number().int().min(0).max(10_000),
      providerConcurrencyMode: z.enum(["LIMITED", "UNLIMITED"]),
      tokenAttemptMode: z.enum(["LIMITED", "UNLIMITED"]),
      tokenAttemptLimit: z.string(),
      tokenDayMode: z.enum(["LIMITED", "UNLIMITED"]),
      tokenDayLimit: z.string(),
      tokenMonthMode: z.enum(["LIMITED", "UNLIMITED"]),
      tokenMonthLimit: z.string(),
      tokenLifetimeMode: z.enum(["LIMITED", "UNLIMITED"]),
      tokenLifetimeLimit: z.string(),
      spendDayMode: z.enum(["LIMITED", "UNLIMITED"]),
      spendMonthMode: z.enum(["LIMITED", "UNLIMITED"]),
      spendMonthLimit: z.string(),
    })
    .superRefine((value, ctx) => {
      if (value.reservedSlots > value.memberConcurrencyLimit)
        ctx.addIssue({ code: "custom", path: ["reservedSlots"] });
      if (value.providerModelIds.length > 0 && !value.publicEgressAcknowledged)
        ctx.addIssue({ code: "custom", path: ["publicEgressAcknowledged"] });
      if (
        value.localModelIds.length > 0 &&
        !primarySurfaceIsSelectable(value.recommendedSurface, value.localModelIds, directModels)
      )
        ctx.addIssue({ code: "custom", path: ["recommendedSurface"] });
      const physicalMaximum = minimumSelectedPhysicalContext(
        value.localModelIds,
        directModels,
        capacities.data ?? [],
      );
      if (
        physicalMaximum != null &&
        value.memberContextCeiling + value.contextMargin > physicalMaximum
      )
        ctx.addIssue({ code: "custom", path: ["memberContextCeiling"] });
      for (const [mode, limit, path] of [
        [value.tokenAttemptMode, value.tokenAttemptLimit, "tokenAttemptLimit"],
        [value.tokenDayMode, value.tokenDayLimit, "tokenDayLimit"],
        [value.tokenMonthMode, value.tokenMonthLimit, "tokenMonthLimit"],
        [value.tokenLifetimeMode, value.tokenLifetimeLimit, "tokenLifetimeLimit"],
      ] as const) {
        if (mode === "LIMITED" && !/^[1-9]\d*$/.test(limit))
          ctx.addIssue({ code: "custom", path: [path] });
      }
      for (const [mode, limit, path] of [
        [value.spendDayMode, value.dailySpendLimit, "dailySpendLimit"],
        [value.spendMonthMode, value.spendMonthLimit, "spendMonthLimit"],
      ] as const) {
        if (
          mode === "LIMITED" &&
          (!/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(limit) || Number(limit) <= 0)
        )
          ctx.addIssue({ code: "custom", path: [path] });
      }
    });
  const form = useForm({
    defaultValues: {
      slug: "",
      name: "",
      localModelIds: [] as string[],
      memberConcurrencyLimit: 1,
      memberContextCeiling: 31_744,
      reservedSlots: 0,
      localWaitBudgetMs: 30_000,
      recommendedSurface: "OPENAI_RESPONSES" as (typeof surfaces)[number],
      providerModelIds: initialProviderModelIds,
      providerConcurrencyLimit: 1,
      dailySpendLimit: "10.00",
      publicEgressAcknowledged: false,
      physicalCountStrategy: "CONSERVATIVE_ESTIMATE" as
        | "TOKENIZER"
        | "TEMPLATE_AWARE"
        | "ENGINE_REPORTED"
        | "CONSERVATIVE_ESTIMATE",
      contextMargin: 1_024,
      borrowPolicy: "WHEN_IDLE" as "NEVER" | "WHEN_IDLE",
      protocolAdaptationEnabled: true,
      allowLossyDeveloperRoleCollapse: false,
      affinityEnabled: false,
      affinityTtlSeconds: 3_600,
      affinityMaxRecords: 10_000,
      affinityPrefixWeight: 100,
      affinityConversationWeight: 150,
      affinityConfirmedCacheWeight: 250,
      affinityLoadPenaltyWeight: 100,
      providerConcurrencyMode: "LIMITED" as LimitMode,
      tokenAttemptMode: "LIMITED" as LimitMode,
      tokenAttemptLimit: "100000",
      tokenDayMode: "LIMITED" as LimitMode,
      tokenDayLimit: "1000000",
      tokenMonthMode: "LIMITED" as LimitMode,
      tokenMonthLimit: "10000000",
      tokenLifetimeMode: "UNLIMITED" as LimitMode,
      tokenLifetimeLimit: "",
      spendDayMode: "LIMITED" as LimitMode,
      spendMonthMode: "LIMITED" as LimitMode,
      spendMonthLimit: "100",
    },
    validators: { onSubmit: schema },
    onSubmit: ({ value }) =>
      create.mutateAsync({
        slug: value.slug.trim(),
        name: value.name.trim(),
        localModelIds: value.localModelIds,
        recommendedSurface: value.recommendedSurface,
        memberConcurrencyLimit: value.memberConcurrencyLimit,
        memberContextCeiling: value.memberContextCeiling,
        reservedSlots: value.reservedSlots,
        localWaitBudgetMs: value.localWaitBudgetMs,
        publicEgressAcknowledged: value.publicEgressAcknowledged,
        advanced: {
          physicalCountStrategy: value.physicalCountStrategy,
          contextMargin: value.contextMargin,
          borrowPolicy: value.borrowPolicy,
          protocolAdaptationEnabled: value.protocolAdaptationEnabled,
          allowLossyDeveloperRoleCollapse: value.allowLossyDeveloperRoleCollapse,
          affinity: {
            enabled: value.affinityEnabled,
            ttlSeconds: value.affinityTtlSeconds,
            maxRecords: value.affinityMaxRecords,
            prefixWeight: value.affinityPrefixWeight,
            conversationWeight: value.affinityConversationWeight,
            confirmedCacheWeight: value.affinityConfirmedCacheWeight,
            loadPenaltyWeight: value.affinityLoadPenaltyWeight,
          },
          memberOverrides: value.localModelIds.flatMap((discoveredModelId) => {
            if (!enabledMemberOverrides[discoveredModelId]) return [];
            const override = memberOverrides[discoveredModelId] ?? deriveMemberOverride(value);
            const rule = (mode: LimitMode, limitValue: number) =>
              mode === "LIMITED"
                ? ({ mode, limitValue } as const)
                : ({ mode, limitValue: null } as const);
            return [
              {
                discoveredModelId,
                concurrency: rule(override.concurrencyMode, override.concurrencyLimit),
                reservedSlots: override.reservedSlots,
                borrowPolicy: override.borrowPolicy,
                waitBudget: rule(override.waitBudgetMode, override.waitBudgetMs),
                contextCeiling: rule(override.contextCeilingMode, override.contextCeiling),
                contextMargin: override.contextMargin,
              },
            ];
          }),
        },
        providerModels: value.providerModelIds.map((providerModelId) => ({
          providerModelId,
          concurrencyLimit: value.providerConcurrencyLimit,
          dailySpendLimit: value.dailySpendLimit,
          budgetRules: {
            concurrency:
              value.providerConcurrencyMode === "LIMITED"
                ? ({ mode: "LIMITED", limitValue: value.providerConcurrencyLimit } as const)
                : ({ mode: "UNLIMITED", limitValue: null } as const),
            tokensPerAttempt: budgetIntegerRule(value.tokenAttemptMode, value.tokenAttemptLimit),
            tokensPerDay: budgetIntegerRule(value.tokenDayMode, value.tokenDayLimit),
            tokensPerMonth: budgetIntegerRule(value.tokenMonthMode, value.tokenMonthLimit),
            tokensLifetime: budgetIntegerRule(value.tokenLifetimeMode, value.tokenLifetimeLimit),
            spendPerDay: budgetSpendRule(value.spendDayMode, value.dailySpendLimit),
            spendPerMonth: budgetSpendRule(value.spendMonthMode, value.spendMonthLimit),
          },
        })),
      }),
  });
  const stepFields = [
    ["slug", "name", "localModelIds"],
    [
      "memberConcurrencyLimit",
      "memberContextCeiling",
      "reservedSlots",
      "localWaitBudgetMs",
      "contextMargin",
      "affinityTtlSeconds",
      "affinityMaxRecords",
      "affinityPrefixWeight",
      "affinityConversationWeight",
      "affinityConfirmedCacheWeight",
      "affinityLoadPenaltyWeight",
      "memberOverrides",
    ],
    [
      "recommendedSurface",
      "providerModelIds",
      "providerConcurrencyLimit",
      "dailySpendLimit",
      "publicEgressAcknowledged",
      "tokenAttemptLimit",
      "tokenDayLimit",
      "tokenMonthLimit",
      "tokenLifetimeLimit",
      "spendMonthLimit",
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
    if (step === 1) {
      const invalidOverride = form.state.values.localModelIds.some((modelId) => {
        if (!enabledMemberOverrides[modelId]) return false;
        const override = memberOverrides[modelId] ?? defaultMemberOverride();
        return (
          (override.concurrencyMode === "LIMITED" && override.concurrencyLimit < 1) ||
          (override.waitBudgetMode === "LIMITED" && override.waitBudgetMs < 1) ||
          (override.contextCeilingMode === "LIMITED" && override.contextCeiling < 1) ||
          override.reservedSlots < 0 ||
          (override.concurrencyMode === "LIMITED" &&
            override.reservedSlots > override.concurrencyLimit) ||
          override.contextMargin < 0
        );
      });
      if (invalidOverride)
        errors.memberOverrides = t("dashboard:pools.wizard.errors.memberOverrides");
      for (const modelId of form.state.values.localModelIds) {
        if (!enabledMemberOverrides[modelId]) continue;
        const override = memberOverrides[modelId] ?? defaultMemberOverride();
        const model = directModels.find((candidate) => candidate.id === modelId);
        const capacity = capacities.data?.find(
          (item) => item.id === model?.executionTarget?.inferenceCapacityId,
        );
        if (!memberContextFitsPhysical(override, capacity?.physicalMaxContext))
          errors[`member-${modelId}-context`] = t(
            "dashboard:pools.wizard.errors.memberContextPhysical",
          );
      }
    }
    setStepErrors(errors);
    if (Object.keys(errors).length > 0) {
      requestAnimationFrame(() => focusFirstInvalidWizardField(formRef.current));
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
                        <label key={model.id} className="flex min-h-11 items-start gap-3 p-3">
                          <Checkbox
                            disabled={!model.executionTarget?.inferenceCapacityId}
                            checked={field.state.value.includes(model.id)}
                            onCheckedChange={(checked) =>
                              (() => {
                                const next =
                                  checked === true
                                    ? [...field.state.value, model.id]
                                    : field.state.value.filter((id) => id !== model.id);
                                field.handleChange(next);
                                const recommended = recommendedPrimarySurface(next, directModels);
                                if (recommended)
                                  form.setFieldValue("recommendedSurface", recommended);
                              })()
                            }
                          />
                          <span className="min-w-0 flex-1">
                            <code className="block break-all font-mono text-xs">
                              {model.canonicalModelId}
                            </code>
                            <span className="mt-1 block text-xs text-muted-foreground">
                              {(() => {
                                const capacity = capacities.data?.find(
                                  (item) => item.id === model.executionTarget?.inferenceCapacityId,
                                );
                                return capacity
                                  ? t("dashboard:pools.wizard.capacityAssignedDetail", {
                                      concurrency: String(capacity.hardConcurrencyLimit ?? "∞"),
                                      context: String(capacity.physicalMaxContext ?? "∞"),
                                      strategy: String(capacity.countStrategy),
                                    })
                                  : t("dashboard:pools.wizard.capacityRequired");
                              })()}
                            </span>
                          </span>
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
              <details className="rounded-xl border p-4">
                <summary className="min-h-11 cursor-pointer py-2 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {t("dashboard:pools.wizard.advanced.title")}
                </summary>
                <p className="mb-4 text-sm text-muted-foreground">
                  {t("dashboard:pools.wizard.advanced.capacityDescription")}
                </p>
                <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                  <form.Field name="physicalCountStrategy">
                    {(field) => (
                      <div className="min-w-0 space-y-2">
                        <Label htmlFor="guarded-physicalCountStrategy">
                          {t("dashboard:pools.wizard.fields.physicalCountStrategy")}
                        </Label>
                        <select
                          id="guarded-physicalCountStrategy"
                          className="h-11 w-full rounded-md border bg-background px-3 text-base sm:text-sm"
                          value={field.state.value}
                          onChange={(event) =>
                            field.handleChange(event.target.value as typeof field.state.value)
                          }
                        >
                          {[
                            "CONSERVATIVE_ESTIMATE",
                            "TOKENIZER",
                            "TEMPLATE_AWARE",
                            "ENGINE_REPORTED",
                          ].map((strategy) => (
                            <option key={strategy} value={strategy}>
                              {t(`dashboard:pools.wizard.enums.${strategy}`)}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                  </form.Field>
                  <form.Field name="borrowPolicy">
                    {(field) => (
                      <div className="min-w-0 space-y-2">
                        <Label htmlFor="guarded-borrowPolicy">
                          {t("dashboard:pools.wizard.fields.borrowPolicy")}
                        </Label>
                        <select
                          id="guarded-borrowPolicy"
                          className="h-11 w-full rounded-md border bg-background px-3 text-base sm:text-sm"
                          value={field.state.value}
                          onChange={(event) =>
                            field.handleChange(event.target.value as typeof field.state.value)
                          }
                        >
                          <option value="NEVER">{t("dashboard:pools.wizard.enums.NEVER")}</option>
                          <option value="WHEN_IDLE">
                            {t("dashboard:pools.wizard.enums.WHEN_IDLE")}
                          </option>
                        </select>
                      </div>
                    )}
                  </form.Field>
                  {(
                    [
                      "contextMargin",
                      "affinityTtlSeconds",
                      "affinityMaxRecords",
                      "affinityPrefixWeight",
                      "affinityConversationWeight",
                      "affinityConfirmedCacheWeight",
                      "affinityLoadPenaltyWeight",
                    ] as const
                  ).map((name) => (
                    <form.Field key={name} name={name}>
                      {(field) => (
                        <div className="min-w-0 space-y-2">
                          <Label htmlFor={`guarded-${name}`}>
                            {t(`dashboard:pools.wizard.fields.${name}`)}
                          </Label>
                          <Input
                            id={`guarded-${name}`}
                            className="min-h-11"
                            type="number"
                            min={name === "affinityTtlSeconds" ? 60 : 0}
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
                <div className="mt-4 space-y-3">
                  {(
                    [
                      "protocolAdaptationEnabled",
                      "allowLossyDeveloperRoleCollapse",
                      "affinityEnabled",
                    ] as const
                  ).map((name) => (
                    <form.Field key={name} name={name}>
                      {(field) => (
                        <label className="flex min-h-11 items-start gap-3 py-2">
                          <Checkbox
                            checked={field.state.value}
                            onCheckedChange={(checked) => field.handleChange(checked === true)}
                          />
                          <span className="text-sm">
                            {t(`dashboard:pools.wizard.fields.${name}`)}
                          </span>
                        </label>
                      )}
                    </form.Field>
                  ))}
                </div>
                <div
                  className="mt-5 min-w-0 space-y-4"
                  aria-invalid={Boolean(stepErrors.memberOverrides)}
                  aria-describedby={
                    stepErrors.memberOverrides ? "wizard-memberOverrides-error" : undefined
                  }
                  tabIndex={stepErrors.memberOverrides ? -1 : undefined}
                >
                  <h3 className="text-sm font-medium">
                    {t("dashboard:pools.wizard.advanced.memberOverrides")}
                  </h3>
                  {form.state.values.localModelIds.map((modelId) => {
                    const model = directModels.find((candidate) => candidate.id === modelId);
                    const override =
                      memberOverrides[modelId] ?? deriveMemberOverride(form.state.values);
                    return (
                      <MemberOverrideEditor
                        key={modelId}
                        modelId={modelId}
                        label={model?.canonicalModelId ?? modelId}
                        value={override}
                        enabled={Boolean(enabledMemberOverrides[modelId])}
                        contextError={stepErrors[`member-${modelId}-context`]}
                        onEnabled={(enabled) => {
                          setEnabledMemberOverrides((current) => ({
                            ...current,
                            [modelId]: enabled,
                          }));
                          if (enabled)
                            setMemberOverrides((current) => ({
                              ...current,
                              [modelId]: current[modelId] ?? override,
                            }));
                        }}
                        onChange={(next) =>
                          setMemberOverrides((current) => ({ ...current, [modelId]: next }))
                        }
                      />
                    );
                  })}
                  {stepErrors.memberOverrides ? (
                    <p id="wizard-memberOverrides-error" className="text-sm text-destructive">
                      {stepErrors.memberOverrides}
                    </p>
                  ) : null}
                </div>
              </details>
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
                      {...errorProps("recommendedSurface")}
                    >
                      {surfaces.map((surface) => (
                        <option key={surface} value={surface}>
                          {t(`dashboard:pools.wizard.surfaces.${surface}`)}
                        </option>
                      ))}
                    </select>
                    {stepErrors.recommendedSurface ? (
                      <p id="wizard-recommendedSurface-error" className="text-sm text-destructive">
                        {stepErrors.recommendedSurface}
                      </p>
                    ) : null}
                  </div>
                )}
              </form.Field>
              <form.Field name="providerModelIds">
                {(field) => (
                  <fieldset
                    className="space-y-2"
                    {...errorProps("providerModelIds")}
                    tabIndex={stepErrors.providerModelIds ? -1 : undefined}
                  >
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
                                  providerOrderAfterToggle(
                                    field.state.value,
                                    candidate.id,
                                    checked === true,
                                  ),
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
                                    field.handleChange(
                                      providerOrderAfterMove(field.state.value, order, -1),
                                    );
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
                                    field.handleChange(
                                      providerOrderAfterMove(field.state.value, order, 1),
                                    );
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
                    {stepErrors.providerModelIds ? (
                      <p id="wizard-providerModelIds-error" className="text-sm text-destructive">
                        {stepErrors.providerModelIds}
                      </p>
                    ) : null}
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
                                  min={name === "providerConcurrencyLimit" ? 1 : undefined}
                                  max={name === "providerConcurrencyLimit" ? 10_000 : undefined}
                                  step={name === "providerConcurrencyLimit" ? 1 : undefined}
                                  inputMode={name === "dailySpendLimit" ? "decimal" : undefined}
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
                      <details className="rounded-xl border border-amber-600/30 bg-background/60 p-3">
                        <summary className="min-h-11 cursor-pointer py-2 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          {t("dashboard:pools.wizard.advanced.budgetTitle")}
                        </summary>
                        <p className="mb-4 text-sm text-muted-foreground">
                          {t("dashboard:pools.wizard.advanced.budgetDescription")}
                        </p>
                        <form.Subscribe selector={(state) => state.values}>
                          {(values) => (
                            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                              <WizardBudgetRuleControl
                                id="guarded-budget-concurrency"
                                label={t("dashboard:pools.wizard.fields.budgetConcurrency")}
                                mode={values.providerConcurrencyMode}
                                value={String(values.providerConcurrencyLimit)}
                                onMode={(mode) =>
                                  form.setFieldValue("providerConcurrencyMode", mode)
                                }
                                onValue={(value) =>
                                  form.setFieldValue("providerConcurrencyLimit", Number(value))
                                }
                              />
                              {(
                                [
                                  ["tokenAttempt", "tokenAttemptMode", "tokenAttemptLimit", false],
                                  ["tokenDay", "tokenDayMode", "tokenDayLimit", false],
                                  ["tokenMonth", "tokenMonthMode", "tokenMonthLimit", false],
                                  [
                                    "tokenLifetime",
                                    "tokenLifetimeMode",
                                    "tokenLifetimeLimit",
                                    false,
                                  ],
                                  ["spendDay", "spendDayMode", "dailySpendLimit", true],
                                  ["spendMonth", "spendMonthMode", "spendMonthLimit", true],
                                ] as const
                              ).map(([label, modeName, valueName, decimal]) => (
                                <WizardBudgetRuleControl
                                  key={label}
                                  id={`guarded-budget-${label}`}
                                  label={t(`dashboard:pools.wizard.fields.${label}`)}
                                  mode={values[modeName]}
                                  value={String(values[valueName])}
                                  decimal={decimal}
                                  error={stepErrors[valueName]}
                                  onMode={(mode) => form.setFieldValue(modeName, mode)}
                                  onValue={(value) =>
                                    form.setFieldValue(
                                      valueName,
                                      value as (typeof values)[typeof valueName],
                                    )
                                  }
                                />
                              ))}
                            </div>
                          )}
                        </form.Subscribe>
                        <div className="mt-4 flex gap-3 rounded-md bg-amber-500/10 p-3">
                          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300" />
                          <p className="text-sm">
                            {t("dashboard:pools.wizard.advanced.budgetWarning")}
                          </p>
                        </div>
                      </details>
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

export function focusFirstInvalidWizardField(form: Pick<HTMLFormElement, "querySelector"> | null) {
  form?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
}

export function MemberOverrideEditor({
  modelId,
  label,
  value,
  onChange,
  enabled,
  onEnabled,
  contextError,
}: {
  modelId: string;
  label: string;
  value: MemberOverride;
  onChange: (value: MemberOverride) => void;
  enabled: boolean;
  onEnabled: (enabled: boolean) => void;
  contextError?: string;
}) {
  const { t } = useTranslation("dashboard");
  const safeId = modelId.replace(/[^a-zA-Z0-9_-]/g, "-");
  return (
    <details className="min-w-0 rounded-xl border p-3">
      <summary className="min-h-11 cursor-pointer break-all py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {label}
      </summary>
      <label className="mb-3 flex min-h-11 items-center gap-3">
        <Checkbox checked={enabled} onCheckedChange={(checked) => onEnabled(checked === true)} />
        <span className="text-sm">{t("pools.wizard.fields.enableMemberOverride")}</span>
      </label>
      {enabled ? (
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">
          <MemberLimitControl
            id={`${safeId}-concurrency`}
            label={t("pools.wizard.fields.memberConcurrencyOverride")}
            mode={value.concurrencyMode}
            value={value.concurrencyLimit}
            onMode={(mode) => onChange({ ...value, concurrencyMode: mode })}
            onValue={(limit) => onChange({ ...value, concurrencyLimit: limit })}
          />
          <MemberLimitControl
            id={`${safeId}-wait`}
            label={t("pools.wizard.fields.memberWaitOverride")}
            mode={value.waitBudgetMode}
            value={value.waitBudgetMs}
            onMode={(mode) => onChange({ ...value, waitBudgetMode: mode })}
            onValue={(limit) => onChange({ ...value, waitBudgetMs: limit })}
          />
          <MemberLimitControl
            id={`${safeId}-context`}
            label={t("pools.wizard.fields.memberContextOverride")}
            mode={value.contextCeilingMode}
            value={value.contextCeiling}
            error={contextError}
            onMode={(mode) => onChange({ ...value, contextCeilingMode: mode })}
            onValue={(limit) => onChange({ ...value, contextCeiling: limit })}
          />
          {(["reservedSlots", "contextMargin"] as const).map((name) => (
            <div key={name} className="min-w-0 space-y-2">
              <Label htmlFor={`${safeId}-${name}`}>
                {t(`pools.wizard.fields.member${name[0]!.toUpperCase()}${name.slice(1)}`)}
              </Label>
              <Input
                id={`${safeId}-${name}`}
                type="number"
                min={0}
                value={value[name]}
                onChange={(event) => onChange({ ...value, [name]: Number(event.target.value) })}
              />
            </div>
          ))}
          <div className="min-w-0 space-y-2">
            <Label htmlFor={`${safeId}-borrowPolicy`}>
              {t("pools.wizard.fields.memberBorrowPolicy")}
            </Label>
            <select
              id={`${safeId}-borrowPolicy`}
              className="h-11 w-full rounded-md border bg-background px-3 text-base sm:text-sm"
              value={value.borrowPolicy}
              onChange={(event) =>
                onChange({
                  ...value,
                  borrowPolicy: event.target.value as MemberOverride["borrowPolicy"],
                })
              }
            >
              <option value="NEVER">{t("pools.wizard.enums.NEVER")}</option>
              <option value="WHEN_IDLE">{t("pools.wizard.enums.WHEN_IDLE")}</option>
            </select>
          </div>
        </div>
      ) : null}
    </details>
  );
}

function MemberLimitControl({
  id,
  label,
  mode,
  value,
  onMode,
  onValue,
  error,
}: {
  id: string;
  label: string;
  mode: LimitMode;
  value: number;
  onMode: (mode: LimitMode) => void;
  onValue: (value: number) => void;
  error?: string;
}) {
  const { t } = useTranslation("dashboard");
  return (
    <div className="min-w-0 space-y-2">
      <Label htmlFor={`${id}-mode`}>{label}</Label>
      <select
        id={`${id}-mode`}
        className="h-11 w-full rounded-md border bg-background px-3 text-base sm:text-sm"
        value={mode}
        onChange={(event) => onMode(event.target.value as LimitMode)}
      >
        <option value="LIMITED">{t("pools.wizard.enums.LIMITED")}</option>
        <option value="UNLIMITED">{t("pools.wizard.enums.UNLIMITED")}</option>
      </select>
      {mode === "LIMITED" ? (
        <>
          <Input
            id={`${id}-value`}
            aria-label={`${label} ${t("pools.wizard.fields.limitValue")}`}
            type="number"
            min={1}
            value={value}
            onChange={(event) => onValue(Number(event.target.value))}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? `${id}-error` : undefined}
          />
          {error ? (
            <p id={`${id}-error`} className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          {t("pools.wizard.advanced.unlimitedWarning")}
        </p>
      )}
    </div>
  );
}

function WizardBudgetRuleControl({
  id,
  label,
  mode,
  value,
  onMode,
  onValue,
  decimal = false,
  error,
}: {
  id: string;
  label: string;
  mode: LimitMode;
  value: string;
  onMode: (mode: LimitMode) => void;
  onValue: (value: string) => void;
  decimal?: boolean;
  error?: string;
}) {
  const { t } = useTranslation("dashboard");
  const errorId = `${id}-error`;
  return (
    <div className="min-w-0 space-y-2 rounded-xl border p-3">
      <p className="text-sm font-medium">{label}</p>
      <Label htmlFor={`${id}-mode`}>{t("pools.wizard.fields.limitMode")}</Label>
      <select
        id={`${id}-mode`}
        className="h-11 w-full rounded-md border bg-background px-3 text-base sm:text-sm"
        value={mode}
        onChange={(event) => onMode(event.target.value as LimitMode)}
      >
        <option value="LIMITED">{t("pools.wizard.enums.LIMITED")}</option>
        <option value="UNLIMITED">{t("pools.wizard.enums.UNLIMITED")}</option>
      </select>
      {mode === "LIMITED" ? (
        <>
          <Label htmlFor={`${id}-value`}>{t("pools.wizard.fields.limitValue")}</Label>
          <Input
            id={`${id}-value`}
            type={decimal ? "text" : "number"}
            inputMode={decimal ? "decimal" : "numeric"}
            min={decimal ? undefined : 1}
            value={value}
            onChange={(event) => onValue(event.target.value)}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? errorId : undefined}
          />
          {error ? (
            <p id={errorId} className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
          {t("pools.wizard.advanced.unlimitedWarning")}
        </p>
      )}
    </div>
  );
}
