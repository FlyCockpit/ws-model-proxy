import { cn } from "@ws-model-proxy/ui/lib/utils";

/**
 * The nav's Needs-you count (spec §7.1, §7.4). Decorative: the link or button that holds it
 * carries the count in its accessible name (`nav:needsYou.badge`).
 */
export function NeedsYouBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      aria-hidden="true"
      data-needs-you-badge=""
      className={cn(
        "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold leading-none text-amber-950 tabular-nums",
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
