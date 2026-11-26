import { cn } from "@ws-model-proxy/ui/lib/utils";
import type { ComponentProps } from "react";

/**
 * A styled native `<select>` for dynamic option lists (runtimes, pools, nodes): the platform
 * picker on phones, 44px tall, labels rendered as written.
 */
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        // 16px below md, so iOS Safari does not zoom the page when the picker gets focus.
        "h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 text-base md:text-sm",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
