import { cn } from "@ws-model-proxy/ui/lib/utils";
import { Cloud } from "lucide-react";
import { useTranslation } from "react-i18next";

export function PoolPrivacyBadge({
  external,
  providers = [],
}: {
  external: boolean;
  providers?: readonly string[];
}) {
  const { t } = useTranslation("dashboard");
  return (
    <span
      data-privacy={external ? "external" : "private"}
      title={
        external
          ? t("dashboard:pools.privacyBadge.hint", {
              providers: providers.length
                ? providers.join(", ")
                : t("dashboard:pools.privacyBadge.ownerProviders"),
            })
          : undefined
      }
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium",
        external
          ? "border-amber-500/40 bg-amber-500/10 text-amber-950 dark:text-amber-100"
          : "border-border bg-muted text-muted-foreground",
      )}
    >
      {external ? <Cloud className="size-3" aria-hidden="true" /> : null}
      {external
        ? t("dashboard:pools.privacyBadge.external")
        : t("dashboard:pools.privacyBadge.private")}
    </span>
  );
}
