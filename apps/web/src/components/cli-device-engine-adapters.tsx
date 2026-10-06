import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { orpc } from "@/utils/orpc";

type AdapterStatus = {
  endpointSlug: string;
  input: "route" | "command";
  state: string;
  error?: string;
};

const STATES = new Set(["active", "failing", "disabled", "pending_approval", "refused"]);
const ERRORS = new Set([
  "spawn",
  "timeout",
  "exit_status",
  "output_too_large",
  "parse",
  "http",
  "out_of_range",
  "unmapped",
]);

function reportedAdapters(nodeMetrics: unknown): AdapterStatus[] {
  if (!nodeMetrics || typeof nodeMetrics !== "object") return [];
  const adapters = (nodeMetrics as { engineAdapters?: unknown }).engineAdapters;
  if (!Array.isArray(adapters)) return [];
  return adapters.flatMap((entry): AdapterStatus[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.endpointSlug !== "string") return [];
    if (record.input !== "route" && record.input !== "command") return [];
    if (typeof record.state !== "string") return [];
    return [
      {
        endpointSlug: record.endpointSlug,
        input: record.input,
        state: record.state,
        error: typeof record.error === "string" ? record.error : undefined,
      },
    ];
  });
}

/** Engine adapter statuses from live node.metrics. Loaded when opened. */
export function CliDeviceEngineAdapters({
  cliDeviceId,
  defaultOpen = false,
}: {
  cliDeviceId: string;
  /** Open when shown on its own (a device tab). */
  defaultOpen?: boolean;
}) {
  const { t } = useTranslation(["dashboard"]);
  const [open, setOpen] = useState(defaultOpen);
  const metrics = useQuery({
    ...orpc.forwarderManagement.getCliDeviceMetrics.queryOptions({ input: { cliDeviceId } }),
    enabled: open,
  });
  const adapters = reportedAdapters(metrics.data?.nodeMetrics);
  return (
    <details
      className="border-b"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 px-4 text-sm font-medium">
        <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
        {t("dashboard:clis.engineAdapters.title")}
      </summary>
      <div className="min-w-0 space-y-2 px-4 pb-4">
        {!open ? null : metrics.isPending ? (
          <div aria-busy="true" className="space-y-2" data-testid="engine-adapters-skeleton">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-2/3" />
          </div>
        ) : metrics.isError ? (
          <InlineRetry
            message={t("dashboard:clis.engineAdapters.loadFailed")}
            onRetry={metrics.refetch}
          />
        ) : adapters.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("dashboard:clis.engineAdapters.empty")}
          </p>
        ) : (
          <ul className="space-y-2">
            {adapters.map((adapter) => (
              <li
                key={`${adapter.endpointSlug}:${adapter.input}`}
                className="min-w-0 border p-2 text-xs"
                data-testid="engine-adapter-row"
              >
                <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <code className="break-all font-mono">{adapter.endpointSlug}</code>
                  <span className="text-muted-foreground">
                    {t(`dashboard:clis.engineAdapters.inputs.${adapter.input}`)}
                  </span>
                  <span>
                    {STATES.has(adapter.state)
                      ? t(`dashboard:clis.engineAdapters.states.${adapter.state}`)
                      : adapter.state}
                  </span>
                  {adapter.error && ERRORS.has(adapter.error) ? (
                    <span className="text-amber-700 dark:text-amber-300">
                      {t(`dashboard:clis.engineAdapters.errors.${adapter.error}`)}
                    </span>
                  ) : null}
                </p>
                {adapter.state === "pending_approval" ? (
                  <p className="mt-1 text-muted-foreground">
                    {t("dashboard:clis.engineAdapters.pendingHint", {
                      slug: adapter.endpointSlug,
                    })}
                  </p>
                ) : null}
                {adapter.state === "refused" ? (
                  <p className="mt-1 text-muted-foreground">
                    {t("dashboard:clis.engineAdapters.refusedHint")}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">{t("dashboard:clis.engineAdapters.hint")}</p>
      </div>
    </details>
  );
}
