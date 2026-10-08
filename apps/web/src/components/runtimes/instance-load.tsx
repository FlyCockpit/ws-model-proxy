import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { useTranslation } from "react-i18next";

import { SlotMeter } from "@/components/slot-meter";

type InstanceLive = Awaited<
  ReturnType<AppRouterClient["runtimes"]["get"]>
>["instanceList"][number]["live"];

/**
 * An instance's live engine load: slots in use with the waiting queue, and KV cache usage.
 * Nothing is drawn for what the server does not know (no reading in the serving process).
 */
export function InstanceLoad({ live }: { live: InstanceLive }) {
  const { t } = useTranslation(["dashboard"]);
  if (live.running === null && live.kvUsage === null) return null;
  const kvPercent = live.kvUsage === null ? null : Math.round(live.kvUsage * 100);
  return (
    <div className="flex min-w-0 flex-col gap-1 pt-1">
      {live.running !== null ? (
        <SlotMeter
          active={live.running}
          slots={live.slots}
          waiting={live.waiting ?? 0}
          className="max-w-full"
        />
      ) : null}
      {kvPercent !== null ? (
        <div className="flex min-w-0 items-center gap-2">
          <div
            role="meter"
            aria-label={t("dashboard:runtime.kvUsage", { percent: kvPercent })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(100, kvPercent)}
            className="h-2 min-w-0 flex-1 overflow-hidden rounded-[3px] border bg-muted"
          >
            <span
              className="block h-full bg-primary"
              style={{ width: `${Math.min(100, kvPercent)}%` }}
            />
          </div>
          <span className="shrink-0 text-xs text-muted-foreground whitespace-nowrap">
            {t("dashboard:runtime.kvUsage", { percent: kvPercent })}
          </span>
        </div>
      ) : null}
    </div>
  );
}
