import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { AlertTriangle, KeyRound, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { WideContent } from "@/components/wide-content";
import { orpc } from "@/utils/orpc";

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const showDate = (value: Date | string | null | undefined) =>
  value ? dateTime.format(new Date(value)) : "—";
const showValue = (value: unknown) => (value === null || value === undefined ? "—" : String(value));

export function ProviderOperationsSection() {
  const { t } = useTranslation(["common", "dashboard"]);
  const queryClient = useQueryClient();
  const accounts = useQuery({
    ...orpc.providerManagement.listAccounts.queryOptions(),
    retry: false,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
  const usage = useQuery({
    ...orpc.providerManagement.listUsageReport.queryOptions({
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
  const [accountDraft, setAccountDraft] = useState({
    label: "",
    providerType: "openai",
    baseUrl: "https://api.openai.com/v1",
    authType: "BEARER" as "API_KEY" | "BEARER",
  });
  const [secret, setSecret] = useState("");
  const [modelDraft, setModelDraft] = useState({ upstreamModelId: "", displayName: "" });
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
  const policies = useQuery({
    ...orpc.providerManagement.listBudgetPolicies.queryOptions(),
    retry: false,
  });
  const [pricingDraft, setPricingDraft] = useState({
    version: "",
    currency: "USD",
    input: "",
    output: "",
  });
  const [limits, setLimits] = useState({
    concurrency: "1",
    tokens: "100000",
    spend: "10",
    unlimited: false,
  });
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: orpc.providerManagement.key() });
  const createAccount = useMutation(
    orpc.providerManagement.createAccount.mutationOptions({
      onSuccess: (account) => {
        setSelectedId(account.id);
        setAccountDraft((value) => ({ ...value, label: "" }));
        invalidate();
        toast.success(t("dashboard:providers.feedback.accountCreated"));
      },
      onError: () => toast.error(t("dashboard:providers.feedback.failed")),
    }),
  );
  const saveCredential = useMutation(
    orpc.providerManagement.createCredential.mutationOptions({
      onSuccess: () => {
        setSecret("");
        invalidate();
        toast.success(t("dashboard:providers.feedback.credentialSaved"));
      },
      onError: () => toast.error(t("dashboard:providers.feedback.failed")),
    }),
  );
  const replaceCredential = useMutation(
    orpc.providerManagement.replaceCredential.mutationOptions({
      onSuccess: () => {
        setSecret("");
        invalidate();
        toast.success(t("dashboard:providers.feedback.credentialReplaced"));
      },
      onError: () => toast.error(t("dashboard:providers.feedback.failed")),
    }),
  );
  const createModel = useMutation(
    orpc.providerManagement.createModel.mutationOptions({
      onSuccess: () => {
        setModelDraft({ upstreamModelId: "", displayName: "" });
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
        setPricingDraft({ version: "", currency: "USD", input: "", output: "" });
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
  const createBudget = useMutation(
    orpc.providerManagement.createBudgetPolicy.mutationOptions({
      onSuccess: () => {
        invalidate();
        toast.success(t("dashboard:providers.feedback.budgetSaved"));
      },
      onError: () => toast.error(t("dashboard:providers.feedback.failed")),
    }),
  );
  const reportPending = usage.isPending || budgets.isPending || attempts.isPending;
  const credentialActive = credentials.data?.find((item) => item.status === "ACTIVE");
  const spend = useMemo(
    () => usage.data?.reduce((sum, row) => sum + Number(row.settledCost ?? 0), 0) ?? 0,
    [usage.data],
  );

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
        className="mt-6 grid gap-3 rounded-xl border bg-muted/20 p-4 md:grid-cols-2 xl:grid-cols-5"
        onSubmit={(event) => {
          event.preventDefault();
          createAccount.mutate({ ...accountDraft, safeConfiguration: null });
        }}
      >
        <Field label={t("dashboard:providers.fields.label")}>
          <Input
            required
            value={accountDraft.label}
            onChange={(e) => setAccountDraft({ ...accountDraft, label: e.target.value })}
          />
        </Field>
        <Field label={t("dashboard:providers.fields.type")}>
          <Input
            required
            value={accountDraft.providerType}
            onChange={(e) =>
              setAccountDraft({ ...accountDraft, providerType: e.target.value.toLowerCase() })
            }
          />
        </Field>
        <Field label={t("dashboard:providers.fields.baseUrl")} className="md:col-span-2">
          <Input
            required
            type="url"
            value={accountDraft.baseUrl}
            onChange={(e) => setAccountDraft({ ...accountDraft, baseUrl: e.target.value })}
          />
        </Field>
        <div className="flex items-end">
          <Button
            className="w-full"
            size="touch"
            disabled={!accountDraft.label.trim() || createAccount.isPending}
          >
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
                onClick={() => setSelectedId(account.id)}
                className={`min-h-11 w-full rounded-xl border px-3 py-2 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected?.id === account.id ? "border-primary bg-primary/5" : "hover:bg-muted/50"}`}
              >
                <span className="block truncate text-sm font-medium">{account.label}</span>
                <span className="mt-1 block truncate text-xs text-muted-foreground">
                  {account.providerType} · {account.healthStatus}
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
                <Button
                  variant="outline"
                  size="touch"
                  disabled={!credentialActive || testCredential.isPending}
                  onClick={() => testCredential.mutate({ providerAccountId: selected.id })}
                >
                  <RefreshCw className="size-4" /> {t("dashboard:providers.actions.test")}
                </Button>
              </div>

              <div className="grid gap-6 lg:grid-cols-2">
                <form
                  className="min-w-0 space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const action = credentialActive ? replaceCredential : saveCredential;
                    action.mutate({ providerAccountId: selected.id, credential: secret });
                  }}
                >
                  <h3 className="flex items-center gap-2 font-medium">
                    <KeyRound className="size-4" />
                    {t("dashboard:providers.credentials")}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {credentialActive
                      ? t("dashboard:providers.activeSuffix", {
                          suffix: credentialActive.displaySuffix,
                        })
                      : t("dashboard:providers.noCredential")}
                  </p>
                  <Label htmlFor="provider-secret">
                    {credentialActive
                      ? t("dashboard:providers.fields.replacementSecret")
                      : t("dashboard:providers.fields.secret")}
                  </Label>
                  <Input
                    id="provider-secret"
                    type="password"
                    autoComplete="new-password"
                    required
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("dashboard:providers.secretNeverShown")}
                  </p>
                  <Button
                    size="touch"
                    disabled={!secret || saveCredential.isPending || replaceCredential.isPending}
                  >
                    {credentialActive
                      ? t("dashboard:providers.actions.replaceCredential")
                      : t("dashboard:providers.actions.saveCredential")}
                  </Button>
                </form>
                <form
                  className="min-w-0 space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    createModel.mutate({
                      providerAccountId: selected.id,
                      upstreamModelId: modelDraft.upstreamModelId,
                      displayName: modelDraft.displayName || null,
                      capabilityMetadata: null,
                      nativeCapabilities: null,
                      contextWindow: null,
                      maxOutputTokens: null,
                      concurrencyLimit: null,
                      pricingMetadata: null,
                      pricingVersion: null,
                      enabled: false,
                    });
                  }}
                >
                  <h3 className="font-medium">{t("dashboard:providers.models")}</h3>
                  <Field label={t("dashboard:providers.fields.upstreamModel")}>
                    <Input
                      required
                      value={modelDraft.upstreamModelId}
                      onChange={(event) =>
                        setModelDraft({ ...modelDraft, upstreamModelId: event.target.value })
                      }
                    />
                  </Field>
                  <Field label={t("dashboard:providers.fields.displayName")}>
                    <Input
                      value={modelDraft.displayName}
                      onChange={(event) =>
                        setModelDraft({ ...modelDraft, displayName: event.target.value })
                      }
                    />
                  </Field>
                  <Button
                    size="touch"
                    disabled={!modelDraft.upstreamModelId.trim() || createModel.isPending}
                  >
                    <Plus className="size-4" />
                    {t("dashboard:providers.actions.addModel")}
                  </Button>
                </form>
              </div>

              <div className="min-w-0">
                <h3 className="font-medium">{t("dashboard:providers.configuredModels")}</h3>
                <div className="mt-3 divide-y rounded-xl border">
                  {models.data?.map((model) => (
                    <div
                      key={model.id}
                      className="flex min-w-0 items-center justify-between gap-3 p-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {model.displayName || model.upstreamModelId}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {model.pricingVersion || t("dashboard:providers.noActivePricing")} ·{" "}
                          {model.healthStatus}
                        </p>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {model.enabled
                          ? t("dashboard:providers.enabled")
                          : t("dashboard:providers.disabled")}
                      </span>
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
                    className="min-w-0 space-y-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!activeModelId) return;
                      createPricing.mutate({
                        providerModelId: activeModelId,
                        version: pricingDraft.version,
                        currency: pricingDraft.currency,
                        accountingVersion: "provider-billable-v1",
                        confidence: "CALCULATED",
                        ratesPerMillion: { input: pricingDraft.input, output: pricingDraft.output },
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
                    }}
                  >
                    <h3 className="font-medium">{t("dashboard:providers.pricing")}</h3>
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
                      <Field label={t("dashboard:providers.fields.pricingVersion")}>
                        <Input
                          required
                          value={pricingDraft.version}
                          onChange={(event) =>
                            setPricingDraft({ ...pricingDraft, version: event.target.value })
                          }
                        />
                      </Field>
                      <Field label={t("dashboard:providers.fields.currency")}>
                        <Input
                          required
                          maxLength={3}
                          value={pricingDraft.currency}
                          onChange={(event) =>
                            setPricingDraft({
                              ...pricingDraft,
                              currency: event.target.value.toUpperCase(),
                            })
                          }
                        />
                      </Field>
                      <Field label={t("dashboard:providers.fields.inputRate")}>
                        <Input
                          required
                          inputMode="decimal"
                          value={pricingDraft.input}
                          onChange={(event) =>
                            setPricingDraft({ ...pricingDraft, input: event.target.value })
                          }
                        />
                      </Field>
                      <Field label={t("dashboard:providers.fields.outputRate")}>
                        <Input
                          required
                          inputMode="decimal"
                          value={pricingDraft.output}
                          onChange={(event) =>
                            setPricingDraft({ ...pricingDraft, output: event.target.value })
                          }
                        />
                      </Field>
                    </div>
                    <Button
                      size="touch"
                      disabled={
                        !pricingDraft.version ||
                        !pricingDraft.input ||
                        !pricingDraft.output ||
                        createPricing.isPending
                      }
                    >
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
                              {row.status} · {row.accountingVersion}
                            </p>
                          </div>
                          {row.status === "DRAFT" ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={activatePricing.isPending}
                              onClick={() => activatePricing.mutate({ id: row.id })}
                            >
                              {t("dashboard:providers.actions.activate")}
                            </Button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </form>
                  <form
                    className="min-w-0 space-y-3"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const unlimited = limits.unlimited;
                      createBudget.mutate({
                        scopeType: "PROVIDER_ACCOUNT",
                        providerAccountId: selected.id,
                        poolId: null,
                        providerModelId: null,
                        active: true,
                        rules: [
                          {
                            metric: "CONCURRENCY",
                            period: "PER_ATTEMPT",
                            mode: unlimited ? "UNLIMITED" : "LIMITED",
                            limitValue: unlimited ? null : limits.concurrency,
                            currency: null,
                          },
                          {
                            metric: "TOKENS",
                            period: "UTC_DAY",
                            mode: unlimited ? "UNLIMITED" : "LIMITED",
                            limitValue: unlimited ? null : limits.tokens,
                            currency: null,
                          },
                          {
                            metric: "SPEND",
                            period: "UTC_MONTH",
                            mode: unlimited ? "UNLIMITED" : "LIMITED",
                            limitValue: unlimited ? null : limits.spend,
                            currency: "USD",
                          },
                        ],
                      });
                    }}
                  >
                    <h3 className="font-medium">{t("dashboard:providers.budgets")}</h3>
                    <label className="flex min-h-11 items-center gap-3 rounded-md border px-3">
                      <input
                        type="checkbox"
                        checked={limits.unlimited}
                        onChange={(event) =>
                          setLimits({ ...limits, unlimited: event.target.checked })
                        }
                      />
                      <span className="text-sm">{t("dashboard:providers.fields.unlimited")}</span>
                    </label>
                    {!limits.unlimited ? (
                      <div className="grid gap-3 sm:grid-cols-3">
                        <Field label={t("dashboard:providers.fields.concurrency")}>
                          <Input
                            required
                            type="number"
                            min="1"
                            value={limits.concurrency}
                            onChange={(event) =>
                              setLimits({ ...limits, concurrency: event.target.value })
                            }
                          />
                        </Field>
                        <Field label={t("dashboard:providers.fields.tokensDay")}>
                          <Input
                            required
                            type="number"
                            min="1"
                            value={limits.tokens}
                            onChange={(event) =>
                              setLimits({ ...limits, tokens: event.target.value })
                            }
                          />
                        </Field>
                        <Field label={t("dashboard:providers.fields.spendMonth")}>
                          <Input
                            required
                            inputMode="decimal"
                            value={limits.spend}
                            onChange={(event) =>
                              setLimits({ ...limits, spend: event.target.value })
                            }
                          />
                        </Field>
                      </div>
                    ) : (
                      <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
                        {t("dashboard:providers.unlimitedWarning")}
                      </p>
                    )}
                    <Button
                      size="touch"
                      disabled={
                        createBudget.isPending ||
                        (!limits.unlimited &&
                          (!Number(limits.concurrency) ||
                            !Number(limits.tokens) ||
                            !Number(limits.spend)))
                      }
                    >
                      {t("dashboard:providers.actions.activateBudget")}
                    </Button>
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
                  </form>
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
                  <p className="text-sm font-medium">
                    {t("dashboard:providers.settledSpend", { value: spend.toFixed(6) })}
                  </p>
                </div>
                {reportPending ? (
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
                        {usage.data?.map((row) => (
                          <tr key={row.id}>
                            <td className="p-3">{showDate(row.createdAt)}</td>
                            <td className="p-3">
                              {showValue(row.inputTokens)} / {showValue(row.outputTokens)} ·{" "}
                              {showValue(row.billableTotal)}
                            </td>
                            <td className="p-3">
                              {showValue(row.reportedCost)} / {showValue(row.calculatedCost)}{" "}
                              {row.currency ?? row.reportedCostCurrency ?? ""}
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
                <p className="mt-3 text-xs text-muted-foreground">
                  {budgets.data?.caveat ?? t("dashboard:providers.invoiceCaveat")}
                </p>
              </div>

              <div className="grid min-w-0 gap-6 lg:grid-cols-2">
                <Timeline
                  title={t("dashboard:providers.attempts")}
                  empty={t("dashboard:providers.noAttempts")}
                  rows={
                    attempts.data?.map((row) => ({
                      id: row.id,
                      title: `${row.eventType} · ${row.terminalState ?? row.reason ?? "—"}`,
                      detail: `${showDate(row.createdAt)} · ${row.requestedSurface ?? "—"} → ${row.nativeSurface ?? "—"}`,
                    })) ?? []
                  }
                />
                <Timeline
                  title={t("dashboard:providers.audit")}
                  empty={t("dashboard:providers.noAudit")}
                  rows={
                    audits.data?.map((row) => ({
                      id: row.id,
                      title: row.action,
                      detail: `${showDate(row.createdAt)} · ${row.subjectId}`,
                    })) ?? []
                  }
                />
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

function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`min-w-0 space-y-2 ${className}`}>
      <Label>{label}</Label>
      {children}
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
