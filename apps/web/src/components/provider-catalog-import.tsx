import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { Button } from "@ws-model-proxy/ui/components/button";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { Download } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  ProviderCatalogPicker,
  type ProviderCatalogRow,
  ProviderCatalogRowSummary,
} from "@/components/provider-catalog-picker";
import { orpc } from "@/utils/orpc";

type CatalogPricingOutcome = Awaited<
  ReturnType<AppRouterClient["providerCatalog"]["importModel"]>
>["pricing"];

/** What the import did to the price; `created` and `unchanged` need no note. */
const pricingNoteKey = {
  created: null,
  unchanged: null,
  updated: "dashboard:providerCatalog.import.pricingUpdated",
  unknown: "dashboard:providerCatalog.import.pricingUnknown",
  catalogPricingRetired: "dashboard:providerCatalog.import.pricingCatalogRetired",
  userPricingKept: "dashboard:providerCatalog.import.pricingUserKept",
  scheduledPricingExists: "dashboard:providerCatalog.import.pricingScheduled",
} as const satisfies Record<CatalogPricingOutcome, string | null>;

/**
 * "Import from catalog" for the caller's own OpenRouter account: picks a
 * catalog model and creates (or refreshes) the provider model with its
 * context, capabilities and an ACTIVE catalog price.
 */
export function ProviderCatalogImport({ providerAccountId }: { providerAccountId: string }) {
  const { t } = useTranslation(["dashboard"]);
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<ProviderCatalogRow | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const importModel = useMutation({
    ...orpc.providerCatalog.importModel.mutationOptions({
      onSuccess: (result) => {
        void queryClient.invalidateQueries({ queryKey: orpc.providerManagement.key() });
        toast.success(
          result.created
            ? t("dashboard:providerCatalog.import.success")
            : t("dashboard:providerCatalog.import.updated"),
        );
        const next: string[] = [];
        const pricingNote = pricingNoteKey[result.pricing];
        if (pricingNote) next.push(t(pricingNote));
        if (result.priceTiered) next.push(t("dashboard:providerCatalog.import.pricingTiered"));
        if (result.contextWindowDrift)
          next.push(
            t("dashboard:providerCatalog.import.contextDrift", {
              catalog: result.contextWindowDrift.catalog ?? "—",
              current: result.contextWindowDrift.current ?? "—",
            }),
          );
        setNotes(next);
      },
    }),
    meta: { errorFallbackKey: "dashboard:providerCatalog.import.failed" },
  });

  return (
    <section
      className="min-w-0 space-y-3 rounded-xl border p-4"
      aria-labelledby="provider-catalog-import-title"
    >
      <div>
        <h3 id="provider-catalog-import-title" className="flex items-center gap-2 font-medium">
          <Download className="size-4" />
          {t("dashboard:providerCatalog.import.title")}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("dashboard:providerCatalog.import.description")}
        </p>
      </div>
      <ProviderCatalogPicker
        selectedId={selected?.id ?? null}
        onSelect={(row) => {
          setSelected(row);
          setNotes([]);
        }}
      />
      {selected ? (
        <div className="min-w-0 rounded-md border bg-muted/20 p-3 text-xs">
          <ProviderCatalogRowSummary row={selected} />
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {t("dashboard:providerCatalog.import.disabledHint")}
      </p>
      <Button
        type="button"
        size="touch"
        disabled={!selected || importModel.isPending}
        onClick={() => {
          if (!selected) return;
          importModel.mutate({ providerAccountId, modelId: selected.id });
        }}
      >
        {importModel.isPending
          ? t("dashboard:providerCatalog.import.pending")
          : t("dashboard:providerCatalog.import.action")}
      </Button>
      {notes.length > 0 ? (
        <ul className="space-y-1 text-xs text-muted-foreground" aria-live="polite">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
