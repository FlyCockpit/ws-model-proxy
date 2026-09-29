import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { orpc } from "@/utils/orpc";

type SourceStatus = {
  name: string;
  origin: "local" | "remote";
  state: string;
  error?: string;
  intervalSecs?: number;
};

const STATES = new Set([
  "active",
  "pending_approval",
  "refused",
  "unsupported",
  "disabled",
  "failing",
]);
const ERRORS = new Set(["spawn", "timeout", "exit_status", "output_too_large", "parse"]);

function reportedSources(nodeMetrics: unknown): SourceStatus[] {
  if (!nodeMetrics || typeof nodeMetrics !== "object") return [];
  const sources = (nodeMetrics as { sources?: unknown }).sources;
  if (!Array.isArray(sources)) return [];
  return sources.flatMap((entry): SourceStatus[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || typeof record.state !== "string") return [];
    if (record.origin !== "local" && record.origin !== "remote") return [];
    return [
      {
        name: record.name,
        origin: record.origin,
        state: record.state,
        error: typeof record.error === "string" ? record.error : undefined,
        intervalSecs: typeof record.intervalSecs === "number" ? record.intervalSecs : undefined,
      },
    ];
  });
}

function seriesKey(series: { name: string; labels: Record<string, string> }): string {
  const labels = Object.entries(series.labels);
  if (labels.length === 0) return series.name;
  return `${series.name}{${labels.map(([key, value]) => `${key}="${value}"`).join(",")}}`;
}

/**
 * A device's custom metric sources (S-B part 2): the CLI's own view of each
 * (local or remote; active, pending approval, refused, ...) plus remote
 * definitions the server holds that the CLI has not reported yet. Loaded
 * when opened.
 */
export function CliDeviceMetricSources({ cliDeviceId }: { cliDeviceId: string }) {
  const { t } = useTranslation(["dashboard"]);
  const [open, setOpen] = useState(false);
  const metrics = useQuery({
    ...orpc.forwarderManagement.getCliDeviceMetrics.queryOptions({ input: { cliDeviceId } }),
    enabled: open,
  });
  const reported = reportedSources(metrics.data?.nodeMetrics);
  const customSeries = (metrics.data?.series ?? []).filter((series) => series.origin === "custom");
  const unreported = (metrics.data?.remoteMetricSources ?? []).filter(
    (source) => !reported.some((entry) => entry.origin === "remote" && entry.name === source.name),
  );
  return (
    <details
      className="border-b"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-4 text-sm font-medium">
        <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
        {t("dashboard:clis.metricSources.title")}
      </summary>
      <div className="min-w-0 space-y-2 px-4 pb-4">
        {!open ? null : metrics.isPending ? (
          <div aria-busy="true" className="space-y-2">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-2/3" />
          </div>
        ) : metrics.isError ? (
          <InlineRetry
            message={t("dashboard:clis.metricSources.loadFailed")}
            onRetry={metrics.refetch}
          />
        ) : reported.length === 0 && unreported.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("dashboard:clis.metricSources.empty")}</p>
        ) : (
          <ul className="space-y-2">
            {reported.map((source) => (
              <li key={`${source.origin}:${source.name}`} className="min-w-0 border p-2 text-xs">
                <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <code className="break-all font-mono">{source.name}</code>
                  <span className="text-muted-foreground">
                    {t(`dashboard:clis.metricSources.origins.${source.origin}`)}
                  </span>
                  <span>
                    {STATES.has(source.state)
                      ? t(`dashboard:clis.metricSources.states.${source.state}`)
                      : source.state}
                  </span>
                  {source.error && ERRORS.has(source.error) ? (
                    <span className="text-amber-700 dark:text-amber-300">
                      {t(`dashboard:clis.metricSources.errors.${source.error}`)}
                    </span>
                  ) : null}
                  {source.intervalSecs ? (
                    <span className="text-muted-foreground">
                      {t("dashboard:clis.metricSources.interval", {
                        seconds: source.intervalSecs,
                      })}
                    </span>
                  ) : null}
                </p>
                {source.state === "pending_approval" ? (
                  <p className="mt-1 text-muted-foreground">
                    {t("dashboard:clis.metricSources.pendingHint", { name: source.name })}
                  </p>
                ) : null}
                {source.state === "refused" ? (
                  <p className="mt-1 text-muted-foreground">
                    {t("dashboard:clis.metricSources.refusedHint")}
                  </p>
                ) : null}
              </li>
            ))}
            {unreported.map((source) => (
              <li key={`server:${source.name}`} className="min-w-0 border p-2 text-xs">
                <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <code className="break-all font-mono">{source.name}</code>
                  <span className="text-muted-foreground">
                    {t("dashboard:clis.metricSources.origins.remote")}
                  </span>
                </p>
                <p className="mt-1 text-muted-foreground">
                  {metrics.data?.remoteMetricSourcesAllowed
                    ? t("dashboard:clis.metricSources.notReported")
                    : t("dashboard:clis.metricSources.remoteNotAllowed")}
                </p>
              </li>
            ))}
          </ul>
        )}
        {open && customSeries.length > 0 ? (
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("dashboard:clis.metricSources.valuesTitle")}</p>
            <ul className="space-y-1">
              {customSeries.map((series) => (
                <li
                  key={seriesKey(series)}
                  className="flex min-w-0 flex-wrap items-baseline justify-between gap-2 text-xs"
                >
                  <code className="min-w-0 break-all font-mono">{seriesKey(series)}</code>
                  <span
                    className={
                      series.stale
                        ? "tabular-nums text-amber-700 dark:text-amber-300"
                        : "tabular-nums"
                    }
                  >
                    {series.value.toLocaleString()}
                    {series.stale ? ` · ${t("dashboard:clis.metricSources.stale")}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </details>
  );
}
