// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  payloads: [] as unknown[],
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@ws-model-proxy/ui/components/sileo", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/utils/orpc", () => ({
  orpc: {
    forwarderManagement: {
      key: () => ["forwarderManagement"],
      setCliDeviceFeatureGrants: {
        mutationOptions: (options?: Record<string, unknown>) => ({
          mutationFn: async (input: unknown) => {
            state.payloads.push(input);
            return { id: "cli-1" };
          },
          ...options,
        }),
      },
    },
  },
}));

import { CliDeviceFeatureSwitches } from "./cli-device-feature-switches";

function device(features: object) {
  return { id: "cli-1", features };
}

function renderSwitches(features: object) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      <CliDeviceFeatureSwitches cliDeviceId="cli-1" device={device(features)} />
    </QueryClientProvider>,
  );
}

function isDisabled(element: HTMLElement): boolean {
  return element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";
}

afterEach(() => {
  cleanup();
  state.payloads = [];
});

describe("CLI feature switches", () => {
  it("disables the terminal switch on Windows and explains why", () => {
    renderSwitches({
      terminal: {
        granted: true,
        deviceAllows: true,
        supported: false,
        live: true,
        available: false,
      },
      commands: { granted: false, deviceAllows: true, live: true, available: false },
    });
    const terminal = screen.getByRole("switch", { name: "dashboard:clis.features.terminal" });
    const commands = screen.getByRole("switch", { name: "dashboard:clis.features.commands" });
    expect(isDisabled(terminal)).toBe(false);
    expect(terminal.getAttribute("aria-checked")).toBe("true");
    expect(isDisabled(commands)).toBe(false);
    expect(screen.getByText("dashboard:clis.features.windows")).toBeTruthy();
  });

  it("disables a grant that is off when the CLI config turns the feature off", () => {
    renderSwitches({
      terminal: {
        granted: false,
        deviceAllows: false,
        supported: true,
        live: false,
        available: false,
      },
      commands: { granted: false, deviceAllows: false, live: false, available: false },
    });
    expect(
      isDisabled(screen.getByRole("switch", { name: "dashboard:clis.features.terminal" })),
    ).toBe(true);
    expect(
      isDisabled(screen.getByRole("switch", { name: "dashboard:clis.features.commands" })),
    ).toBe(true);
    expect(screen.getAllByText("dashboard:clis.features.configDisabled").length).toBe(2);
  });

  it("keeps a granted switch enabled when the device flag is false", () => {
    renderSwitches({
      terminal: {
        granted: true,
        deviceAllows: false,
        supported: false,
        live: false,
        available: false,
      },
      commands: { granted: true, deviceAllows: null, live: false, available: false },
    });
    expect(
      isDisabled(screen.getByRole("switch", { name: "dashboard:clis.features.terminal" })),
    ).toBe(false);
    expect(
      isDisabled(screen.getByRole("switch", { name: "dashboard:clis.features.commands" })),
    ).toBe(false);
    expect(screen.getByText("dashboard:clis.features.windows")).toBeTruthy();
    expect(screen.getByText("dashboard:clis.features.updateWsmp")).toBeTruthy();
  });

  it("asks for a wsmp update when the device has not reported the flag", () => {
    renderSwitches({
      terminal: {
        granted: false,
        deviceAllows: null,
        supported: null,
        live: false,
        available: false,
      },
      commands: { granted: false, deviceAllows: null, live: false, available: false },
    });
    expect(screen.getAllByText("dashboard:clis.features.updateWsmp").length).toBe(2);
  });

  it("keeps an offline CLI's last grant instead of forcing the switch off", async () => {
    const user = userEvent.setup();
    renderSwitches({
      terminal: {
        granted: true,
        deviceAllows: true,
        supported: true,
        live: false,
        available: false,
      },
      commands: { granted: false, deviceAllows: true, live: false, available: false },
    });
    const terminal = screen.getByRole("switch", { name: "dashboard:clis.features.terminal" });
    expect(isDisabled(terminal)).toBe(false);
    expect(terminal.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText("dashboard:terminals.reasons.offline")).not.toBeTruthy();
    await user.click(terminal);
    expect(state.payloads).toEqual([{ cliDeviceId: "cli-1", humanTerminal: false }]);
  });
});
