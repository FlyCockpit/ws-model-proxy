import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { useTranslation } from "react-i18next";

export type CliDevice = Awaited<
  ReturnType<AppRouterClient["forwarderManagement"]["listCliDevices"]>
>[number];
export type CliDeviceFilter = "all" | "online" | "attention" | "offline";

export function cliDeviceOnline(device: Pick<CliDevice, "status" | "isStale">) {
  return device.status === "CONNECTED" && !device.isStale;
}

/**
 * Something on this machine needs the owner: an upgrade, a refused identity, a
 * stale link, or a failing server.
 */
export function cliDeviceNeedsAttention(device: CliDevice) {
  return (
    Boolean(device.upgradeRequired) ||
    Boolean(device.identityRefusedAt) ||
    device.isStale ||
    (device.status === "CONNECTED" &&
      device.endpoints.some(
        (endpoint) => endpoint.status !== "ONLINE" || Boolean(endpoint.failureReasonCode),
      ))
  );
}

export function cliDeviceMatchesFilter(device: CliDevice, filter: CliDeviceFilter) {
  if (filter === "online") return cliDeviceOnline(device);
  if (filter === "offline") return !cliDeviceOnline(device);
  if (filter === "attention") return cliDeviceNeedsAttention(device);
  return true;
}

/** Status in words with a dot; never colour alone. */
export function CliStatusBadge({
  tone,
  children,
}: {
  tone: "success" | "warning" | "danger" | "muted";
  children: string;
}) {
  return (
    <span className="inline-flex min-h-6 items-center gap-1.5 rounded-full border px-2 text-xs font-medium">
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          tone === "success" && "bg-state-success",
          tone === "warning" && "bg-state-warning",
          tone === "danger" && "bg-destructive",
          tone === "muted" && "bg-muted-foreground",
        )}
      />
      {children}
    </span>
  );
}

export function CliDeviceStatusBadge({ device }: { device: CliDevice }) {
  const { t } = useTranslation(["dashboard"]);
  if (device.isStale)
    return <CliStatusBadge tone="warning">{t("dashboard:clis.status.stale")}</CliStatusBadge>;
  if (device.status === "CONNECTED")
    return <CliStatusBadge tone="success">{t("dashboard:clis.status.online")}</CliStatusBadge>;
  if (device.status === "REVOKED")
    return <CliStatusBadge tone="danger">{t("dashboard:clis.status.revoked")}</CliStatusBadge>;
  return <CliStatusBadge tone="muted">{t("dashboard:clis.status.offline")}</CliStatusBadge>;
}

export function EndpointStatusBadge({
  status,
}: {
  status: CliDevice["endpoints"][number]["status"];
}) {
  const { t } = useTranslation(["dashboard"]);
  const tone =
    status === "ONLINE"
      ? "success"
      : status === "DEGRADED"
        ? "warning"
        : status === "OFFLINE"
          ? "danger"
          : "muted";
  return <CliStatusBadge tone={tone}>{t(`dashboard:endpoints.status.${status}`)}</CliStatusBadge>;
}
