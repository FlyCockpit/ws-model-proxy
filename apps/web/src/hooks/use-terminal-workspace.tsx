import { useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useState } from "react";

import { type TerminalTab, useTerminalSessions } from "@/hooks/use-terminal-sessions";
import { orpc } from "@/utils/orpc";

type Sessions = ReturnType<typeof useTerminalSessions>;
type DevicesQuery = ReturnType<typeof useCliDevicesQuery>;

export type TerminalWorkspace = Sessions & {
  devicesQuery: DevicesQuery;
  /** A CLI's label, then its slug, then its id. */
  labelFor: (cliDeviceId: string) => string;
  /** A tab's CLI label, numbered when several tabs share a CLI. */
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

export function deviceText(device: object, key: "label" | "slug"): string | null {
  const value = Object.getOwnPropertyDescriptor(device, key)?.value;
  return typeof value === "string" && value.length > 0 ? value : null;
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

  const labelFor = (cliDeviceId: string) => {
    const device = devices.find((entry) => deviceId(entry) === cliDeviceId);
    const listed = sessions.clis.find((cli) => cli.cliDeviceId === cliDeviceId);
    return (
      (device ? (deviceText(device, "label") ?? deviceText(device, "slug")) : null) ??
      listed?.slug ??
      cliDeviceId
    );
  };

  const tabLabel = (tab: TerminalTab) => {
    const label = labelFor(tab.cliDeviceId);
    const sameCli = sessions.tabs.filter((entry) => entry.cliDeviceId === tab.cliDeviceId);
    if (sameCli.length < 2) return label;
    return `${label} (${sameCli.indexOf(tab) + 1})`;
  };

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
