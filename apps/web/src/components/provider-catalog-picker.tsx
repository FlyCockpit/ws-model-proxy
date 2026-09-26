import { perTokenToPerMillion } from "@ws-model-proxy/api/lib/provider-catalog-model";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { Button } from "@ws-model-proxy/ui/components/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@ws-model-proxy/ui/components/command";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { AlertTriangle, Ban, Brain, Image, Wrench } from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { useProviderCatalogSearch } from "@/hooks/use-provider-catalog-search";

export type ProviderCatalogRow = Awaited<
  ReturnType<AppRouterClient["providerCatalog"]["search"]>
>["items"][number];

function perMillion(value: string | null): string | null {
  return value === null ? null : perTokenToPerMillion(value);
}

function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "warn" }) {
  return (
    <span
      className={
        tone === "warn"
          ? "inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:text-amber-300"
          : "inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
      }
    >
      {children}
    </span>
  );
}

/** One catalog row: name, id, context, price, capability badges and verdict reasons. */
export function ProviderCatalogRowSummary({ row }: { row: ProviderCatalogRow }) {
  const { t, i18n } = useTranslation(["dashboard"]);
  const compact = useMemo(
    () => new Intl.NumberFormat(i18n.language, { notation: "compact", maximumFractionDigits: 1 }),
    [i18n.language],
  );
  const input = perMillion(row.pricing.prompt);
  const output = perMillion(row.pricing.completion);
  const blocked = row.compatibility.verdict === "block";
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1 text-left">
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 truncate font-medium" title={row.name}>
          {row.name}
        </span>
        {row.free ? <Badge>{t("dashboard:providerCatalog.picker.free")}</Badge> : null}
      </span>
      <span className="break-all font-mono text-[11px] text-muted-foreground">{row.id}</span>
      <span className="flex flex-wrap items-center gap-1.5">
        <Badge>
          {row.contextLength === null
            ? t("dashboard:providerCatalog.picker.contextUnknown")
            : t("dashboard:providerCatalog.picker.context", {
                value: compact.format(row.contextLength),
              })}
        </Badge>
        <Badge>
          {row.pricing.variable
            ? t("dashboard:providerCatalog.picker.priceVaries")
            : input === null || output === null
              ? t("dashboard:providerCatalog.picker.priceUnknown")
              : row.pricing.tiered
                ? t("dashboard:providerCatalog.picker.priceTiered", { input, output })
                : t("dashboard:providerCatalog.picker.price", { input, output })}
        </Badge>
        {row.supportsTools ? (
          <Badge>
            <Wrench className="size-3" aria-hidden />
            {t("dashboard:providerCatalog.picker.tools")}
          </Badge>
        ) : null}
        {row.supportsReasoning ? (
          <Badge>
            <Brain className="size-3" aria-hidden />
            {t("dashboard:providerCatalog.picker.reasoning")}
          </Badge>
        ) : null}
        {row.inputModalities.includes("image") ? (
          <Badge>
            <Image className="size-3" aria-hidden />
            {t("dashboard:providerCatalog.picker.vision")}
          </Badge>
        ) : null}
      </span>
      {blocked || row.compatibility.warn.length > 0 ? (
        <span className="flex flex-wrap items-center gap-1.5">
          {row.compatibility.block.map((reason) => (
            <Badge key={reason} tone="warn">
              <Ban className="size-3" aria-hidden />
              {t(`dashboard:providerCatalog.reasons.${reason}`)}
            </Badge>
          ))}
          {row.compatibility.warn.map((reason) => (
            <Badge key={reason} tone="warn">
              <AlertTriangle className="size-3" aria-hidden />
              {t(`dashboard:providerCatalog.reasons.${reason}`)}
            </Badge>
          ))}
        </span>
      ) : null}
    </span>
  );
}

function PickerSkeleton() {
  return (
    <div className="space-y-2 p-2" aria-hidden>
      {[0, 1, 2].map((index) => (
        <div key={index} className="space-y-1.5 py-1">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      ))}
    </div>
  );
}

/**
 * Searchable OpenRouter catalog list (inline shadcn Command). Blocked models
 * are shown but cannot be picked. `poolId` adds verdicts against that pool.
 */
export function ProviderCatalogPicker({
  poolId,
  selectedId,
  onSelect,
  disabled = false,
}: {
  poolId?: string;
  selectedId?: string | null;
  onSelect: (row: ProviderCatalogRow) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation(["dashboard"]);
  const toolsId = useId();
  const [query, setQuery] = useState("");
  const [toolsOnly, setToolsOnly] = useState(false);
  const search = useProviderCatalogSearch({ query, poolId, toolsOnly, enabled: !disabled });

  const body = (() => {
    // A disabled picker never runs its query, so it would otherwise stay pending.
    if (disabled) return null;
    if (search.isPending) return <PickerSkeleton />;
    if (search.isError)
      return (
        <InlineRetry
          className="m-2"
          message={t("dashboard:providerCatalog.picker.loadFailed")}
          onRetry={search.refetch}
        />
      );
    if (search.status === "disabled")
      return (
        <p className="p-3 text-sm text-muted-foreground">
          {t("dashboard:providerCatalog.picker.disabled")}
        </p>
      );
    if (search.status === "unavailable")
      return (
        <InlineRetry
          className="m-2"
          message={t("dashboard:providerCatalog.picker.unavailable")}
          onRetry={search.refetch}
        />
      );
    return (
      <>
        <CommandList
          aria-busy={search.isSettling}
          className="max-h-80 overflow-y-auto overflow-x-hidden overscroll-contain"
        >
          <CommandEmpty>{t("dashboard:providerCatalog.picker.empty")}</CommandEmpty>
          {search.rows.length > 0 ? (
            <CommandGroup>
              {search.rows.map((row) => (
                <CommandItem
                  key={row.id}
                  value={row.id}
                  disabled={row.compatibility.verdict === "block"}
                  data-checked={row.id === selectedId}
                  className="min-h-11 items-start py-2"
                  onSelect={() => onSelect(row)}
                >
                  <ProviderCatalogRowSummary row={row} />
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
        {search.hasNextPage ? (
          <div className="border-t p-2">
            <Button
              type="button"
              variant="outline"
              size="touch"
              className="w-full"
              disabled={search.isFetchingNextPage}
              onClick={search.fetchNextPage}
            >
              {t("dashboard:providerCatalog.picker.loadMore")}
            </Button>
          </div>
        ) : null}
      </>
    );
  })();

  return (
    <div className="min-w-0 space-y-2">
      <Command shouldFilter={false} className="rounded-md border">
        <CommandInput
          aria-label={t("dashboard:providerCatalog.picker.label")}
          placeholder={t("dashboard:providerCatalog.picker.placeholder")}
          value={query}
          onValueChange={setQuery}
          disabled={disabled}
        />
        {body}
      </Command>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={toolsId} className="flex min-h-11 items-center gap-2 text-sm">
          <input
            id={toolsId}
            type="checkbox"
            className="size-4"
            checked={toolsOnly}
            disabled={disabled}
            onChange={(event) => setToolsOnly(event.target.checked)}
          />
          {t("dashboard:providerCatalog.picker.toolsOnly")}
        </label>
        {search.stale ? (
          <span className="text-xs text-muted-foreground">
            {t("dashboard:providerCatalog.picker.stale")}
          </span>
        ) : null}
      </div>
    </div>
  );
}
