import { cn } from "@ws-model-proxy/ui/lib/utils";

/**
 * A thin bar filled to a fraction (0..1) with its label beside it: KV cache usage, a member's
 * traffic share. `label` is shown as written and names the meter unless `ariaLabel` does.
 */
export function FillMeter({
  fraction,
  label,
  ariaLabel,
  className,
}: {
  fraction: number;
  label: string;
  ariaLabel?: string;
  className?: string;
}) {
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <div
        role="meter"
        aria-label={ariaLabel ?? label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-2 min-w-0 flex-1 overflow-hidden rounded-[3px] border bg-muted"
      >
        <span className="block h-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums whitespace-nowrap">
        {label}
      </span>
    </div>
  );
}
