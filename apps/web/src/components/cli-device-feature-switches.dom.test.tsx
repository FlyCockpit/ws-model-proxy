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

function commands(overrides: object = {}) {
  return {
    mode: "off",
    deviceMode: "unsupervised",
    supported: true,
    live: true,
    effectiveMode: "off",
    available: false,
    ...overrides,
  };
}

function modeRadio(mode: string) {
  return screen.getByRole("radio", { name: `dashboard:clis.features.commandModes.${mode}` });
}

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
      commands: commands({ supported: false }),
    });
    const terminal = screen.getByRole("switch", { name: "dashboard:clis.features.terminal" });
    expect(isDisabled(terminal)).toBe(false);
    expect(terminal.getAttribute("aria-checked")).toBe("true");
    // Supervised commands need a PTY; headless ones do not.
    expect(isDisabled(modeRadio("supervised"))).toBe(true);
    expect(isDisabled(modeRadio("unsupervised"))).toBe(false);
    expect(screen.getAllByText("dashboard:clis.features.windows").length).toBeGreaterThan(0);
  });

  it("disables modes above what the CLI config allows", () => {
    renderSwitches({
      terminal: {
        granted: false,
        deviceAllows: false,
        supported: true,
        live: false,
        available: false,
      },
      commands: commands({ deviceMode: "supervised" }),
    });
    expect(
      isDisabled(screen.getByRole("switch", { name: "dashboard:clis.features.terminal" })),
    ).toBe(true);
    expect(isDisabled(modeRadio("off"))).toBe(false);
    expect(isDisabled(modeRadio("supervised"))).toBe(false);
    expect(isDisabled(modeRadio("unsupervised"))).toBe(true);
    expect(screen.getAllByText("dashboard:clis.features.configDisabled").length).toBe(2);
  });

  it("keeps the current grant selectable so it can be lowered", async () => {
    const user = userEvent.setup();
    renderSwitches({
      terminal: {
        granted: true,
        deviceAllows: false,
        supported: false,
        live: false,
        available: false,
      },
      commands: commands({ mode: "unsupervised", deviceMode: null }),
    });
    expect(
      isDisabled(screen.getByRole("switch", { name: "dashboard:clis.features.terminal" })),
    ).toBe(false);
    expect((modeRadio("unsupervised") as HTMLInputElement).checked).toBe(true);
    expect(isDisabled(modeRadio("unsupervised"))).toBe(false);
    await user.click(modeRadio("off"));
    expect(state.payloads).toEqual([{ cliDeviceId: "cli-1", mcpCommandMode: "off" }]);
  });

  it("asks for a wsmp update when the device has not reported a mode", () => {
    renderSwitches({
      terminal: {
        granted: false,
        deviceAllows: null,
        supported: null,
        live: false,
        available: false,
      },
      commands: commands({ deviceMode: null, supported: null }),
    });
    expect(isDisabled(modeRadio("supervised"))).toBe(true);
    expect(screen.getAllByText("dashboard:clis.features.updateWsmp").length).toBe(2);
  });

  it("grants supervised mode and recommends browser approval", async () => {
    const user = userEvent.setup();
    renderSwitches({
      terminal: {
        granted: false,
        deviceAllows: true,
        supported: true,
        live: true,
        available: false,
        approvalRequired: false,
      },
      commands: commands(),
    });
    expect(screen.queryByText("dashboard:clis.features.approvalRecommended")).toBeNull();
    await user.click(modeRadio("supervised"));
    expect(state.payloads).toEqual([{ cliDeviceId: "cli-1", mcpCommandMode: "supervised" }]);
  });

  it("recommends browser approval while agents can request commands", () => {
    renderSwitches({
      terminal: {
        granted: false,
        deviceAllows: true,
        supported: true,
        live: true,
        available: false,
        approvalRequired: false,
      },
      commands: commands({ mode: "supervised", effectiveMode: "supervised", available: true }),
    });
    expect(screen.getByText("dashboard:clis.features.approvalRecommended")).toBeTruthy();
    expect(screen.getByText("wsmp config set-terminal-approval on")).toBeTruthy();
  });

  it("does not recommend approval when the CLI already requires it", () => {
    renderSwitches({
      terminal: {
        granted: false,
        deviceAllows: true,
        supported: true,
        live: true,
        available: false,
        approvalRequired: true,
      },
      commands: commands({ mode: "supervised", effectiveMode: "supervised", available: true }),
    });
    expect(screen.queryByText("dashboard:clis.features.approvalRecommended")).toBeNull();
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
      commands: commands({ live: false }),
    });
    const terminal = screen.getByRole("switch", { name: "dashboard:clis.features.terminal" });
    expect(isDisabled(terminal)).toBe(false);
    expect(terminal.getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText("dashboard:terminals.reasons.offline")).not.toBeTruthy();
    await user.click(terminal);
    expect(state.payloads).toEqual([{ cliDeviceId: "cli-1", humanTerminal: false }]);
  });
});
