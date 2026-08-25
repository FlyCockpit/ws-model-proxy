import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type OpenAiCompatibleCapabilities,
  parseOpenAiCompatibleCapabilities,
} from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import {
  AlertTriangle,
  KeyRound,
  Plus,
  Power,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Wrench,
} from "lucide-react";
import {
  cloneElement,
  type FormEvent,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { InlineRetry } from "@/components/inline-retry";
import { WideContent } from "@/components/wide-content";
import { orpc } from "@/utils/orpc";

const showValue = (value: unknown) => (value === null || value === undefined ? "—" : String(value));

export const providerAccountFormSchema = z.object({
  providerType: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z][a-z0-9_-]{0,63}$/u, "providerType"),
  label: z.string().trim().min(1, "required").max(120, "tooLong"),
  baseUrl: z
    .string()
    .url("url")
    .max(2048, "tooLong")
    .refine((value) => value.startsWith("https://"), "httpsUrl"),
  authType: z.enum(["API_KEY", "BEARER"]),
});
const credentialFormSchema = z.object({
  credential: z.string().min(1, "required").max(16_384, "tooLong"),
});
const createModelFormSchema = z.object({
  upstreamModelId: z.string().trim().min(1, "required").max(255, "tooLong"),
  displayName: z.string().trim().max(255, "tooLong"),
  nativeSurface: z.enum([
    "OPENAI_CHAT_COMPLETIONS",
    "OPENAI_RESPONSES",
    "ANTHROPIC_MESSAGES",
    "OPENAI_COMPLETIONS",
  ]),
  streaming: z.boolean(),
  anthropicVersion: z.string().trim().min(1, "required").max(64, "tooLong"),
  betaFeatures: z.string().max(4096, "tooLong"),
});

type ProviderNativeSurface = z.infer<typeof createModelFormSchema>["nativeSurface"];

export function providerCapabilityInventory(input: {
  nativeSurface: ProviderNativeSurface;
  streaming: boolean;
  anthropicVersion: string;
  betaFeatures: string;
}): OpenAiCompatibleCapabilities {
  const common = { source: "dashboard" as const, confidence: "exact" as const };
  if (input.nativeSurface === "ANTHROPIC_MESSAGES") {
    const betaFeatures = [
      ...new Set(
        input.betaFeatures
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean),
      ),
    ];
    return {
      version: 4 as const,
      protocol: "anthropic-compatible" as const,
      surfaces: {
        anthropicMessages: {
          ...common,
          operations: ["create", "countTokens"],
          streaming: input.streaming,
          protocolVersions: [{ version: input.anthropicVersion, betaFeatures }],
        },
      },
    };
  }
  const surface = { ...common, operations: ["create"], streaming: input.streaming };
  const inventory = {
    version: 4 as const,
    protocol: "openai-compatible" as const,
    surfaces:
      input.nativeSurface === "OPENAI_RESPONSES"
        ? { openaiResponses: surface }
        : input.nativeSurface === "OPENAI_COMPLETIONS"
          ? { openaiCompletions: surface }
          : { openaiChatCompletions: surface },
  };
  const parsed = parseOpenAiCompatibleCapabilities(inventory);
  if (!parsed) throw new Error("Invalid provider capability inventory");
  return parsed;
}

function capabilitySummary(value: unknown): string | null {
  const parsed = parseOpenAiCompatibleCapabilities(value);
  if (!parsed) return null;
  if (parsed.version !== 4) return `v${parsed.version}`;
  return Object.entries(parsed.surfaces)
    .filter(([, surface]) => surface)
    .map(([name, surface]) => `${name}: ${(surface?.operations ?? []).join(", ")}`)
    .join(" · ");
}
const optionalPositiveInteger = z.union([
  z.literal(""),
  z.string().regex(/^[1-9]\d*$/u, "positiveInteger"),
]);
const updateModelFormSchema = z.object({
  displayName: z.string().trim().max(255, "tooLong"),
  contextWindow: optionalPositiveInteger,
  maxOutputTokens: optionalPositiveInteger,
  concurrencyLimit: optionalPositiveInteger,
});
const moneyRateSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/u, "money");
const pricingFormSchema = z.object({
  version: z.string().trim().min(1, "required").max(128, "tooLong"),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/u, "currency"),
  input: moneyRateSchema,
  output: moneyRateSchema,
});
export const providerBudgetFormSchema = z
  .object({
    concurrencyMode: z.enum(["LIMITED", "UNLIMITED"]),
    concurrency: optionalPositiveInteger,
    tokenAttemptMode: z.enum(["LIMITED", "UNLIMITED"]),
    tokenAttempt: optionalPositiveInteger,
    tokenDayMode: z.enum(["LIMITED", "UNLIMITED"]),
    tokenDay: optionalPositiveInteger,
    tokenMonthMode: z.enum(["LIMITED", "UNLIMITED"]),
    tokenMonth: optionalPositiveInteger,
    tokenLifetimeMode: z.enum(["LIMITED", "UNLIMITED"]),
    tokenLifetime: optionalPositiveInteger,
    spendDayMode: z.enum(["LIMITED", "UNLIMITED"]),
    spendDay: z.union([z.literal(""), moneyRateSchema]),
    spendMonthMode: z.enum(["LIMITED", "UNLIMITED"]),
    spendMonth: z.union([z.literal(""), moneyRateSchema]),
  })
  .superRefine((value, context) => {
    for (const [mode, limit, path] of [
      [value.concurrencyMode, value.concurrency, "concurrency"],
      [value.tokenAttemptMode, value.tokenAttempt, "tokenAttempt"],
      [value.tokenDayMode, value.tokenDay, "tokenDay"],
      [value.tokenMonthMode, value.tokenMonth, "tokenMonth"],
      [value.tokenLifetimeMode, value.tokenLifetime, "tokenLifetime"],
      [value.spendDayMode, value.spendDay, "spendDay"],
      [value.spendMonthMode, value.spendMonth, "spendMonth"],
    ] as const) {
      if (mode === "LIMITED" && (!limit || Number(limit) <= 0))
        context.addIssue({ code: "custom", message: "positiveRequired", path: [path] });
    }
  });

export function focusFirstInvalidProviderField(form: HTMLFormElement | null) {
  const invalid = form?.querySelector<HTMLElement>('[aria-invalid="true"]');
  invalid?.focus();
}

type ProviderBudgetValues = {
  concurrencyMode: "LIMITED" | "UNLIMITED";
  concurrency: string;
  tokenAttemptMode: "LIMITED" | "UNLIMITED";
  tokenAttempt: string;
  tokenDayMode: "LIMITED" | "UNLIMITED";
  tokenDay: string;
  tokenMonthMode: "LIMITED" | "UNLIMITED";
  tokenMonth: string;
  tokenLifetimeMode: "LIMITED" | "UNLIMITED";
  tokenLifetime: string;
  spendDayMode: "LIMITED" | "UNLIMITED";
  spendDay: string;
  spendMonthMode: "LIMITED" | "UNLIMITED";
  spendMonth: string;
};

export const providerBudgetRules = (limits: ProviderBudgetValues, currency: string | null) =>
  [
    ["CONCURRENCY", "PER_ATTEMPT", limits.concurrencyMode, limits.concurrency, null],
    ["TOKENS", "PER_ATTEMPT", limits.tokenAttemptMode, limits.tokenAttempt, null],
    ["TOKENS", "UTC_DAY", limits.tokenDayMode, limits.tokenDay, null],
    ["TOKENS", "UTC_MONTH", limits.tokenMonthMode, limits.tokenMonth, null],
    ["TOKENS", "LIFETIME", limits.tokenLifetimeMode, limits.tokenLifetime, null],
    ["SPEND", "UTC_DAY", limits.spendDayMode, limits.spendDay, currency],
    ["SPEND", "UTC_MONTH", limits.spendMonthMode, limits.spendMonth, currency],
  ].map(([metric, period, mode, value, ruleCurrency]) => ({
    metric: metric as "CONCURRENCY" | "TOKENS" | "SPEND",
    period: period as "PER_ATTEMPT" | "UTC_DAY" | "UTC_MONTH" | "LIFETIME",
    mode: mode as "LIMITED" | "UNLIMITED",
    limitValue: mode === "UNLIMITED" ? null : value,
    currency: metric === "SPEND" ? ruleCurrency : null,
  }));

function submitProviderForm(event: FormEvent<HTMLFormElement>, submit: () => void | Promise<void>) {
  event.preventDefault();
  const form = event.currentTarget;
  void Promise.resolve(submit()).finally(() => {
    requestAnimationFrame(() => focusFirstInvalidProviderField(form));
  });
}

export function ProviderOperationsSection() {
  const { t, i18n } = useTranslation(["common", "dashboard"]);
  const dateTime = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }),
    [i18n.language],
  );
  const showDate = (value: Date | string | null | undefined) =>
    value ? dateTime.format(new Date(value)) : "—";
  const queryClient = useQueryClient();
  const accountFormRef = useRef<HTMLFormElement>(null);
  const credentialFormRef = useRef<HTMLFormElement>(null);
  const createModelFormRef = useRef<HTMLFormElement>(null);
  const pricingFormRef = useRef<HTMLFormElement>(null);
  const budgetFormRef = useRef<HTMLFormElement>(null);
  const accounts = useQuery({
    ...orpc.providerManagement.listAccounts.queryOptions(),
    retry: false,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deleteAccountArmed, setDeleteAccountArmed] = useState(false);
  const [deleteModelArmed, setDeleteModelArmed] = useState<string | null>(null);
  const selected =
    accounts.data?.find((account) => account.id === selectedId) ?? accounts.data?.[0];
  const accountId = selected?.id ?? "";
  const models = useQuery({
    ...orpc.providerManagement.listModels.queryOptions({ input: { providerAccountId: accountId } }),
    enabled: Boolean(accountId),
    retry: false,
  });
  const credentials = useQuery({
    ...orpc.providerManagement.listCredentials.queryOptions({
      input: { providerAccountId: accountId },
    }),
    enabled: Boolean(accountId),
    retry: false,
  });
  const audits = useQuery({
    ...orpc.providerManagement.listAuditEvents.queryOptions({
      input: { providerAccountId: accountId, limit: 25 },
    }),
    enabled: Boolean(accountId),
    retry: false,
  });
  const [usageCursor, setUsageCursor] = useState<{ createdAt: Date; id: string } | undefined>();
  const usage = useQuery({
    ...orpc.providerManagement.listUsageReportPage.queryOptions({
      input: { providerAccountId: accountId, limit: 50, cursor: usageCursor },
    }),
    enabled: Boolean(accountId),
    retry: false,
  });
  const usageTotals = useQuery({
    ...orpc.providerManagement.getUsageTotals.queryOptions({
      input: { providerAccountId: accountId, limit: 50 },
    }),
    enabled: Boolean(accountId),
    retry: false,
  });
  const budgets = useQuery({
    ...orpc.providerManagement.listBudgetActivity.queryOptions({
      input: { providerAccountId: accountId, limit: 50 },
    }),
    enabled: Boolean(accountId),
    retry: false,
  });
  const attempts = useQuery({
    ...orpc.providerManagement.listProviderAttemptEvents.queryOptions({
      input: { providerAccountId: accountId, limit: 50 },
    }),
    enabled: Boolean(accountId),
    retry: false,
  });
  const [attemptCursor, setAttemptCursor] = useState<{ createdAt: Date; id: string } | undefined>();
  const attemptStates = useQuery({
    ...orpc.providerManagement.listProviderAttempts.queryOptions({
      input: { providerAccountId: accountId, limit: 50, cursor: attemptCursor },
    }),
    enabled: Boolean(accountId),
    retry: false,
  });
  const [selectedModelId, setSelectedModelId] = useState("");
  const activeModelId = models.data?.some((model) => model.id === selectedModelId)
    ? selectedModelId
    : (models.data?.[0]?.id ?? "");
  const pricing = useQuery({
    ...orpc.providerManagement.listPricingVersions.queryOptions({
      input: { providerModelId: activeModelId },
    }),
    enabled: Boolean(activeModelId),
    retry: false,
  });
  const activePricing = pricing.data?.find((row) => row.status === "ACTIVE");
  const policies = useQuery({
    ...orpc.providerManagement.listBudgetPolicies.queryOptions(),
    retry: false,
  });
  const pools = useQuery({
    ...orpc.forwarderManagement.listModelPools.queryOptions(),
    retry: false,
  });
  const modelApiTokens = useQuery({
    ...orpc.modelApiTokens.list.queryOptions({ input: { includeRevoked: false, limit: 100 } }),
    retry: false,
  });
  const [attachmentDraft, setAttachmentDraft] = useState({ poolId: "", publicOrder: "0" });
  const budgetDefaults = {
    concurrencyMode: "LIMITED" as "LIMITED" | "UNLIMITED",
    concurrency: "1",
    tokenAttemptMode: "LIMITED" as "LIMITED" | "UNLIMITED",
    tokenAttempt: "100000",
    tokenDayMode: "LIMITED" as "LIMITED" | "UNLIMITED",
    tokenDay: "1000000",
    tokenMonthMode: "LIMITED" as "LIMITED" | "UNLIMITED",
    tokenMonth: "10000000",
    tokenLifetimeMode: "UNLIMITED" as "LIMITED" | "UNLIMITED",
    tokenLifetime: "100000000",
    spendDayMode: "LIMITED" as "LIMITED" | "UNLIMITED",
    spendDay: "10",
    spendMonthMode: "LIMITED" as "LIMITED" | "UNLIMITED",
    spendMonth: "100",
  };
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.providerManagement.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.forwarderManagement.key() }),
    ]);
  };
  const createAccount = useMutation(
    orpc.providerManagement.createAccount.mutationOptions({
      onSuccess: (account) => {
        setSelectedId(account.id);
        setUsageCursor(undefined);
        setAttemptCursor(undefined);
        accountForm.reset({ ...accountForm.state.values, label: "" });
        invalidate();
        toast.success(t("dashboard:providers.feedback.accountCreated"));
      },
      onError: () => toast.error(t("dashboard:providers.feedback.failed")),
    }),
  );
  const saveCredential = useMutation(
    orpc.providerManagement.createCredential.mutationOptions({
      onSuccess: () => {
        credentialForm.reset();
        invalidate();
        toast.success(t("dashboard:providers.feedback.credentialSaved"));
      },
      onError: () => toast.error(t("dashboard:providers.feedback.failed")),
    }),
  );
  const replaceCredential = useMutation(
    orpc.providerManagement.replaceCredential.mutationOptions({
      onSuccess: () => {
        credentialForm.reset();
        invalidate();
        toast.success(t("dashboard:providers.feedback.credentialReplaced"));
      },
      onError: () => toast.error(t("dashboard:providers.feedback.failed")),
    }),
  );
  const createModel = useMutation(
    orpc.providerManagement.createModel.mutationOptions({
      onSuccess: () => {
        createModelForm.reset();
        invalidate();
        toast.success(t("dashboard:providers.feedback.modelCreated"));
      },
      onError: () => toast.error(t("dashboard:providers.feedback.failed")),
    }),
  );
  const testCredential = useMutation(
    orpc.providerManagement.testCredential.mutationOptions({
      onSuccess: (result) =>
        result.ok
          ? toast.success(t("dashboard:providers.feedback.testPassed"))
          : toast.error(t("dashboard:providers.feedback.testFailed")),
      onError: () => toast.error(t("dashboard:providers.feedback.testFailed")),
    }),
  );
  const createPricing = useMutation(
    orpc.providerManagement.createPricingVersion.mutationOptions({
      onSuccess: () => {
        pricingForm.reset();
        invalidate();
        toast.success(t("dashboard:providers.feedback.pricingCreated"));
      },
      onError: () => toast.error(t("dashboard:providers.feedback.failed")),
    }),
  );
  const activatePricing = useMutation(
    orpc.providerManagement.activatePricingVersion.mutationOptions({
      onSuccess: () => {
        invalidate();
        toast.success(t("dashboard:providers.feedback.pricingActivated"));
      },
      onError: () => toast.error(t("dashboard:providers.feedback.failed")),
    }),
  );
  const updatePricing = useMutation(
    orpc.providerManagement.updatePricingVersion.mutationOptions({
      onSuccess: () => invalidate(),
      onError: () => toast.error(t("dashboard:providers.feedback.failed")),
    }),
  );
  const createBudget = useMutation(
    orpc.providerManagement.createBudgetPolicy.mutationOptions({
      onSuccess: () => {
        invalidate();
        toast.success(t("dashboard:providers.feedback.budgetSaved"));
      },
      onError: () => toast.error(t("dashboard:providers.feedback.failed")),
    }),
  );
  const setAccountEnabled = useMutation(
    orpc.providerManagement.setAccountEnabled.mutationOptions({
      onSuccess: () => invalidate(),
      onError: () => toast.error(t("dashboard:providers.feedback.enableFailed")),
    }),
  );
  const updateModel = useMutation(
    orpc.providerManagement.updateModel.mutationOptions({
      onSuccess: () => invalidate(),
      onError: () => toast.error(t("dashboard:providers.feedback.failed")),
    }),
  );
  const deleteAccount = useMutation(
    orpc.providerManagement.deleteAccount.mutationOptions({
      onSuccess: () => {
        setSelectedId(null);
        credentialForm.reset();
        setUsageCursor(undefined);
        setAttemptCursor(undefined);
        invalidate();
      },
      onError: () => toast.error(t("dashboard:providers.feedback.failed")),
    }),
  );
  const deleteModel = useMutation(
    orpc.providerManagement.deleteModel.mutationOptions({
      onSuccess: () => invalidate(),
      onError: () => toast.error(t("dashboard:providers.feedback.failed")),
    }),
  );
  const revokeCredential = useMutation(
    orpc.providerManagement.revokeCredential.mutationOptions({
      onSuccess: () => invalidate(),
      onError: () => toast.error(t("dashboard:providers.feedback.failed")),
    }),
  );
  const retirePricing = useMutation(
    orpc.providerManagement.retirePricingVersion.mutationOptions({
      onSuccess: () => invalidate(),
      onError: () => toast.error(t("dashboard:providers.feedback.failed")),
    }),
  );
  const deletePricing = useMutation(
    orpc.providerManagement.deletePricingVersion.mutationOptions({
      onSuccess: () => invalidate(),
      onError: () => toast.error(t("dashboard:providers.feedback.failed")),
    }),
  );
  const deactivateBudget = useMutation(
    orpc.providerManagement.deactivateBudgetPolicy.mutationOptions({
      onSuccess: () => invalidate(),
      onError: () => toast.error(t("dashboard:providers.feedback.failed")),
    }),
  );
  const replaceBudget = useMutation(
    orpc.providerManagement.replaceBudgetPolicy.mutationOptions({
      onSuccess: () => invalidate(),
      onError: () => toast.error(t("dashboard:providers.feedback.failed")),
    }),
  );
  const repairAttempts = useMutation(
    orpc.providerManagement.repairExpiredAttempts.mutationOptions({
      onSuccess: ({ repaired }) => {
        invalidate();
        toast.success(t("dashboard:providers.feedback.repaired", { count: repaired }));
      },
      onError: () => toast.error(t("dashboard:providers.feedback.failed")),
    }),
  );
  const updatePool = useMutation(
    orpc.forwarderManagement.updateModelPool.mutationOptions({
      onSuccess: () => invalidate(),
      onError: () => toast.error(t("dashboard:providers.feedback.failed")),
    }),
  );
  const addPoolMember = useMutation(
    orpc.forwarderManagement.addProviderPoolMember.mutationOptions({
      onSuccess: () => invalidate(),
      onError: () => toast.error(t("dashboard:providers.feedback.failed")),
    }),
  );
  const reorderPoolMember = useMutation(
    orpc.forwarderManagement.reorderProviderPoolMember.mutationOptions({
      onSuccess: () => invalidate(),
      onError: () => toast.error(t("dashboard:providers.feedback.failed")),
    }),
  );
  const removePoolMember = useMutation(
    orpc.forwarderManagement.removePoolMember.mutationOptions({
      onSuccess: () => invalidate(),
      onError: () => toast.error(t("dashboard:providers.feedback.failed")),
    }),
  );
  const credentialActive = credentials.data?.find((item) => item.status === "ACTIVE");
  const accountForm = useForm({
    defaultValues: {
      label: "",
      providerType: "openai",
      baseUrl: "https://api.openai.com/v1",
      authType: "BEARER" as "API_KEY" | "BEARER",
    },
    validators: {
      onChange: providerAccountFormSchema,
      onSubmit: providerAccountFormSchema,
    },
    onSubmit: async ({ value }) => {
      await createAccount.mutateAsync({ ...value, safeConfiguration: null });
    },
  });
  const credentialForm = useForm({
    defaultValues: { credential: "" },
    validators: { onSubmit: credentialFormSchema },
    onSubmit: async ({ value }) => {
      const action = credentialActive ? replaceCredential : saveCredential;
      await action.mutateAsync({ providerAccountId: accountId, credential: value.credential });
    },
  });
  const createModelForm = useForm({
    defaultValues: {
      upstreamModelId: "",
      displayName: "",
      nativeSurface: "OPENAI_CHAT_COMPLETIONS" as ProviderNativeSurface,
      streaming: true,
      anthropicVersion: "2023-06-01",
      betaFeatures: "",
    },
    validators: { onSubmit: createModelFormSchema },
    onSubmit: async ({ value }) => {
      await createModel.mutateAsync({
        providerAccountId: accountId,
        upstreamModelId: value.upstreamModelId,
        displayName: value.displayName || null,
        capabilityMetadata: null,
        nativeCapabilities: providerCapabilityInventory(value),
        contextWindow: null,
        maxOutputTokens: null,
        concurrencyLimit: null,
        pricingMetadata: null,
        pricingVersion: null,
        enabled: false,
      });
    },
  });
  const pricingForm = useForm({
    defaultValues: { version: "", currency: "USD", input: "", output: "" },
    validators: { onSubmit: pricingFormSchema },
    onSubmit: async ({ value }) => {
      if (!activeModelId) return;
      await createPricing.mutateAsync({
        providerModelId: activeModelId,
        version: value.version,
        currency: value.currency,
        accountingVersion: "provider-billable-v1",
        confidence: "CALCULATED",
        ratesPerMillion: { input: value.input, output: value.output },
        chargeRules: {
          inputIncludesCacheRead: false,
          inputIncludesCacheWrite: false,
          outputIncludesReasoning: false,
          outputIncludesTool: false,
          reasoningAllowanceTokens: 0,
          toolAllowanceTokens: 0,
          cacheReadAllowanceTokens: 0,
          cacheWriteAllowanceTokens: 0,
          additionalAllowanceTokens: 0,
          unknownCategories: "FAIL_CLOSED",
        },
        effectiveAt: new Date(),
      });
    },
  });
  const budgetForm = useForm({
    defaultValues: budgetDefaults,
    validators: {
      onChange: providerBudgetFormSchema,
      onSubmit: providerBudgetFormSchema,
    },
    onSubmit: async ({ value }) => {
      await createBudget.mutateAsync({
        scopeType: "PROVIDER_ACCOUNT",
        providerAccountId: accountId,
        poolId: null,
        providerModelId: null,
        active: true,
        rules: providerBudgetRules(value, activePricing?.currency ?? null),
      });
    },
  });

  if (accounts.isPending) return <Skeleton className="mt-8 h-80 w-full" />;
  if (accounts.isError)
    return <InlineRetry message={t("dashboard:providers.loadFailed")} onRetry={accounts.refetch} />;

  return (
    <section className="mt-10 min-w-0 border-t pt-8" aria-labelledby="provider-operations-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id="provider-operations-title" className="text-xl font-semibold tracking-tight">
            {t("dashboard:providers.title")}
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {t("dashboard:providers.description")}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="size-4 text-primary" />
          {t("dashboard:providers.secretDisclosure")}
        </div>
      </div>

      <form
        ref={accountFormRef}
        noValidate
        className="mt-6 grid gap-3 rounded-xl border bg-muted/20 p-4 md:grid-cols-2 xl:grid-cols-5"
        onSubmit={(event) => submitProviderForm(event, accountForm.handleSubmit)}
      >
        {(["label", "providerType", "baseUrl"] as const).map((name) => (
          <accountForm.Field key={name} name={name}>
            {(field) => (
              <Field
                id={`provider-account-${name}`}
                errors={field.state.meta.errors}
                label={t(`dashboard:providers.fields.${name === "providerType" ? "type" : name}`)}
                className={name === "baseUrl" ? "md:col-span-2" : undefined}
              >
                <Input
                  type={name === "baseUrl" ? "url" : "text"}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </accountForm.Field>
        ))}
        <accountForm.Field name="authType">
          {(field) => (
            <Field
              id="provider-account-authType"
              errors={field.state.meta.errors}
              label={t("dashboard:providers.fields.authType")}
            >
              <select
                className="h-11 w-full rounded-md border bg-background px-3 text-base sm:text-sm"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value as "API_KEY" | "BEARER")}
              >
                <option value="BEARER">{t("dashboard:providers.enums.BEARER")}</option>
                <option value="API_KEY">{t("dashboard:providers.enums.API_KEY")}</option>
              </select>
            </Field>
          )}
        </accountForm.Field>
        <div className="flex items-end md:col-span-2 xl:col-span-1">
          <Button type="submit" className="w-full" size="touch" disabled={createAccount.isPending}>
            <Plus className="size-4" /> {t("dashboard:providers.actions.addAccount")}
          </Button>
        </div>
      </form>

      {accounts.data.length === 0 ? (
        <p className="mt-6 rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t("dashboard:providers.empty")}
        </p>
      ) : (
        <div className="mt-6 grid min-w-0 gap-6 xl:grid-cols-[18rem_minmax(0,1fr)]">
          <nav className="min-w-0 space-y-2" aria-label={t("dashboard:providers.accountList")}>
            {accounts.data.map((account) => (
              <button
                type="button"
                key={account.id}
                onClick={() => {
                  setSelectedId(account.id);
                  credentialForm.reset();
                  createModelForm.reset();
                  setSelectedModelId("");
                  setUsageCursor(undefined);
                  setAttemptCursor(undefined);
                  setDeleteAccountArmed(false);
                  setDeleteModelArmed(null);
                }}
                className={`min-h-11 w-full rounded-xl border px-3 py-2 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected?.id === account.id ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}
              >
                <span className="block truncate text-sm font-medium">{account.label}</span>
                <span className="mt-1 block truncate text-xs text-muted-foreground">
                  {account.providerType} · {t(`dashboard:providers.enums.${account.healthStatus}`)}
                </span>
              </button>
            ))}
          </nav>
          {selected ? (
            <div className="min-w-0 space-y-8">
              <div className="flex flex-col gap-4 rounded-xl border p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <h3 className="truncate font-semibold">{selected.label}</h3>
                  <p className="mt-1 break-all text-xs text-muted-foreground">{selected.baseUrl}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t("dashboard:providers.lastHealth", {
                      date: showDate(selected.healthCheckedAt),
                    })}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="touch"
                    disabled={!credentialActive || testCredential.isPending}
                    onClick={() => testCredential.mutate({ providerAccountId: selected.id })}
                  >
                    <RefreshCw className="size-4" /> {t("dashboard:providers.actions.test")}
                  </Button>
                  <Button
                    variant="outline"
                    size="touch"
                    disabled={setAccountEnabled.isPending}
                    onClick={() =>
                      setAccountEnabled.mutate({ id: selected.id, enabled: !selected.enabled })
                    }
                  >
                    <Power className="size-4" />
                    {selected.enabled
                      ? t("dashboard:providers.actions.disable")
                      : t("dashboard:providers.actions.enable")}
                  </Button>
                  <Button
                    variant="destructive"
                    size="touch"
                    disabled={deleteAccount.isPending}
                    onClick={() => {
                      if (deleteAccountArmed) deleteAccount.mutate({ id: selected.id });
                      else setDeleteAccountArmed(true);
                    }}
                    aria-label={t("dashboard:providers.actions.deleteAccount", {
                      label: selected.label,
                    })}
                  >
                    <Trash2 className="size-4" />
                    {deleteAccountArmed
                      ? t("dashboard:providers.actions.confirmDelete")
                      : t("dashboard:providers.actions.delete")}
                  </Button>
                </div>
              </div>

              <UpdateAccountForm
                key={`account-${selected.id}-${selected.updatedAt.toString()}`}
                account={selected}
                authTypeLocked={Boolean(credentials.data?.length)}
              />

              <div className="grid gap-6 lg:grid-cols-2">
                <form
                  ref={credentialFormRef}
                  noValidate
                  className="min-w-0 space-y-3"
                  onSubmit={(event) => submitProviderForm(event, credentialForm.handleSubmit)}
                >
                  <h3 className="flex items-center gap-2 font-medium">
                    <KeyRound className="size-4" />
                    {t("dashboard:providers.credentials")}
                  </h3>
                  {credentials.isError ? (
                    <InlineRetry
                      message={t("dashboard:providers.credentialsFailed")}
                      onRetry={credentials.refetch}
                    />
                  ) : null}
                  <p className="text-sm text-muted-foreground">
                    {credentialActive
                      ? t("dashboard:providers.activeSuffix", {
                          suffix: credentialActive.displaySuffix,
                        })
                      : t("dashboard:providers.noCredential")}
                  </p>
                  <credentialForm.Field name="credential">
                    {(field) => (
                      <Field
                        id="provider-secret"
                        errors={field.state.meta.errors}
                        label={
                          credentialActive
                            ? t("dashboard:providers.fields.replacementSecret")
                            : t("dashboard:providers.fields.secret")
                        }
                      >
                        <Input
                          type="password"
                          autoComplete="new-password"
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(event) => field.handleChange(event.target.value)}
                        />
                      </Field>
                    )}
                  </credentialForm.Field>
                  <p className="text-xs text-muted-foreground">
                    {t("dashboard:providers.secretNeverShown")}
                  </p>
                  <Button
                    type="submit"
                    size="touch"
                    disabled={saveCredential.isPending || replaceCredential.isPending}
                  >
                    {credentialActive
                      ? t("dashboard:providers.actions.replaceCredential")
                      : t("dashboard:providers.actions.saveCredential")}
                  </Button>
                  {credentialActive ? (
                    <Button
                      type="button"
                      size="touch"
                      variant="outline"
                      disabled={revokeCredential.isPending}
                      onClick={() => revokeCredential.mutate({ id: credentialActive.id })}
                    >
                      {t("dashboard:providers.actions.revokeCredential")}
                    </Button>
                  ) : null}
                </form>
                <form
                  ref={createModelFormRef}
                  noValidate
                  className="min-w-0 space-y-3"
                  onSubmit={(event) => submitProviderForm(event, createModelForm.handleSubmit)}
                >
                  <h3 className="font-medium">{t("dashboard:providers.models")}</h3>
                  <createModelForm.Field name="upstreamModelId">
                    {(field) => (
                      <Field
                        id="provider-new-model-upstreamModelId"
                        errors={field.state.meta.errors}
                        label={t("dashboard:providers.fields.upstreamModel")}
                      >
                        <Input
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(event) => field.handleChange(event.target.value)}
                        />
                      </Field>
                    )}
                  </createModelForm.Field>
                  <createModelForm.Field name="displayName">
                    {(field) => (
                      <Field
                        id="provider-new-model-displayName"
                        errors={field.state.meta.errors}
                        label={t("dashboard:providers.fields.displayName")}
                      >
                        <Input
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(event) => field.handleChange(event.target.value)}
                        />
                      </Field>
                    )}
                  </createModelForm.Field>
                  <createModelForm.Field name="nativeSurface">
                    {(field) => (
                      <Field label={t("dashboard:providers.fields.nativeSurface")}>
                        <select
                          className="h-11 w-full rounded-md border bg-transparent px-3 text-sm"
                          value={field.state.value}
                          onChange={(event) =>
                            field.handleChange(event.target.value as typeof field.state.value)
                          }
                        >
                          {[
                            "OPENAI_CHAT_COMPLETIONS",
                            "OPENAI_RESPONSES",
                            "ANTHROPIC_MESSAGES",
                            "OPENAI_COMPLETIONS",
                          ].map((surface) => (
                            <option key={surface} value={surface}>
                              {t(`dashboard:models.surfaces.${surface}`)}
                            </option>
                          ))}
                        </select>
                      </Field>
                    )}
                  </createModelForm.Field>
                  <createModelForm.Field name="streaming">
                    {(field) => (
                      <label className="flex min-h-11 items-center gap-3 text-sm">
                        <input
                          type="checkbox"
                          checked={field.state.value}
                          onChange={(event) => field.handleChange(event.target.checked)}
                        />
                        {t("dashboard:providers.fields.streaming")}
                      </label>
                    )}
                  </createModelForm.Field>
                  <createModelForm.Subscribe selector={(state) => state.values.nativeSurface}>
                    {(nativeSurface) =>
                      nativeSurface === "ANTHROPIC_MESSAGES" ? (
                        <div className="grid gap-3 sm:grid-cols-2">
                          <createModelForm.Field name="anthropicVersion">
                            {(field) => (
                              <Field
                                errors={field.state.meta.errors}
                                label={t("dashboard:providers.fields.anthropicVersion")}
                              >
                                <Input
                                  value={field.state.value}
                                  onBlur={field.handleBlur}
                                  onChange={(event) => field.handleChange(event.target.value)}
                                />
                              </Field>
                            )}
                          </createModelForm.Field>
                          <createModelForm.Field name="betaFeatures">
                            {(field) => (
                              <Field label={t("dashboard:providers.fields.anthropicBetas")}>
                                <Input
                                  value={field.state.value}
                                  onBlur={field.handleBlur}
                                  onChange={(event) => field.handleChange(event.target.value)}
                                />
                              </Field>
                            )}
                          </createModelForm.Field>
                        </div>
                      ) : null
                    }
                  </createModelForm.Subscribe>
                  <Button type="submit" size="touch" disabled={createModel.isPending}>
                    <Plus className="size-4" />
                    {t("dashboard:providers.actions.addModel")}
                  </Button>
                </form>
              </div>

              <div className="min-w-0">
                <h3 className="font-medium">{t("dashboard:providers.configuredModels")}</h3>
                {models.isError ? (
                  <InlineRetry
                    message={t("dashboard:providers.modelsFailed")}
                    onRetry={models.refetch}
                  />
                ) : null}
                <div className="mt-3 divide-y rounded-xl border">
                  {models.data?.map((model) => (
                    <div key={model.id} className="min-w-0 p-3">
                      <div className="flex min-w-0 items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">
                            {model.displayName || model.upstreamModelId}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {model.pricingVersion || t("dashboard:providers.noActivePricing")} ·{" "}
                            {t(`dashboard:providers.enums.${model.healthStatus}`)}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {capabilitySummary(model.nativeCapabilities) ??
                              t("dashboard:providers.noCapabilities")}
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-2">
                          <Button
                            type="button"
                            size="touch"
                            variant="outline"
                            disabled={updateModel.isPending}
                            onClick={() =>
                              updateModel.mutate({ id: model.id, enabled: !model.enabled })
                            }
                          >
                            {model.enabled
                              ? t("dashboard:providers.actions.disable")
                              : t("dashboard:providers.actions.enable")}
                          </Button>
                          <Button
                            type="button"
                            size="touch"
                            variant={deleteModelArmed === model.id ? "destructive" : "ghost"}
                            disabled={deleteModel.isPending}
                            onClick={() => {
                              if (deleteModelArmed === model.id)
                                deleteModel.mutate({ id: model.id });
                              else setDeleteModelArmed(model.id);
                            }}
                            aria-label={
                              deleteModelArmed === model.id
                                ? t("dashboard:providers.actions.confirmDeleteModel", {
                                    label: model.displayName || model.upstreamModelId,
                                  })
                                : t("dashboard:providers.actions.deleteModel", {
                                    label: model.displayName || model.upstreamModelId,
                                  })
                            }
                          >
                            <Trash2 className="size-4" />
                            {deleteModelArmed === model.id ? (
                              <span>{t("dashboard:providers.actions.confirmDelete")}</span>
                            ) : null}
                          </Button>
                        </div>
                      </div>
                      <details className="mt-3">
                        <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                          {t("dashboard:providers.actions.editModel")}
                        </summary>
                        <UpdateModelForm
                          key={`model-${model.id}-${model.updatedAt.toString()}`}
                          model={model}
                        />
                      </details>
                    </div>
                  ))}
                  {!models.data?.length ? (
                    <p className="p-4 text-sm text-muted-foreground">
                      {t("dashboard:providers.noModels")}
                    </p>
                  ) : null}
                </div>
              </div>

              {models.data?.length ? (
                <div className="grid min-w-0 gap-6 lg:grid-cols-2">
                  <form
                    ref={pricingFormRef}
                    noValidate
                    className="min-w-0 space-y-3"
                    onSubmit={(event) => submitProviderForm(event, pricingForm.handleSubmit)}
                  >
                    <h3 className="font-medium">{t("dashboard:providers.pricing")}</h3>
                    {pricing.isError ? (
                      <InlineRetry
                        message={t("dashboard:providers.pricingFailed")}
                        onRetry={pricing.refetch}
                      />
                    ) : null}
                    <select
                      className="h-11 w-full rounded-md border bg-transparent px-3 text-sm"
                      value={activeModelId}
                      onChange={(event) => setSelectedModelId(event.target.value)}
                      aria-label={t("dashboard:providers.fields.model")}
                    >
                      {models.data.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.displayName || model.upstreamModelId}
                        </option>
                      ))}
                    </select>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {(["version", "currency", "input", "output"] as const).map((name) => (
                        <pricingForm.Field key={name} name={name}>
                          {(field) => (
                            <Field
                              id={`provider-pricing-${name}`}
                              errors={field.state.meta.errors}
                              label={t(
                                `dashboard:providers.fields.${name === "version" ? "pricingVersion" : name === "input" ? "inputRate" : name === "output" ? "outputRate" : name}`,
                              )}
                            >
                              <Input
                                maxLength={name === "currency" ? 3 : undefined}
                                inputMode={
                                  name === "input" || name === "output" ? "decimal" : undefined
                                }
                                value={field.state.value}
                                onBlur={field.handleBlur}
                                onChange={(event) =>
                                  field.handleChange(
                                    name === "currency"
                                      ? event.target.value.toUpperCase()
                                      : event.target.value,
                                  )
                                }
                              />
                            </Field>
                          )}
                        </pricingForm.Field>
                      ))}
                    </div>
                    <Button type="submit" size="touch" disabled={createPricing.isPending}>
                      {t("dashboard:providers.actions.savePricingDraft")}
                    </Button>
                    <div className="divide-y rounded-xl border">
                      {pricing.data?.map((row) => (
                        <div
                          key={row.id}
                          className="flex min-w-0 items-center justify-between gap-3 p-3"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">
                              {row.version} · {row.currency}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {t(`dashboard:providers.enums.${row.status}`)} ·{" "}
                              {row.accountingVersion}
                            </p>
                          </div>
                          {row.status === "DRAFT" ? (
                            <div className="flex flex-wrap gap-2">
                              <Button
                                type="button"
                                size="touch"
                                variant="outline"
                                disabled={
                                  updatePricing.isPending ||
                                  !pricingForm.state.values.input ||
                                  !pricingForm.state.values.output
                                }
                                onClick={() =>
                                  updatePricing.mutate({
                                    id: row.id,
                                    currency: pricingForm.state.values.currency,
                                    ratesPerMillion: {
                                      input: pricingForm.state.values.input,
                                      output: pricingForm.state.values.output,
                                    },
                                  })
                                }
                              >
                                {t("dashboard:providers.actions.updateDraft")}
                              </Button>
                              <Button
                                type="button"
                                size="touch"
                                variant="outline"
                                disabled={activatePricing.isPending}
                                onClick={() => activatePricing.mutate({ id: row.id })}
                              >
                                {t("dashboard:providers.actions.activate")}
                              </Button>
                              <Button
                                type="button"
                                size="touch"
                                variant="ghost"
                                disabled={deletePricing.isPending}
                                onClick={() => deletePricing.mutate({ id: row.id })}
                                aria-label={t("dashboard:providers.actions.deletePricing", {
                                  version: row.version,
                                })}
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            </div>
                          ) : row.status === "ACTIVE" ? (
                            <Button
                              type="button"
                              size="touch"
                              variant="outline"
                              disabled={retirePricing.isPending}
                              onClick={() => retirePricing.mutate({ id: row.id })}
                            >
                              {t("dashboard:providers.actions.retire")}
                            </Button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </form>
                  <form
                    ref={budgetFormRef}
                    aria-label={t("dashboard:providers.budgets")}
                    noValidate
                    className="min-w-0 space-y-3"
                    onSubmit={(event) => submitProviderForm(event, budgetForm.handleSubmit)}
                  >
                    <h3 className="font-medium">{t("dashboard:providers.budgets")}</h3>
                    {policies.isError ? (
                      <InlineRetry
                        message={t("dashboard:providers.policiesFailed")}
                        onRetry={policies.refetch}
                      />
                    ) : null}
                    <budgetForm.Subscribe selector={(state) => state}>
                      {(budgetState) => (
                        <div className="grid gap-3 sm:grid-cols-2">
                          <BudgetRuleField
                            id="provider-budget-concurrency"
                            errors={budgetState.fieldMeta.concurrency?.errors}
                            label={t("dashboard:providers.fields.concurrencyAttempt")}
                            mode={budgetState.values.concurrencyMode}
                            value={budgetState.values.concurrency}
                            onMode={(value) => budgetForm.setFieldValue("concurrencyMode", value)}
                            onValue={(value) => budgetForm.setFieldValue("concurrency", value)}
                          />
                          <BudgetRuleField
                            id="provider-budget-token-attempt"
                            errors={budgetState.fieldMeta.tokenAttempt?.errors}
                            label={t("dashboard:providers.fields.tokensAttempt")}
                            mode={budgetState.values.tokenAttemptMode}
                            value={budgetState.values.tokenAttempt}
                            onMode={(value) => budgetForm.setFieldValue("tokenAttemptMode", value)}
                            onValue={(value) => budgetForm.setFieldValue("tokenAttempt", value)}
                          />
                          <BudgetRuleField
                            id="provider-budget-token-day"
                            errors={budgetState.fieldMeta.tokenDay?.errors}
                            label={t("dashboard:providers.fields.tokensDay")}
                            mode={budgetState.values.tokenDayMode}
                            value={budgetState.values.tokenDay}
                            onMode={(value) => budgetForm.setFieldValue("tokenDayMode", value)}
                            onValue={(value) => budgetForm.setFieldValue("tokenDay", value)}
                          />
                          <BudgetRuleField
                            id="provider-budget-token-month"
                            errors={budgetState.fieldMeta.tokenMonth?.errors}
                            label={t("dashboard:providers.fields.tokensMonth")}
                            mode={budgetState.values.tokenMonthMode}
                            value={budgetState.values.tokenMonth}
                            onMode={(value) => budgetForm.setFieldValue("tokenMonthMode", value)}
                            onValue={(value) => budgetForm.setFieldValue("tokenMonth", value)}
                          />
                          <BudgetRuleField
                            id="provider-budget-token-lifetime"
                            errors={budgetState.fieldMeta.tokenLifetime?.errors}
                            label={t("dashboard:providers.fields.tokensLifetime")}
                            mode={budgetState.values.tokenLifetimeMode}
                            value={budgetState.values.tokenLifetime}
                            onMode={(value) => budgetForm.setFieldValue("tokenLifetimeMode", value)}
                            onValue={(value) => budgetForm.setFieldValue("tokenLifetime", value)}
                          />
                          <BudgetRuleField
                            id="provider-budget-spend-day"
                            errors={budgetState.fieldMeta.spendDay?.errors}
                            label={t("dashboard:providers.fields.spendDay")}
                            mode={budgetState.values.spendDayMode}
                            value={budgetState.values.spendDay}
                            onMode={(value) => budgetForm.setFieldValue("spendDayMode", value)}
                            onValue={(value) => budgetForm.setFieldValue("spendDay", value)}
                            decimal
                          />
                          <BudgetRuleField
                            id="provider-budget-spend-month"
                            errors={budgetState.fieldMeta.spendMonth?.errors}
                            label={t("dashboard:providers.fields.spendMonth")}
                            mode={budgetState.values.spendMonthMode}
                            value={budgetState.values.spendMonth}
                            onMode={(value) => budgetForm.setFieldValue("spendMonthMode", value)}
                            onValue={(value) => budgetForm.setFieldValue("spendMonth", value)}
                            decimal
                          />
                        </div>
                      )}
                    </budgetForm.Subscribe>
                    <budgetForm.Subscribe selector={(state) => state.isSubmitting}>
                      {() => (
                        <Button
                          type="submit"
                          size="touch"
                          disabled={createBudget.isPending || !activePricing}
                        >
                          {t("dashboard:providers.actions.activateBudget")}
                        </Button>
                      )}
                    </budgetForm.Subscribe>
                    <p className="text-xs text-muted-foreground">
                      {t("dashboard:providers.budgetPeriods")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("dashboard:providers.policyCount", {
                        count:
                          policies.data?.filter(
                            (policy) => policy.providerAccountId === selected.id,
                          ).length ?? 0,
                      })}
                    </p>
                    {!activePricing ? (
                      <p className="text-sm text-destructive">
                        {t("dashboard:providers.activePricingRequired")}
                      </p>
                    ) : null}
                    <div className="divide-y rounded-xl border">
                      {policies.data
                        ?.filter((policy) => policy.providerAccountId === selected.id)
                        .map((policy) => (
                          <div
                            key={policy.id}
                            className="flex min-w-0 items-center justify-between gap-3 p-3"
                          >
                            <div className="min-w-0 text-sm">
                              <p className="font-medium">
                                {t(`dashboard:providers.enums.${policy.scopeType}`)} · v
                                {policy.version}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {policy.Rules.map(
                                  (rule) =>
                                    `${t(`dashboard:providers.enums.${rule.metric}`)} / ${t(`dashboard:providers.enums.${rule.period}`)}: ${t(`dashboard:providers.enums.${rule.mode}`)}${rule.limitValue ? ` ${rule.limitValue.toString()}${rule.currency ? ` ${rule.currency}` : ""}` : ""}`,
                                ).join(" · ")}
                              </p>
                            </div>
                            {policy.active ? (
                              <div className="flex flex-wrap gap-2">
                                <Button
                                  type="button"
                                  size="touch"
                                  variant="outline"
                                  disabled={replaceBudget.isPending}
                                  onClick={() =>
                                    replaceBudget.mutate({
                                      id: policy.id,
                                      active: true,
                                      rules: providerBudgetRules(
                                        budgetForm.state.values,
                                        activePricing?.currency ?? null,
                                      ),
                                    })
                                  }
                                >
                                  {t("dashboard:providers.actions.newBudgetVersion")}
                                </Button>
                                <Button
                                  type="button"
                                  size="touch"
                                  variant="outline"
                                  disabled={deactivateBudget.isPending}
                                  onClick={() => deactivateBudget.mutate({ id: policy.id })}
                                >
                                  {t("dashboard:providers.actions.deactivate")}
                                </Button>
                              </div>
                            ) : null}
                          </div>
                        ))}
                    </div>
                  </form>
                </div>
              ) : null}

              {activeModelId ? (
                <div className="min-w-0 space-y-4 border-t pt-8">
                  <div>
                    <h3 className="font-medium">{t("dashboard:providers.poolAttachments")}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t("dashboard:providers.poolAttachmentsDescription")}
                    </p>
                  </div>
                  {pools.isError ? (
                    <InlineRetry
                      message={t("dashboard:providers.poolLoadFailed")}
                      onRetry={pools.refetch}
                    />
                  ) : pools.isPending ? (
                    <Skeleton className="h-24" />
                  ) : (
                    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_10rem_auto]">
                      <Field label={t("dashboard:providers.fields.pool")}>
                        <select
                          className="h-11 w-full rounded-md border bg-background px-3 text-base sm:text-sm"
                          value={attachmentDraft.poolId}
                          onChange={(event) =>
                            setAttachmentDraft({ ...attachmentDraft, poolId: event.target.value })
                          }
                        >
                          <option value="">{t("dashboard:providers.fields.choosePool")}</option>
                          {pools.data?.map((pool) => (
                            <option key={pool.id} value={pool.id}>
                              {pool.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label={t("dashboard:providers.fields.publicOrder")}>
                        <Input
                          type="number"
                          min="0"
                          max="10000"
                          value={attachmentDraft.publicOrder}
                          onChange={(event) =>
                            setAttachmentDraft({
                              ...attachmentDraft,
                              publicOrder: event.target.value,
                            })
                          }
                        />
                      </Field>
                      <div className="flex flex-wrap items-end gap-2 md:col-span-3">
                        <Button
                          type="button"
                          size="touch"
                          variant="outline"
                          disabled={
                            !attachmentDraft.poolId ||
                            createBudget.isPending ||
                            !budgetForm.state.canSubmit ||
                            !activePricing
                          }
                          onClick={() => {
                            const currency = activePricing?.currency ?? null;
                            createBudget.mutate({
                              scopeType: "POOL_PROVIDER_MODEL",
                              providerAccountId: selected.id,
                              poolId: attachmentDraft.poolId,
                              providerModelId: activeModelId,
                              active: true,
                              rules: providerBudgetRules(budgetForm.state.values, currency),
                            });
                          }}
                        >
                          {t("dashboard:providers.actions.createAttachmentProtection")}
                        </Button>
                        <Button
                          type="button"
                          size="touch"
                          variant="outline"
                          disabled={!attachmentDraft.poolId || updatePool.isPending}
                          onClick={() =>
                            updatePool.mutate({
                              id: attachmentDraft.poolId,
                              publicEgressAcknowledged: true,
                              publicEgressEnabled: true,
                            })
                          }
                        >
                          {t("dashboard:providers.actions.acknowledgeEgress")}
                        </Button>
                        <Button
                          type="button"
                          size="touch"
                          disabled={
                            !attachmentDraft.poolId ||
                            !Number.isInteger(Number(attachmentDraft.publicOrder)) ||
                            addPoolMember.isPending
                          }
                          onClick={() =>
                            addPoolMember.mutate({
                              poolId: attachmentDraft.poolId,
                              providerModelId: activeModelId,
                              publicOrder: Number(attachmentDraft.publicOrder),
                            })
                          }
                        >
                          {t("dashboard:providers.actions.attachProvider")}
                        </Button>
                      </div>
                    </div>
                  )}
                  <div className="divide-y rounded-xl border">
                    {pools.data?.flatMap((pool) =>
                      pool.members
                        .filter(
                          (member) => member.providerModel?.ProviderAccount.id === selected.id,
                        )
                        .map((member) => (
                          <div
                            key={member.id}
                            className="flex min-w-0 flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between"
                          >
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium">
                                {pool.name} ·{" "}
                                {member.providerModel?.displayName ??
                                  member.providerModel?.upstreamModelId}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {t("dashboard:providers.publicOrder", {
                                  order: member.publicOrder ?? 0,
                                })}{" "}
                                · {t(`dashboard:providers.enums.${member.routingStatus}`)}
                              </p>
                              <p className="mt-1 break-words text-xs text-muted-foreground">
                                {t("dashboard:providers.grantEgressDisclosure", {
                                  grants:
                                    pool.grants.map((grant) => grant.granteeEmail).join(", ") ||
                                    t("dashboard:providers.none"),
                                  tokens:
                                    modelApiTokens.data
                                      ?.filter(
                                        (token) =>
                                          token.scopeMode === "ALL_VISIBLE" ||
                                          token.allowlist.modelPoolIds.includes(pool.id),
                                      )
                                      .map((token) => token.name)
                                      .join(", ") || t("dashboard:providers.none"),
                                })}
                              </p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <Button
                                type="button"
                                size="touch"
                                variant="outline"
                                disabled={reorderPoolMember.isPending}
                                onClick={() =>
                                  reorderPoolMember.mutate({ id: member.id, direction: "EARLIER" })
                                }
                              >
                                {t("dashboard:providers.actions.moveEarlier")}
                              </Button>
                              <Button
                                type="button"
                                size="touch"
                                variant="outline"
                                disabled={reorderPoolMember.isPending}
                                onClick={() =>
                                  reorderPoolMember.mutate({ id: member.id, direction: "LATER" })
                                }
                              >
                                {t("dashboard:providers.actions.moveLater")}
                              </Button>
                              <Button
                                type="button"
                                size="touch"
                                variant="ghost"
                                disabled={removePoolMember.isPending}
                                onClick={() => removePoolMember.mutate({ id: member.id })}
                                aria-label={t("dashboard:providers.actions.detachProvider")}
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            </div>
                          </div>
                        )),
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("dashboard:providers.egressAcknowledgement")}
                  </p>
                  {modelApiTokens.isError ? (
                    <InlineRetry
                      message={t("dashboard:providers.tokensFailed")}
                      onRetry={modelApiTokens.refetch}
                    />
                  ) : null}
                </div>
              ) : null}

              <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
                <div className="flex gap-3">
                  <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600" />
                  <div>
                    <h3 className="font-medium">{t("dashboard:providers.unlimitedTitle")}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t("dashboard:providers.unlimitedWarning")}
                    </p>
                  </div>
                </div>
              </div>

              <div className="min-w-0">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <h3 className="font-medium">{t("dashboard:providers.reporting")}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t("dashboard:providers.reportingDescription")}
                    </p>
                  </div>
                  {!usageTotals.isError ? (
                    <div className="text-end text-sm font-medium">
                      {usageTotals.data?.totals.map((total) => (
                        <p key={total.currency ?? "unknown"}>
                          {t("dashboard:providers.settledSpendCurrency", {
                            value: total.settledCost?.toString() ?? "0",
                            currency: total.currency ?? t("dashboard:providers.unknownCurrency"),
                          })}
                        </p>
                      ))}
                      {(usageTotals.data?.excludedRowCount ?? 0) > 0 ? (
                        <p className="text-xs font-normal text-muted-foreground">
                          {t("dashboard:providers.unknownCostRows", {
                            count: usageTotals.data?.excludedRowCount,
                          })}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="touch"
                      onClick={() => usageTotals.refetch()}
                    >
                      {t("common:retry")}
                    </Button>
                  )}
                </div>
                {usage.isError ? (
                  <InlineRetry
                    message={t("dashboard:providers.reportFailed")}
                    onRetry={usage.refetch}
                  />
                ) : usage.isPending ? (
                  <Skeleton className="mt-3 h-40" />
                ) : (
                  <WideContent className="mt-3">
                    <table className="w-full min-w-[58rem] text-start text-sm">
                      <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                        <tr>
                          <th className="p-3 text-start">{t("dashboard:providers.table.time")}</th>
                          <th className="p-3 text-start">{t("dashboard:providers.table.usage")}</th>
                          <th className="p-3 text-start">{t("dashboard:providers.table.cost")}</th>
                          <th className="p-3 text-start">
                            {t("dashboard:providers.table.identity")}
                          </th>
                          <th className="p-3 text-start">
                            {t("dashboard:providers.table.confidence")}
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {usage.data?.items.map((row) => (
                          <tr key={row.id}>
                            <td className="p-3">{showDate(row.createdAt)}</td>
                            <td className="p-3">
                              {showValue(row.inputTokens)} / {showValue(row.outputTokens)} ·{" "}
                              {showValue(row.billableTotal)}
                            </td>
                            <td className="p-3">
                              <span className="block">
                                {t("dashboard:providers.reportedCost", {
                                  value: showValue(row.reportedCost),
                                  currency:
                                    row.reportedCostCurrency ??
                                    t("dashboard:providers.unknownCurrency"),
                                })}
                              </span>
                              <span className="block">
                                {t("dashboard:providers.calculatedCost", {
                                  value: showValue(row.calculatedCost),
                                  currency:
                                    row.calculatedCostCurrency ??
                                    t("dashboard:providers.unknownCurrency"),
                                })}
                              </span>
                              <span className="block">
                                {t("dashboard:providers.settledCost", {
                                  value: showValue(row.settledCost),
                                  currency:
                                    row.currency ?? t("dashboard:providers.unknownCurrency"),
                                })}
                              </span>
                            </td>
                            <td className="p-3">
                              {row.pricingVersion} · {row.accountingVersion}
                            </td>
                            <td className="p-3">
                              {row.confidence} ·{" "}
                              {row.categoriesComplete
                                ? t("dashboard:providers.complete")
                                : t("dashboard:providers.partial")}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </WideContent>
                )}
                {usage.data?.nextCursor ? (
                  <Button
                    type="button"
                    className="mt-3"
                    size="touch"
                    variant="outline"
                    onClick={() => setUsageCursor(usage.data.nextCursor ?? undefined)}
                  >
                    {t("dashboard:providers.actions.nextPage")}
                  </Button>
                ) : null}
                {usageCursor ? (
                  <Button
                    type="button"
                    className="mt-3 ms-2"
                    size="touch"
                    variant="ghost"
                    onClick={() => setUsageCursor(undefined)}
                  >
                    {t("dashboard:providers.actions.firstPage")}
                  </Button>
                ) : null}
                {budgets.data?.caveats.length ? (
                  <aside
                    className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4"
                    aria-labelledby="provider-billing-caveats-title"
                  >
                    <h4 id="provider-billing-caveats-title" className="text-sm font-medium">
                      {t("dashboard:providers.billingCaveatsTitle")}
                    </h4>
                    <ul className="mt-2 list-disc space-y-1 ps-5 text-xs text-muted-foreground">
                      {budgets.data.caveats.map((caveat) => (
                        <li key={caveat} className="break-words">
                          {t(`dashboard:providers.billingCaveats.${caveat}`)}
                        </li>
                      ))}
                    </ul>
                  </aside>
                ) : null}
                {budgets.isError ? (
                  <InlineRetry
                    message={t("dashboard:providers.budgetActivityFailed")}
                    onRetry={budgets.refetch}
                  />
                ) : null}
              </div>

              <div className="grid min-w-0 gap-6 lg:grid-cols-2">
                {attempts.isError ? (
                  <InlineRetry
                    message={t("dashboard:providers.attemptsFailed")}
                    onRetry={attempts.refetch}
                  />
                ) : (
                  <Timeline
                    title={t("dashboard:providers.attempts")}
                    empty={t("dashboard:providers.noAttempts")}
                    rows={
                      attempts.data?.map((row) => ({
                        id: row.id,
                        title: `${t(`dashboard:providers.enums.${row.eventType}`)} · ${t(`dashboard:providers.enums.${row.terminalState ?? row.reason ?? "UNKNOWN"}`)}`,
                        detail: `${showDate(row.createdAt)} · ${row.requestedSurface ?? "—"} → ${row.nativeSurface ?? "—"}`,
                      })) ?? []
                    }
                  />
                )}
                {audits.isError ? (
                  <InlineRetry
                    message={t("dashboard:providers.auditFailed")}
                    onRetry={audits.refetch}
                  />
                ) : (
                  <Timeline
                    title={t("dashboard:providers.audit")}
                    empty={t("dashboard:providers.noAudit")}
                    rows={
                      audits.data?.map((row) => ({
                        id: row.id,
                        title: t(`dashboard:providers.enums.${row.action}`),
                        detail: `${showDate(row.createdAt)} · ${row.subjectId}`,
                      })) ?? []
                    }
                  />
                )}
              </div>
              <div className="min-w-0 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="font-medium">{t("dashboard:providers.repairStatus")}</h3>
                  <Button
                    type="button"
                    size="touch"
                    variant="outline"
                    disabled={repairAttempts.isPending}
                    onClick={() => repairAttempts.mutate({ providerAccountId: selected.id })}
                  >
                    <Wrench className="size-4" /> {t("dashboard:providers.actions.repair")}
                  </Button>
                </div>
                {attemptStates.isError ? (
                  <InlineRetry
                    message={t("dashboard:providers.repairLoadFailed")}
                    onRetry={attemptStates.refetch}
                  />
                ) : attemptStates.isPending ? (
                  <Skeleton className="h-24" />
                ) : (
                  <Timeline
                    title={t("dashboard:providers.repairStatus")}
                    empty={t("dashboard:providers.noRepairItems")}
                    rows={
                      attemptStates.data?.items.map((row) => ({
                        id: row.id,
                        title: `${t(`dashboard:providers.enums.${row.state}`)} · ${t(`dashboard:providers.enums.${row.reconciliationStatus}`)}`,
                        detail: `${showDate(row.createdAt)} · ${row.stale ? t("dashboard:providers.stale") : t("dashboard:providers.current")}`,
                      })) ?? []
                    }
                  />
                )}
                <div className="flex gap-2">
                  {attemptStates.data?.nextCursor ? (
                    <Button
                      type="button"
                      size="touch"
                      variant="outline"
                      onClick={() => setAttemptCursor(attemptStates.data.nextCursor ?? undefined)}
                    >
                      {t("dashboard:providers.actions.nextPage")}
                    </Button>
                  ) : null}
                  {attemptCursor ? (
                    <Button
                      type="button"
                      size="touch"
                      variant="ghost"
                      onClick={() => setAttemptCursor(undefined)}
                    >
                      {t("dashboard:providers.actions.firstPage")}
                    </Button>
                  ) : null}
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("dashboard:providers.visibilityDisclosure")}
              </p>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function UpdateAccountForm({
  account,
  authTypeLocked,
}: {
  account: {
    id: string;
    label: string;
    baseUrl: string;
    providerType: string;
    authType: "API_KEY" | "BEARER";
  };
  authTypeLocked: boolean;
}) {
  const { t } = useTranslation(["common", "dashboard"]);
  const formRef = useRef<HTMLFormElement>(null);
  const queryClient = useQueryClient();
  const updateAccount = useMutation(
    orpc.providerManagement.updateAccount.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.providerManagement.key() }),
      onError: () => toast.error(t("dashboard:providers.feedback.failed")),
    }),
  );
  const form = useForm({
    defaultValues: {
      label: account.label,
      baseUrl: account.baseUrl,
      providerType: account.providerType,
      authType: account.authType,
    },
    validators: { onSubmit: providerAccountFormSchema },
    onSubmit: async ({ value }) => updateAccount.mutateAsync({ id: account.id, ...value }),
  });
  return (
    <form
      ref={formRef}
      noValidate
      className="grid gap-3 md:grid-cols-2 xl:grid-cols-4"
      onSubmit={(event) => submitProviderForm(event, form.handleSubmit)}
    >
      {(["label", "baseUrl", "providerType"] as const).map((name) => (
        <form.Field key={name} name={name}>
          {(field) => (
            <Field
              id={`provider-update-account-${account.id}-${name}`}
              errors={field.state.meta.errors}
              label={t(`dashboard:providers.fields.${name === "providerType" ? "type" : name}`)}
              className={name === "baseUrl" ? "xl:col-span-2" : undefined}
            >
              <Input
                type={name === "baseUrl" ? "url" : "text"}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            </Field>
          )}
        </form.Field>
      ))}
      <form.Field name="authType">
        {(field) => (
          <Field
            id={`provider-update-account-${account.id}-authType`}
            errors={field.state.meta.errors}
            label={t("dashboard:providers.fields.authType")}
          >
            <select
              disabled={authTypeLocked}
              className="h-11 w-full rounded-md border bg-background px-3 text-base sm:text-sm"
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value as "API_KEY" | "BEARER")}
            >
              <option value="BEARER">{t("dashboard:providers.enums.BEARER")}</option>
              <option value="API_KEY">{t("dashboard:providers.enums.API_KEY")}</option>
            </select>
          </Field>
        )}
      </form.Field>
      {authTypeLocked ? (
        <p className="self-end text-xs text-muted-foreground">
          {t("dashboard:providers.authTypeImmutable")}
        </p>
      ) : null}
      <Button
        type="submit"
        className="md:col-span-2 xl:col-span-4 xl:justify-self-start"
        size="touch"
        disabled={updateAccount.isPending}
      >
        {t("dashboard:providers.actions.saveAccount")}
      </Button>
    </form>
  );
}

function UpdateModelForm({
  model,
}: {
  model: {
    id: string;
    displayName: string | null;
    contextWindow: number | null;
    maxOutputTokens: number | null;
    concurrencyLimit: number | null;
  };
}) {
  const { t } = useTranslation(["common", "dashboard"]);
  const formRef = useRef<HTMLFormElement>(null);
  const queryClient = useQueryClient();
  const updateModel = useMutation(
    orpc.providerManagement.updateModel.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.providerManagement.key() }),
      onError: () => toast.error(t("dashboard:providers.feedback.failed")),
    }),
  );
  const form = useForm({
    defaultValues: {
      displayName: model.displayName ?? "",
      contextWindow: model.contextWindow?.toString() ?? "",
      maxOutputTokens: model.maxOutputTokens?.toString() ?? "",
      concurrencyLimit: model.concurrencyLimit?.toString() ?? "",
    },
    validators: { onSubmit: updateModelFormSchema },
    onSubmit: async ({ value }) => {
      const numberOrNull = (raw: string) => (raw ? Number(raw) : null);
      await updateModel.mutateAsync({
        id: model.id,
        displayName: value.displayName || null,
        contextWindow: numberOrNull(value.contextWindow),
        maxOutputTokens: numberOrNull(value.maxOutputTokens),
        concurrencyLimit: numberOrNull(value.concurrencyLimit),
      });
    },
  });
  return (
    <form
      ref={formRef}
      noValidate
      className="grid gap-3 pt-2 sm:grid-cols-2 lg:grid-cols-3"
      onSubmit={(event) => submitProviderForm(event, form.handleSubmit)}
    >
      {(["displayName", "contextWindow", "maxOutputTokens", "concurrencyLimit"] as const).map(
        (name) => (
          <form.Field key={name} name={name}>
            {(field) => (
              <Field
                id={`provider-update-model-${model.id}-${name}`}
                errors={field.state.meta.errors}
                label={t(
                  `dashboard:providers.fields.${name === "concurrencyLimit" ? "concurrency" : name}`,
                )}
              >
                <Input
                  type={name === "displayName" ? "text" : "number"}
                  min={name === "displayName" ? undefined : "1"}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
        ),
      )}
      <div className="flex items-end">
        <Button type="submit" size="touch" disabled={updateModel.isPending}>
          {t("dashboard:providers.actions.saveModel")}
        </Button>
      </div>
    </form>
  );
}

function Field({
  label,
  children,
  className = "",
  errors = [],
  id,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  errors?: unknown[];
  id?: string;
}) {
  const { t } = useTranslation("dashboard");
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const errorId = `${fieldId}-error`;
  const firstError = errors[0];
  const errorCode =
    typeof firstError === "string"
      ? firstError
      : typeof firstError === "object" && firstError && "message" in firstError
        ? String(firstError.message)
        : "invalid";
  const hasError = errors.length > 0;
  const child = isValidElement(children)
    ? cloneElement(
        children as ReactElement<{
          id?: string;
          "aria-invalid"?: boolean;
          "aria-describedby"?: string;
        }>,
        {
          id: (children.props as { id?: string }).id ?? fieldId,
          "aria-invalid": hasError,
          "aria-describedby": hasError ? errorId : undefined,
        },
      )
    : children;
  const childId = isValidElement(child) ? (child.props as { id?: string }).id : fieldId;
  return (
    <div className={`min-w-0 space-y-2 ${className}`}>
      <Label htmlFor={childId}>{label}</Label>
      {child}
      {hasError ? (
        <p id={errorId} className="text-sm text-destructive" role="alert">
          {t(`providers.validation.${errorCode}`, {
            defaultValue: t("providers.validation.invalid"),
          })}
        </p>
      ) : null}
    </div>
  );
}

export function BudgetRuleField({
  label,
  mode,
  value,
  onMode,
  onValue,
  decimal = false,
  errors = [],
  id,
}: {
  label: string;
  mode: "LIMITED" | "UNLIMITED";
  value: string;
  onMode: (mode: "LIMITED" | "UNLIMITED") => void;
  onValue: (value: string) => void;
  decimal?: boolean;
  errors?: unknown[];
  id: string;
}) {
  const { t } = useTranslation("dashboard");
  const modeId = `${id}-mode`;
  const valueId = `${id}-value`;
  const errorId = `${valueId}-error`;
  const hasError = errors.length > 0;
  const firstError = errors[0];
  const errorCode =
    typeof firstError === "string"
      ? firstError
      : typeof firstError === "object" && firstError && "message" in firstError
        ? String(firstError.message)
        : "invalid";
  return (
    <div
      className="min-w-0 space-y-2 rounded-xl border p-3"
      role="group"
      aria-labelledby={`${id}-label`}
    >
      <p id={`${id}-label`} className="text-sm font-medium">
        {label}
      </p>
      <Label htmlFor={modeId}>{t("providers.fields.limitMode")}</Label>
      <select
        id={modeId}
        className="h-11 w-full rounded-md border bg-background px-3 text-base sm:text-sm"
        value={mode}
        onChange={(event) => onMode(event.target.value as "LIMITED" | "UNLIMITED")}
      >
        <option value="LIMITED">{t("providers.enums.LIMITED")}</option>
        <option value="UNLIMITED">{t("providers.enums.UNLIMITED")}</option>
      </select>
      {mode === "LIMITED" ? (
        <>
          <Label htmlFor={valueId}>{t("providers.fields.limitValue")}</Label>
          <Input
            id={valueId}
            required
            type={decimal ? "text" : "number"}
            inputMode={decimal ? "decimal" : "numeric"}
            min={decimal ? undefined : "1"}
            value={value}
            onChange={(event) => onValue(event.target.value)}
            aria-invalid={hasError}
            aria-describedby={hasError ? errorId : undefined}
          />
          {hasError ? (
            <p id={errorId} className="text-sm text-destructive" role="alert">
              {t(`providers.validation.${errorCode}`, {
                defaultValue: t("providers.validation.invalid"),
              })}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-amber-700 dark:text-amber-300">
          {t("providers.unlimitedRuleWarning")}
        </p>
      )}
    </div>
  );
}

function Timeline({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: Array<{ id: string; title: string; detail: string }>;
}) {
  return (
    <div className="min-w-0">
      <h3 className="font-medium">{title}</h3>
      <div className="mt-3 max-h-72 divide-y overflow-x-hidden overflow-y-auto rounded-xl border overscroll-contain">
        {rows.length ? (
          rows.map((row) => (
            <div key={row.id} className="min-w-0 p-3">
              <p className="break-words text-sm font-medium">{row.title}</p>
              <p className="mt-1 break-words text-xs text-muted-foreground">{row.detail}</p>
            </div>
          ))
        ) : (
          <p className="p-4 text-sm text-muted-foreground">{empty}</p>
        )}
      </div>
    </div>
  );
}
