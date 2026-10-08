import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { Button } from "@ws-model-proxy/ui/components/button";
import { Input } from "@ws-model-proxy/ui/components/input";
import { Label } from "@ws-model-proxy/ui/components/label";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { Search } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { InlineRetry } from "@/components/inline-retry";
import { StatusPill } from "@/components/status-pill";
import { orpc } from "@/utils/orpc";

export type CatalogModel = Awaited<
  ReturnType<AppRouterClient["providers"]["catalog"]["search"]>
>["models"][number];

/** Search the OpenRouter catalog; picking a result fills the add-model form. */
export function CatalogSearch({ onPick }: { onPick: (model: CatalogModel) => void }) {
  const { t } = useTranslation(["dashboard"]);
  const [query, setQuery] = useState("");
  const results = useQuery({
    ...orpc.providers.catalog.search.queryOptions({ input: { query } }),
    enabled: query !== "",
    retry: false,
  });
  const form = useForm({
    defaultValues: { query: "" },
    validators: { onSubmit: z.object({ query: z.string().trim().min(1).max(200) }) },
    onSubmit: ({ value }) => setQuery(value.query.trim()),
  });
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <form
        role="search"
        className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          form.handleSubmit().catch(() => undefined);
        }}
      >
        <form.Field name="query">
          {(field) => (
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor="catalog-query">{t("dashboard:providers.catalog.label")}</Label>
              <Input
                id="catalog-query"
                type="search"
                className="h-11"
                placeholder={t("dashboard:providers.catalog.placeholder")}
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            </div>
          )}
        </form.Field>
        <Button type="submit" size="touch" variant="outline">
          <Search aria-hidden="true" />
          {t("dashboard:providers.catalog.search")}
        </Button>
      </form>
      {query === "" ? null : results.isPending ? (
        <div className="space-y-2" aria-hidden="true">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      ) : results.isError ? (
        <InlineRetry
          message={t("dashboard:providers.catalog.failed")}
          onRetry={() => results.refetch()}
        />
      ) : results.data.models.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("dashboard:providers.catalog.none", { query })}
        </p>
      ) : (
        <ul
          aria-label={t("dashboard:providers.catalog.results")}
          className="flex max-h-72 min-w-0 flex-col divide-y overflow-x-hidden overflow-y-auto overscroll-contain rounded-md border"
        >
          {results.data.models.map((model) => (
            <li key={model.id} className="flex min-w-0 flex-wrap items-center gap-2 px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="break-all font-mono text-sm">{model.id}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {model.name}
                  {model.contextWindow
                    ? ` · ${t("dashboard:providers.catalog.context", { tokens: model.contextWindow })}`
                    : ""}
                </p>
              </div>
              <StatusPill tone="info">{t(`dashboard:models.type.${model.type}`)}</StatusPill>
              <Button
                type="button"
                size="touch"
                variant="ghost"
                aria-label={t("dashboard:providers.catalog.useModel", { model: model.id })}
                onClick={() => onPick(model)}
              >
                {t("dashboard:providers.catalog.use")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
