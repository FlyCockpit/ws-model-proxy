import { Popover, PopoverContent, PopoverTrigger } from "@ws-model-proxy/ui/components/popover";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { CircleHelp } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

/**
 * Explains remaining jargon on click (not hover, so it works on touch screens). The icon stays
 * small; a pseudo-element extends the hit area to 44px.
 */
export function Help({
  title,
  children,
  className,
}: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation(["dashboard"]);
  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "relative inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground after:absolute after:-inset-3.5 after:content-[''] hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
        aria-label={t("dashboard:help.ariaLabel")}
      >
        <CircleHelp aria-hidden="true" className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent className="w-72 max-w-[calc(100vw-2rem)] text-xs leading-relaxed">
        {title ? <p className="mb-1 font-semibold text-foreground">{title}</p> : null}
        <div className="space-y-1.5 text-muted-foreground">{children}</div>
      </PopoverContent>
    </Popover>
  );
}
