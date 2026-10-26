import { Button } from "@ws-model-proxy/ui/components/button";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { NativeSelect } from "@/components/native-select";
import type { NodeSummary } from "@/components/nodes/node-types";

/** A shell id as the node names it (`pwsh`, `powershell`, `cmd`, `wsl:<distro>`), for people. */
function shellName(t: TFunction, id: string): string {
  if (id.startsWith("wsl:")) return t("terminals:shell.wsl", { distro: id.slice(4) });
  if (id === "pwsh" || id === "powershell" || id === "cmd") return t(`terminals:shell.${id}`);
  return id;
}

/**
 * One node of the Terminals list. A Windows node names its shells, its default first; the
 * picker starts on that default and only a different choice is sent.
 */
export function TerminalNodeRow({
  node,
  ready,
  busy,
  opening,
  onOpen,
}: {
  node: NodeSummary;
  ready: boolean;
  busy: boolean;
  opening: boolean;
  onOpen: (shell: string | undefined) => void;
}) {
  const { t } = useTranslation(["terminals"]);
  const [chosen, setChosen] = useState<string | null>(null);
  const full = node.trust.effective === "FULL" && !node.trust.lowerPending;
  const online = node.connection === "ONLINE";
  const shells = node.terminalShells;
  const fallback = shells[0];
  // A choice the node no longer offers falls back to its default.
  const shell = chosen !== null && shells.includes(chosen) ? chosen : fallback;
  const label = node.name ?? node.slug;
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-2 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="truncate font-mono text-sm">{label}</p>
        {!full || !online ? (
          <p className="text-xs text-muted-foreground">
            {!full ? t("terminals:relayOnly") : t("terminals:offline")}
          </p>
        ) : null}
      </div>
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
        {shells.length > 1 ? (
          <NativeSelect
            aria-label={t("terminals:shell.label", { node: label })}
            className="w-auto max-w-full"
            value={shell}
            disabled={!full || !online}
            onChange={(event) => setChosen(event.target.value)}
          >
            {shells.map((id) => (
              <option key={id} value={id}>
                {id === fallback
                  ? t("terminals:shell.default", { shell: shellName(t, id) })
                  : shellName(t, id)}
              </option>
            ))}
          </NativeSelect>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="touch"
          disabled={!ready || !full || !online || busy}
          onClick={() => onOpen(shell !== fallback ? shell : undefined)}
        >
          {opening ? t("terminals:opening") : t("terminals:open")}
        </Button>
      </div>
    </div>
  );
}
