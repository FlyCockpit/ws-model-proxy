import { cn } from "@ws-model-proxy/ui/lib/utils";
import { useTranslation } from "react-i18next";

export function PoolPrivacyBadge({ external }: { external: boolean }) {
  const { t } = useTranslation("dashboard");
  return (
    <span
      data-privacy={external ? "external" : "private"}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
        external
          ? "border-amber-500/40 bg-amber-500/10 text-amber-950 dark:text-amber-100"
          : "border-border bg-muted text-muted-foreground",
      )}
    >
      {external
        ? t("dashboard:pools.privacyBadge.external")
        : t("dashboard:pools.privacyBadge.private")}
    </span>
  );
}
