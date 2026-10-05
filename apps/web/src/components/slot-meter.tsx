import { cn } from "@ws-model-proxy/ui/lib/utils";
import { useTranslation } from "react-i18next";

/** Above this many slots a single bar replaces one segment per slot. */
const MAX_SEGMENTS = 16;

/** Requests running on a runtime out of its slot limit, plus the queue waiting for one. */
export function SlotMeter({
  active,
  slots,
  waiting = 0,
  className,
}: {
  active: number;
  slots: number | null;
  waiting?: number;
  className?: string;
}) {
  const { t } = useTranslation(["dashboard"]);
  const label = slots
    ? t("dashboard:slots.label", { active, slots })
    : t("dashboard:slots.unlimited", { active });
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      {slots ? (
        <div
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={slots}
          aria-valuenow={Math.min(active, slots)}
          className="flex min-w-0 flex-1 items-center gap-1"
        >
          {slots <= MAX_SEGMENTS ? (
            Array.from({ length: slots }, (_, index) => (
              <span
                key={index}
                className={cn(
                  "h-3 min-w-2.5 max-w-7 flex-1 rounded-[3px] border",
                  index < active ? "border-primary bg-primary" : "border-border bg-muted",
                )}
              />
            ))
          ) : (
            <span className="h-3 flex-1 overflow-hidden rounded-[3px] border bg-muted">
              <span
                className="block h-full bg-primary"
                style={{ width: `${Math.min(100, (active / slots) * 100)}%` }}
              />
            </span>
          )}
        </div>
      ) : (
        <span className="text-xs text-muted-foreground">{label}</span>
      )}
      {waiting > 0 ? (
        <span className="shrink-0 text-xs font-medium whitespace-nowrap text-state-warning-foreground dark:text-state-warning">
          {t("dashboard:slots.waiting", { count: waiting })}
        </span>
      ) : null}
    </div>
  );
}
