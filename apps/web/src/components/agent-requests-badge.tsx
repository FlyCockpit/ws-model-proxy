import { cn } from "@ws-model-proxy/ui/lib/utils";
import { useTranslation } from "react-i18next";

/** A count of agent command requests waiting on the user. Renders nothing at zero. */
export function AgentRequestsBadge({ count, className }: { count: number; className?: string }) {
  const { t } = useTranslation("dashboard");
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold leading-none text-white",
        className,
      )}
    >
      <span aria-hidden="true">{count > 9 ? "9+" : count}</span>
      <span className="sr-only">{t("dashboard:agentRequests.badge", { count })}</span>
    </span>
  );
}
