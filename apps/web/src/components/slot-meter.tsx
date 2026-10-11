import { cn } from "@ws-model-proxy/ui/lib/utils";
import { useTranslation } from "react-i18next";

/** Above this many slots a single bar replaces one segment per slot. */
const MAX_SEGMENTS = 16;

/**
 * Requests running on a runtime out of its slot limit, plus the queue waiting for one. `kept`
 * marks the slots a pool keeps for itself (drawn dashed at the end of the meter).
 */
export function SlotMeter({
  active,
  slots,
  waiting = 0,
  kept = 0,
  className,
}: {
  active: number;
  slots: number | null;
  waiting?: number;
  kept?: number;
  className?: string;
}) {
  const { t } = useTranslation(["dashboard"]);
  const keptShown = slots ? Math.min(kept, slots) : 0;
  const keptLabel = keptShown > 0 ? t("dashboard:slots.kept", { count: keptShown }) : null;
  const label = slots
    ? t("dashboard:slots.label", { active, slots })
    : t("dashboard:slots.unlimited", { active });
  return (
    // Labels wrap below the meter rather than squeeze its segments.
    <div className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1", className)}>
      {slots ? (
        <div
          role="meter"
          aria-label={keptLabel ? `${label}, ${keptLabel}` : label}
          aria-valuemin={0}
          aria-valuemax={slots}
          aria-valuenow={Math.min(active, slots)}
          className="flex min-w-fit flex-1 items-center gap-1"
        >
          {slots <= MAX_SEGMENTS ? (
            Array.from({ length: slots }, (_, index) => (
              <span
                key={index}
                className={cn(
                  "h-3 min-w-2.5 max-w-7 flex-1 rounded-[3px] border",
                  index < active ? "border-primary bg-primary" : "border-border bg-muted",
                  index >= slots - keptShown && "border-dashed border-primary",
                )}
              />
            ))
          ) : (
            <span className="relative h-3 min-w-16 flex-1 overflow-hidden rounded-[3px] border bg-muted">
              <span
                className="block h-full bg-primary"
                style={{ width: `${Math.min(100, (active / slots) * 100)}%` }}
              />
              {keptShown > 0 ? (
                <span
                  className="absolute inset-y-0 right-0 rounded-r-[3px] border-l border-dashed border-primary"
                  style={{ width: `${(keptShown / slots) * 100}%` }}
                />
              ) : null}
            </span>
          )}
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">{label}</span>
      )}
      {keptLabel ? (
        <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground">
          {keptLabel}
        </span>
      ) : null}
      {waiting > 0 ? (
        <span className="shrink-0 text-xs font-medium whitespace-nowrap text-state-warning-foreground dark:text-state-warning">
          {t("dashboard:slots.waiting", { count: waiting })}
        </span>
      ) : null}
    </div>
  );
}
