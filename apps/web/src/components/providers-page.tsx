import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { InlineRetry } from "@/components/inline-retry";
import { ProviderCatalogPicker } from "@/components/provider-catalog-picker";
import { ProviderOperationsSection } from "@/components/provider-operations-section";
import { orpc } from "@/utils/orpc";

type Pool = Awaited<
  ReturnType<AppRouterClient["poolFallbackPreferences"]["list"]>
>["pools"][number];
const choiceSchema = z.object({
  providerAccountId: z.string().min(1),
  modelId: z.string().min(1),
  protocolAdaptationEnabled: z.boolean(),
});

export function ProvidersPage() {
  const { t } = useTranslation("dashboard");
  const [tab, setTab] = useState<"keys" | "pools">("keys");
  const tabId = useId();
  return (
    <div className="min-w-0 max-w-full space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("byok.title")}</h1>
        <p className="mt-2 max-w-prose text-sm text-muted-foreground">{t("byok.description")}</p>
      </div>
      <div role="tablist" aria-label={t("byok.title")} className="flex gap-2 border-b pb-2">
        {(["keys", "pools"] as const).map((value) => (
          <Button
            key={value}
            type="button"
            role="tab"
            size="touch"
            variant={tab === value ? "secondary" : "ghost"}
            id={`${tabId}-${value}`}
            aria-controls={`${tabId}-panel-${value}`}
            aria-selected={tab === value}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? "keys"
                  : event.key === "End"
                    ? "pools"
                    : value === "keys"
                      ? "pools"
                      : "keys";
              setTab(next);
              document.getElementById(`${tabId}-${next}`)?.focus();
            }}
          >
            {t(`byok.${value}`)}
          </Button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${tabId}-panel-${tab}`}
        aria-labelledby={`${tabId}-${tab}`}
        tabIndex={0}
      >
        {tab === "keys" ? <ProviderOperationsSection /> : <OwnKeyPools />}
      </div>
    </div>
  );
}

export function OwnKeyPools() {
  const { t } = useTranslation("dashboard");
  const choices = useQuery(orpc.poolFallbackPreferences.list.queryOptions());
  if (choices.isPending)
    return (
      <div className="space-y-4 py-4">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-44 w-full" />
        <Skeleton className="h-44 w-full" />
      </div>
    );
  if (choices.isError) return <InlineRetry onRetry={() => void choices.refetch()} />;
  return (
    <div className="min-w-0 space-y-6 pt-4">
      <p className="max-w-prose text-sm text-muted-foreground">{t("byok.media")}</p>
      {!choices.data.enabled && <p role="status">{t("byok.disabled")}</p>}
      {choices.data.pools.length === 0 && <p>{t("byok.empty")}</p>}
      {choices.data.pools.map((pool) => (
        <PoolChoice key={pool.id} pool={pool} enabled={choices.data.enabled} />
      ))}
    </div>
  );
}

function PoolChoice({ pool, enabled }: { pool: Pool; enabled: boolean }) {
  const { t } = useTranslation("dashboard");
  const queryClient = useQueryClient();
  const accountLabelId = useId();
  const existingLabelId = useId();
  const [accountId, setAccountId] = useState("");
  const accounts = useQuery(orpc.providerManagement.listAccounts.queryOptions());
  const models = useQuery(
    orpc.providerManagement.listModels.queryOptions({
      input: { providerAccountId: accountId },
      enabled: Boolean(accountId),
    }),
  );
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: orpc.poolFallbackPreferences.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.providerManagement.key() });
  };
  const setChoice = useMutation({
    ...orpc.poolFallbackPreferences.set.mutationOptions({ onSuccess: invalidate }),
    meta: { errorFallbackKey: "dashboard:byok.failed" },
  });
  const clear = useMutation({
    ...orpc.poolFallbackPreferences.clear.mutationOptions({ onSuccess: invalidate }),
    meta: { errorFallbackKey: "dashboard:byok.failed" },
  });
  const enableModel = useMutation({
    ...orpc.providerManagement.updateModel.mutationOptions(),
    meta: { errorFallbackKey: "dashboard:byok.failed" },
  });
  const importModel = useMutation({
    ...orpc.providerCatalog.importModel.mutationOptions(),
    meta: { errorFallbackKey: "dashboard:byok.failed" },
  });
  const form = useForm({
    defaultValues: {
      providerAccountId: "",
      modelId: pool.externalEquivalentModel ?? "",
      protocolAdaptationEnabled: pool.protocolAdaptationEnabled,
    },
    validators: { onSubmit: choiceSchema },
    onSubmit: async ({ value }) => {
      const imported = await importModel.mutateAsync({
        providerAccountId: value.providerAccountId,
        modelId: value.modelId,
        enabled: true,
      });
      if (!imported.model.enabled)
        await enableModel.mutateAsync({ id: imported.model.id, enabled: true });
      await setChoice.mutateAsync({
        poolId: pool.id,
        providerModelId: imported.model.id,
        protocolAdaptationEnabled: value.protocolAdaptationEnabled,
      });
    },
  });
  const writable = enabled && Boolean(pool.externalEquivalentModel);
  const busy =
    setChoice.isPending || importModel.isPending || enableModel.isPending || clear.isPending;
  const account = accounts.data?.find((item) => item.id === accountId);
  return (
    <section className="min-w-0 space-y-3 border-t py-5" aria-label={pool.name}>
      <div>
        <h2 className="font-semibold">{pool.name}</h2>
        <p className="break-all text-sm text-muted-foreground">{pool.modelId}:external</p>
      </div>
      <p className="text-sm" role="status">
        {!pool.externalEquivalentModel
          ? t("byok.ownerMissing")
          : !pool.providerModelId
            ? t("byok.unset")
            : pool.ready
              ? t("byok.ready", { model: pool.upstreamModelId })
              : t("byok.unavailable")}
      </p>
      {!pool.tokenAllowed && (
        <p className="text-sm text-muted-foreground">{t("byok.tokenMissing")}</p>
      )}
      {pool.providerModelId && (
        <Button
          type="button"
          variant="outline"
          size="touch"
          disabled={busy}
          onClick={() => clear.mutate({ poolId: pool.id })}
        >
          {t("byok.clear")}
        </Button>
      )}
      {writable && (
        <form
          className="min-w-0 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit().catch(() => undefined);
          }}
        >
          <form.Field name="protocolAdaptationEnabled">
            {(field) => (
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={field.state.value}
                  disabled={busy}
                  onChange={(event) => {
                    field.handleChange(event.target.checked);
                    if (pool.providerModelId)
                      setChoice.mutate({
                        poolId: pool.id,
                        providerModelId: pool.providerModelId,
                        protocolAdaptationEnabled: event.target.checked,
                      });
                  }}
                />
                {t("byok.adaptation")}
              </label>
            )}
          </form.Field>
          <label className="block text-sm" htmlFor={accountLabelId}>
            {t("byok.account")}
          </label>
          <form.Field name="providerAccountId">
            {(field) => (
              <select
                id={accountLabelId}
                className="min-h-11 w-full rounded-md border bg-background px-3"
                value={field.state.value}
                disabled={busy}
                onChange={(event) => {
                  field.handleChange(event.target.value);
                  setAccountId(event.target.value);
                }}
              >
                <option value="">{t("byok.chooseAccount")}</option>
                {accounts.data?.map((item) => (
                  <option key={item.id} value={item.id} disabled={!item.enabled}>
                    {item.label}
                  </option>
                ))}
              </select>
            )}
          </form.Field>
          {accounts.isError && <InlineRetry onRetry={() => void accounts.refetch()} />}
          {accountId && (
            <>
              <label className="block text-sm" htmlFor={existingLabelId}>
                {t("byok.existing")}
              </label>
              <select
                id={existingLabelId}
                className="min-h-11 w-full rounded-md border bg-background px-3"
                value={pool.providerModelId ?? ""}
                disabled={busy || models.isPending}
                onChange={(event) => {
                  if (event.target.value)
                    setChoice.mutate({
                      poolId: pool.id,
                      providerModelId: event.target.value,
                      protocolAdaptationEnabled: form.state.values.protocolAdaptationEnabled,
                    });
                }}
              >
                <option value="">{t("byok.chooseModel")}</option>
                {models.data?.map((model) => (
                  <option key={model.id} value={model.id} disabled={!model.enabled}>
                    {model.upstreamModelId}
                  </option>
                ))}
              </select>
            </>
          )}
          {models.isError && <InlineRetry onRetry={() => void models.refetch()} />}
          {account?.providerType === "openrouter" && (
            <>
              <form.Field name="modelId">
                {(field) => (
                  <ProviderCatalogPicker
                    poolId={pool.id}
                    selectedId={field.state.value}
                    initialQuery={pool.externalEquivalentModel ?? ""}
                    onSelect={(row) => field.handleChange(row.id)}
                    disabled={busy}
                  />
                )}
              </form.Field>
              <p className="text-xs text-muted-foreground">{t("byok.nonToken")}</p>
              <Button type="submit" size="touch" disabled={busy}>
                {busy ? t("byok.saving") : t("byok.importUse")}
              </Button>
            </>
          )}
        </form>
      )}
    </section>
  );
}

export function OwnKeyAggregate({ poolId }: { poolId: string }) {
  const { t } = useTranslation("dashboard");
  const aggregate = useQuery(
    orpc.poolFallbackPreferences.ownerAggregate.queryOptions({ input: { poolId } }),
  );
  if (aggregate.isPending) return <Skeleton className="h-6 w-64" />;
  if (aggregate.isError) return <InlineRetry onRetry={() => void aggregate.refetch()} />;
  return (
    <p className="text-sm text-muted-foreground">
      {t("byok.aggregate", { count: aggregate.data.count })}
    </p>
  );
}
