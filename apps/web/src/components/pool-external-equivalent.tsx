import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ws-model-proxy/ui/components/button";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import {
  ProviderCatalogPicker,
  type ProviderCatalogRow,
  ProviderCatalogRowSummary,
} from "@/components/provider-catalog-picker";
import { orpc } from "@/utils/orpc";

/**
 * Owner-side declaration of the pool's external equivalent (an OpenRouter
 * catalog id). Declaring it is the owner's consent that people who can use
 * this pool may bring their own provider keys (BYOK); it is also the default
 * suggestion while each user picks their own model. Clearing withdraws that
 * consent and works with the switch off.
 */
export function PoolExternalEquivalentSection({ poolId }: { poolId: string }) {
  const { t } = useTranslation(["dashboard"]);
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<ProviderCatalogRow | null>(null);
  const current = useQuery({
    ...orpc.providerCatalog.getPoolExternalEquivalent.queryOptions({ input: { poolId } }),
    retry: false,
  });
  const save = useMutation({
    ...orpc.providerCatalog.setPoolExternalEquivalent.mutationOptions({
      onSuccess: (result) => {
        void queryClient.invalidateQueries({ queryKey: orpc.providerCatalog.key() });
        setSelected(null);
        toast.success(
          result.externalEquivalentModel
            ? t("dashboard:providerCatalog.equivalent.saved")
            : t("dashboard:providerCatalog.equivalent.cleared"),
        );
      },
    }),
    meta: { errorFallbackKey: "dashboard:providerCatalog.equivalent.failed" },
  });

  const header = (
    <div>
      <h3 id="pool-external-equivalent-title" className="text-base font-semibold">
        {t("dashboard:providerCatalog.equivalent.title")}
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        {t("dashboard:providerCatalog.equivalent.description")}
      </p>
    </div>
  );

  if (current.isPending)
    return (
      <section className="space-y-3 border-t pt-6" aria-labelledby="pool-external-equivalent-title">
        {header}
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-40 w-full" />
      </section>
    );
  if (current.isError)
    return (
      <section className="space-y-3 border-t pt-6" aria-labelledby="pool-external-equivalent-title">
        {header}
        <InlineRetry
          message={t("dashboard:providerCatalog.equivalent.loadFailed")}
          onRetry={() => void current.refetch()}
        />
      </section>
    );

  const { externalEquivalentModel, providerEgressEnabled } = current.data;
  return (
    <section
      className="min-w-0 space-y-3 border-t pt-6"
      aria-labelledby="pool-external-equivalent-title"
    >
      {header}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-md border p-3">
        {externalEquivalentModel ? (
          <code className="min-w-0 break-all text-xs">
            {t("dashboard:providerCatalog.equivalent.current", { model: externalEquivalentModel })}
          </code>
        ) : (
          <span className="text-sm text-muted-foreground">
            {t("dashboard:providerCatalog.equivalent.none")}
          </span>
        )}
        {externalEquivalentModel ? (
          <Button
            type="button"
            size="touch"
            variant="outline"
            disabled={save.isPending}
            onClick={() => save.mutate({ poolId, modelId: null })}
          >
            {t("dashboard:providerCatalog.equivalent.clear")}
          </Button>
        ) : null}
      </div>
      {providerEgressEnabled ? (
        <>
          <ProviderCatalogPicker
            poolId={poolId}
            selectedId={selected?.id ?? externalEquivalentModel}
            onSelect={setSelected}
          />
          {selected ? (
            <div className="min-w-0 rounded-md border bg-muted/20 p-3 text-xs">
              <ProviderCatalogRowSummary row={selected} />
            </div>
          ) : null}
          <Button
            type="button"
            size="touch"
            disabled={!selected || save.isPending || selected.id === externalEquivalentModel}
            onClick={() => {
              if (selected) save.mutate({ poolId, modelId: selected.id });
            }}
          >
            {t("dashboard:providerCatalog.equivalent.save")}
          </Button>
        </>
      ) : (
        <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
          {t("dashboard:providerCatalog.equivalent.disabled")}
        </p>
      )}
    </section>
  );
}
