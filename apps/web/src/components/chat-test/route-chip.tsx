import { cn } from "@ws-model-proxy/ui/lib/utils";
import { Cloud, CloudOff, HardDrive, KeyRound } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { ChatRouteInfo } from "./chat-test-types";

const KNOWN_REASONS = [
  "local_wait_expired",
  "local_saturated_protected",
  "no_local_member",
  "local_context_ceiling",
  "local_failure",
] as const;
type KnownReason = (typeof KNOWN_REASONS)[number];

function isKnownReason(reason: string): reason is KnownReason {
  return (KNOWN_REASONS as readonly string[]).includes(reason);
}

const chipClass =
  "inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";

/**
 * Which route served one assistant turn. The fallback reason is inline text
 * (not a `title` tooltip) so it is readable on touch devices.
 */
export function RouteChip({ route }: { route: ChatRouteInfo }) {
  const { t } = useTranslation(["dashboard"]);
  const reason = route.fallbackReason;
  const reasonText = reason
    ? isKnownReason(reason)
      ? t(`dashboard:chatTest.route.reasons.${reason}`)
      : t("dashboard:chatTest.route.reasons.other", { reason })
    : null;
  const label =
    route.route === "local"
      ? t("dashboard:chatTest.route.local")
      : route.route === "pool-fallback"
        ? t("dashboard:chatTest.route.poolFallback", {
            model: route.servedModel ?? t("dashboard:chatTest.route.unknownModel"),
          })
        : route.route === "own-key"
          ? t("dashboard:chatTest.route.ownKey", {
              model: route.servedModel ?? t("dashboard:chatTest.route.unknownModel"),
            })
          : null;
  const Icon = route.route === "local" ? HardDrive : route.route === "own-key" ? KeyRound : Cloud;
  return (
    <div
      data-testid="chat-route"
      data-route={route.route ?? "none"}
      className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
    >
      {label ? (
        <span
          className={cn(
            chipClass,
            route.route === "local"
              ? "border-border bg-muted text-muted-foreground"
              : "border-amber-500/40 bg-amber-500/10 text-amber-950 dark:text-amber-100",
          )}
        >
          <Icon className="size-3 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-all">{label}</span>
        </span>
      ) : null}
      {route.externalUnavailable ? (
        <span className={cn(chipClass, "border-border bg-muted text-muted-foreground")}>
          <CloudOff className="size-3 shrink-0" aria-hidden="true" />
          <span className="min-w-0">{t("dashboard:chatTest.route.externalUnavailable")}</span>
        </span>
      ) : null}
      {reasonText ? (
        <span className="min-w-0">
          {t("dashboard:chatTest.route.reasonLabel", { reason: reasonText })}
        </span>
      ) : null}
    </div>
  );
}
