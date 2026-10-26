// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${Object.values(options).map(String).join(",")}` : key,
    i18n: { language: "en-US" },
  }),
}));

import type { NodeSummary } from "./nodes/node-types";
import { TerminalNodeRow } from "./terminal-node-row";

afterEach(cleanup);

function node(overrides: Partial<NodeSummary> = {}): NodeSummary {
  return {
    id: "node-1",
    slug: "box",
    name: null,
    connection: "ONLINE",
    lastHeartbeatAt: null,
    version: "0.4.0",
    rejectedProtocolVersion: null,
    trust: {
      reported: "FULL",
      effective: "FULL",
      lowerPending: false,
      frozen: false,
      changedAt: null,
      changedBy: null,
    },
    labels: [],
    hardwareKind: "discrete",
    liveFreeMemoryGb: null,
    runningInstances: 0,
    alwaysOnRuntimes: 0,
    needsYou: 0,
    hold: null,
    removeAfterOfflineMs: null,
    hostname: null,
    fabrics: [],
    gpus: [],
    secretNames: [],
    terminalShells: [],
    ...overrides,
  };
}

function row(summary: NodeSummary) {
  const onOpen = vi.fn();
  render(<TerminalNodeRow node={summary} ready busy={false} opening={false} onOpen={onOpen} />);
  return onOpen;
}

describe("TerminalNodeRow", () => {
  it("offers no picker on a node that names no shells and opens its default", () => {
    const onOpen = row(node());
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "terminals:open" }));
    expect(onOpen).toHaveBeenCalledWith(undefined);
  });

  it("starts on the node's default shell and sends only a different choice", () => {
    const onOpen = row(node({ terminalShells: ["pwsh", "cmd", "wsl:Ubuntu"] }));
    const picker = screen.getByRole("combobox", { name: "terminals:shell.label:box" });
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "terminals:shell.default:terminals:shell.pwsh",
      "terminals:shell.cmd",
      "terminals:shell.wsl:Ubuntu",
    ]);
    const open = screen.getByRole("button", { name: "terminals:open" });
    fireEvent.click(open);
    expect(onOpen).toHaveBeenLastCalledWith(undefined);
    fireEvent.change(picker, { target: { value: "wsl:Ubuntu" } });
    fireEvent.click(open);
    expect(onOpen).toHaveBeenLastCalledWith("wsl:Ubuntu");
    fireEvent.change(picker, { target: { value: "pwsh" } });
    fireEvent.click(open);
    expect(onOpen).toHaveBeenLastCalledWith(undefined);
  });

  it("disables the picker and the button on a Relay-only node", () => {
    row(
      node({
        terminalShells: ["pwsh", "cmd"],
        trust: {
          reported: "RELAY",
          effective: "RELAY",
          lowerPending: false,
          frozen: true,
          changedAt: null,
          changedBy: null,
        },
      }),
    );
    expect(screen.getByRole("combobox")).toHaveProperty("disabled", true);
    expect(screen.getByRole("button")).toHaveProperty("disabled", true);
    expect(screen.getByText("terminals:relayOnly")).toBeTruthy();
  });
});
