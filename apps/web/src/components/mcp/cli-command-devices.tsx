import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { commandLimit, readCliDeviceFeatures } from "@/lib/cli-device-features";
import { orpc } from "@/utils/orpc";

/**
 * Shown under "Allow CLI commands" in the token form. A command needs three
 * switches: this token, the device's dashboard grant, and the CLI's own
 * config. Only the first is set here; this lists the other two as one
 * effective mode per device and links to each device's grant. It never
 * changes a grant: raising one stays a deliberate dashboard action.
 */
export function CliCommandDevices({ lang }: { lang: string }) {
  const { t } = useTranslation(["settings"]);
  const devices = useQuery(orpc.forwarderManagement.listCliDevices.queryOptions());

  if (devices.isPending) return <Skeleton className="h-16 w-full" />;
  if (devices.isError) {
    return (
      <InlineRetry
        message={t("settings:mcp.tokens.cliDevicesLoadFailed")}
        onRetry={() => void devices.refetch()}
      />
    );
  }

  const rows = devices.data.map((device) => {
    const commands = readCliDeviceFeatures(device).features.commands;
    return {
      id: device.id,
      name: device.displayName,
      effectiveMode: commands.effectiveMode,
      limit: commandLimit(commands),
    };
  });
  const noneAllow = rows.every((row) => row.effectiveMode === "off");

  return (
    <div className="min-w-0 space-y-2 rounded-md border p-3" data-testid="cli-command-devices">
      <p className="text-sm font-medium">{t("settings:mcp.tokens.cliDevicesTitle")}</p>
      <p className="text-sm text-muted-foreground">{t("settings:mcp.tokens.cliDevicesHelp")}</p>
      {rows.length === 0 ? (
        <p className="text-sm text-destructive" role="status">
          {t("settings:mcp.tokens.cliDevicesEmpty")}
        </p>
      ) : (
        <>
          {noneAllow ? (
            <p className="text-sm text-destructive" role="status">
              {t("settings:mcp.tokens.cliDevicesNoneAllow")}
            </p>
          ) : null}
          <ul className="space-y-2">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex min-w-0 flex-col gap-1 text-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <span className="min-w-0 break-words">
                  <span className="font-medium">{row.name}</span>
                  {": "}
                  {t(`settings:mcp.tokens.cliDeviceMode.${row.effectiveMode}`)}
                  {row.limit ? (
                    <span className="text-muted-foreground">
                      {" ("}
                      {t(`settings:mcp.tokens.cliDeviceLimit.${row.limit}`)}
                      {")"}
                    </span>
                  ) : null}
                </span>
                <Link
                  to="/$lang/dashboard/clis"
                  params={{ lang }}
                  hash={`cli-${row.id}`}
                  className="inline-flex min-h-[44px] shrink-0 items-center text-primary underline underline-offset-2"
                >
                  {t("settings:mcp.tokens.cliDeviceGrantLink", { name: row.name })}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
