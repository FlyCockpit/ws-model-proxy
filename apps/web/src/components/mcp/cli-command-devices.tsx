import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Skeleton } from "@ws-model-proxy/ui/components/skeleton";
import { useTranslation } from "react-i18next";
import { InlineRetry } from "@/components/inline-retry";
import { useAuthSession } from "@/hooks/use-auth-session";
import { COMMAND_KINDS, commandRefusals, readCliDeviceFeatures } from "@/lib/cli-device-features";
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
  // The router's query cache outlives a sign-out (five-minute staleTime), so the
  // key carries the signed-in user: another account never reads this list.
  const { state } = useAuthSession();
  const userId = state.session?.user.id ?? null;
  const options = orpc.forwarderManagement.listCliDevices.queryOptions();
  const devices = useQuery({
    ...options,
    queryKey: [...options.queryKey, { userId }],
    enabled: userId !== null,
  });

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
      refusals: commandRefusals(commands),
      available: commands.available,
    };
  });
  // Some command kind would be admitted (the relay's own refusals, not just the mode).
  const noneAllow = rows.every((row) => !row.available);

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
                  {row.refusals
                    ? COMMAND_KINDS.map((kind) => {
                        const refusal = row.refusals?.[kind] ?? null;
                        return (
                          <span key={kind} className="block text-muted-foreground">
                            {t(`settings:mcp.tokens.cliDeviceKind.${kind}`)}
                            {": "}
                            {refusal
                              ? t(`settings:mcp.tokens.cliDeviceRefusal.${refusal}`)
                              : t("settings:mcp.tokens.cliDeviceAllowed")}
                          </span>
                        );
                      })
                    : null}
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
