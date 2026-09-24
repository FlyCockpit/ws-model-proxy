import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useState } from "react";

import { type TerminalTab, useTerminalSessions } from "@/hooks/use-terminal-sessions";
import { orpc } from "@/utils/orpc";

type Sessions = ReturnType<typeof useTerminalSessions>;
type DevicesQuery = ReturnType<typeof useCliDevicesQuery>;

export type TerminalWorkspace = Sessions & {
  devicesQuery: DevicesQuery;
  /** A CLI's display name (server-computed), then its listed slug, then its id. */
  labelFor: (cliDeviceId: string) => string;
  /**
   * A tab's CLI display name. The slug is appended when another open CLI shows
   * the same name, and tabs on one CLI are numbered.
   */
  tabLabel: (tab: TerminalTab) => string;
};

const TerminalWorkspaceContext = createContext<TerminalWorkspace | null>(null);

function useCliDevicesQuery(enabled: boolean) {
  return useQuery({ ...orpc.forwarderManagement.listCliDevices.queryOptions(), enabled });
}

export function deviceId(device: object): string | null {
  const value = Object.getOwnPropertyDescriptor(device, "id")?.value;
  return typeof value === "string" ? value : null;
}

export function deviceText(
  device: object,
  key: "displayName" | "slug" | "reportedHostname",
): string | null {
  const value = Object.getOwnPropertyDescriptor(device, key)?.value;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A terminal tab's label. `name` and `slug` resolve a CLI's display name and
 * slug. Two CLIs with the same display name are told apart by slug; several
 * tabs on one CLI are numbered.
 */
export function terminalTabLabel(
  tab: TerminalTab,
  tabs: readonly TerminalTab[],
  name: (cliDeviceId: string) => string,
  slug: (cliDeviceId: string) => string | null,
): string {
  const shown = name(tab.cliDeviceId);
  const clash = tabs.some(
    (other) => other.cliDeviceId !== tab.cliDeviceId && name(other.cliDeviceId) === shown,
  );
  const cliSlug = slug(tab.cliDeviceId);
  const base = clash && cliSlug && cliSlug !== shown ? `${shown} · ${cliSlug}` : shown;
  const sameCli = tabs.filter((entry) => entry.cliDeviceId === tab.cliDeviceId);
  if (sameCli.length < 2) return base;
  return `${base} (${sameCli.indexOf(tab) + 1})`;
}

/**
 * One terminal connection for the whole dashboard, so open terminals stay
 * attached (and listed in the sidebar) while other dashboard pages are shown.
 *
 * It connects the first time `active` is true (the Terminals page is shown)
 * and stays connected after that. Connecting attaches every open terminal and
 * takes one of its viewer slots, so a tab that never opens Terminals must not.
 */
export function TerminalWorkspaceProvider({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const [activated, setActivated] = useState(active);
  if (active && !activated) setActivated(true);
  const sessions = useTerminalSessions({ enabled: activated });
  const devicesQuery = useCliDevicesQuery(activated);
  const devices = devicesQuery.data ?? [];

  const deviceFor = (cliDeviceId: string) =>
    devices.find((entry) => deviceId(entry) === cliDeviceId);
  const listedFor = (cliDeviceId: string) =>
    sessions.clis.find((cli) => cli.cliDeviceId === cliDeviceId);

  const slugFor = (cliDeviceId: string) => {
    const device = deviceFor(cliDeviceId);
    return (device ? deviceText(device, "slug") : null) ?? listedFor(cliDeviceId)?.slug ?? null;
  };

  const labelFor = (cliDeviceId: string) => {
    const device = deviceFor(cliDeviceId);
    return (
      (device ? deviceText(device, "displayName") : null) ?? slugFor(cliDeviceId) ?? cliDeviceId
    );
  };

  const tabLabel = (tab: TerminalTab) => terminalTabLabel(tab, sessions.tabs, labelFor, slugFor);

  return (
    <TerminalWorkspaceContext.Provider value={{ ...sessions, devicesQuery, labelFor, tabLabel }}>
      {children}
    </TerminalWorkspaceContext.Provider>
  );
}

export function useTerminalWorkspace(): TerminalWorkspace {
  const workspace = useContext(TerminalWorkspaceContext);
  if (!workspace) throw new Error("useTerminalWorkspace needs a TerminalWorkspaceProvider");
  return workspace;
}
