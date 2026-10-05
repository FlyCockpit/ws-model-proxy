import { useTranslation } from "react-i18next";

import { Help } from "@/components/help";
import { type McpCommandMode, readCliDeviceFeatures } from "@/lib/cli-device-features";

type Row = { feature: string; you: string; machine: string; result: string; allowed: boolean };

/**
 * What agents and browsers may do on this machine: the dashboard grant, the CLI's own config,
 * and the stricter result that actually applies.
 */
export function CliAccessSummary({
  device,
}: {
  device: Parameters<typeof readCliDeviceFeatures>[0];
}) {
  const { t } = useTranslation(["dashboard"]);
  const features = readCliDeviceFeatures(device);
  const { terminal, commands } = features.features;
  const onOff = (value: boolean) =>
    value ? t("dashboard:clis.access.on") : t("dashboard:clis.access.off");
  const reported = (value: boolean | null) =>
    value === null
      ? t("dashboard:clis.access.notReported")
      : value
        ? t("dashboard:clis.access.allows")
        : t("dashboard:clis.access.blocks");
  const mode = (value: McpCommandMode | null) =>
    value === null
      ? t("dashboard:clis.access.notReported")
      : t(`dashboard:clis.features.commandModes.${value}`);
  const fileRead = features.fileTools?.read ?? "off";
  const rows: Row[] = [
    {
      feature: t("dashboard:clis.access.terminal"),
      you: onOff(terminal.granted),
      machine: reported(terminal.deviceAllows),
      result: terminal.available
        ? t("dashboard:clis.access.available")
        : t("dashboard:clis.access.unavailable"),
      allowed: terminal.available,
    },
    {
      feature: t("dashboard:clis.access.commands"),
      you: mode(commands.mode),
      machine: mode(commands.deviceMode),
      result: mode(commands.effectiveMode),
      allowed: commands.effectiveMode !== "off",
    },
    {
      feature: t("dashboard:clis.access.fileRead"),
      you: onOff(features.mcpFileRead),
      machine: reported(features.reportedMcpFileRead),
      result:
        fileRead === "off"
          ? t("dashboard:clis.access.off")
          : t(`dashboard:clis.access.fileRead_${fileRead}`),
      allowed: fileRead !== "off",
    },
  ];
  return (
    <section className="mb-4 min-w-0 space-y-2">
      <h4 className="flex items-center gap-1 text-sm font-medium">
        {t("dashboard:clis.access.title")}
        <Help>{t("dashboard:clis.access.help")}</Help>
      </h4>
      <div className="min-w-0 overflow-x-auto overscroll-x-contain rounded-md border">
        <table className="w-full min-w-[480px] text-left text-xs">
          <thead className="border-b text-muted-foreground">
            <tr>
              <th className="p-2 font-medium">{t("dashboard:clis.access.feature")}</th>
              <th className="p-2 font-medium">{t("dashboard:clis.access.you")}</th>
              <th className="p-2 font-medium">{t("dashboard:clis.access.machine")}</th>
              <th className="p-2 font-medium">{t("dashboard:clis.access.result")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => (
              <tr key={row.feature}>
                <th scope="row" className="p-2 font-medium">
                  {row.feature}
                </th>
                <td className="p-2">{row.you}</td>
                <td className="p-2">{row.machine}</td>
                <td className="p-2">
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    <span
                      aria-hidden="true"
                      className={
                        row.allowed
                          ? "size-1.5 rounded-full bg-state-success"
                          : "size-1.5 rounded-full bg-muted-foreground"
                      }
                    />
                    {row.result}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
