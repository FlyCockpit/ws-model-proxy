import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { useTranslation } from "react-i18next";

import { FillMeter } from "@/components/fill-meter";
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
      {live.kvUsage !== null ? (
        <FillMeter
          fraction={live.kvUsage}
          label={t("dashboard:runtime.kvUsage", { percent: Math.round(live.kvUsage * 100) })}
        />
      ) : null}
    </div>
  );
}
