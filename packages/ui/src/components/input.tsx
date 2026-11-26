import { Input as InputPrimitive } from "@base-ui/react/input";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import * as React from "react";

/**
 * 16px below `md`: under 16px, iOS Safari zooms the page when the field gets focus. From `md` up
 * the compact 12px desktop size (docs/ui.md § Viewport scale).
 */
function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-none border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-xs file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/20 md:text-xs dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:ring-destructive/40 aria-invalid:focus-visible:ring-2 aria-invalid:focus-visible:ring-destructive dark:aria-invalid:focus-visible:ring-destructive",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
