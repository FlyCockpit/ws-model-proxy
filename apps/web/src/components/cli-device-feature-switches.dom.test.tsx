// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  payloads: [] as unknown[],
  grantsShouldFail: false,
}));

vi.mock("react-i18next", () => ({
  // Surface the interpolated device name so the confirm dialog can be
  // checked for naming the device.
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) =>
      options?.name ? `${key} [${options.name}]` : key,
  }),
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
            if (state.grantsShouldFail) throw new Error("grants failed");
            return { id: "cli-1" };
          },
          ...options,
        }),
      },
    },
  },
}));

import { toast } from "@ws-model-proxy/ui/components/sileo";
import { createAppMutationCache } from "@/utils/mutation-error-toast";

import { CliDeviceFeatureSwitches } from "./cli-device-feature-switches";

function device(features: object) {
  return { id: "cli-1", features };
}

function renderSwitches(features: object, { appToasts = false }: { appToasts?: boolean } = {}) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { mutations: { retry: false } },
          ...(appToasts ? { mutationCache: createAppMutationCache((key) => key) } : {}),
        })
      }
    >
      <CliDeviceFeatureSwitches
        cliDeviceId="cli-1"
        deviceName="build-box"
        device={device(features)}
      />
    </QueryClientProvider>,
  );
}

function isDisabled(element: HTMLElement): boolean {
  return element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";
}

afterEach(() => {
  cleanup();
  state.payloads = [];
  state.grantsShouldFail = false;
  vi.mocked(toast.error).mockClear();
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

function modeRadio(mode: string, { hidden = false }: { hidden?: boolean } = {}) {
  // Supervised's name also carries its "Recommended" tag.
  const label = `dashboard:clis.features.commandModes.${mode}`;
  return screen.getByRole("radio", {
    hidden,
    name: (name) => name.startsWith(label),
  });
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

  it("shows one error toast and rolls back optimistic mode when grants fail", async () => {
    const user = userEvent.setup();
    state.grantsShouldFail = true;
    renderSwitches(
      {
        terminal: {
          granted: false,
          deviceAllows: true,
          supported: true,
          live: true,
          available: false,
          approvalRequired: false,
        },
        commands: commands(),
      },
      { appToasts: true },
    );
    await user.click(modeRadio("supervised"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    expect(toast.error).toHaveBeenCalledWith("dashboard:clis.features.saveFailed");
    expect((modeRadio("off") as HTMLInputElement).checked).toBe(true);
    expect((modeRadio("supervised") as HTMLInputElement).checked).toBe(false);
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

  describe("switching to Unsupervised", () => {
    const allowsAll = {
      terminal: {
        granted: false,
        deviceAllows: true,
        supported: true,
        live: true,
        available: false,
        approvalRequired: true,
      },
      commands: commands(),
    };

    it("marks Unsupervised as dangerous and Supervised as recommended", () => {
      renderSwitches(allowsAll);
      const unsupervised = modeRadio("unsupervised").closest("label");
      expect(unsupervised?.className).toContain("text-destructive");
      expect(unsupervised?.querySelector("svg")).toBeTruthy();
      const supervised = modeRadio("supervised").closest("label");
      expect(supervised?.textContent).toContain("dashboard:clis.features.commandModeRecommended");
    });

    it("grants Unsupervised only after the confirm dialog naming the device", async () => {
      const user = userEvent.setup();
      renderSwitches(allowsAll);
      await user.click(modeRadio("unsupervised"));
      const dialog = await screen.findByRole("alertdialog");
      expect(dialog.textContent).toContain(
        "dashboard:clis.features.unsupervisedConfirm.title [build-box]",
      );
      expect(dialog.textContent).toContain(
        "dashboard:clis.features.unsupervisedConfirm.description [build-box]",
      );
      expect(state.payloads).toEqual([]);
      // The modal hides the page from the accessibility tree while open.
      expect((modeRadio("off", { hidden: true }) as HTMLInputElement).checked).toBe(true);
      await user.click(
        screen.getByRole("button", { name: "dashboard:clis.features.unsupervisedConfirm.confirm" }),
      );
      expect(state.payloads).toEqual([{ cliDeviceId: "cli-1", mcpCommandMode: "unsupervised" }]);
    });

    it("leaves the mode unchanged when the confirm is cancelled", async () => {
      const user = userEvent.setup();
      renderSwitches(allowsAll);
      await user.click(modeRadio("unsupervised"));
      await screen.findByRole("alertdialog");
      await user.click(
        screen.getByRole("button", { name: "dashboard:clis.features.unsupervisedConfirm.cancel" }),
      );
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(state.payloads).toEqual([]);
      expect((modeRadio("off") as HTMLInputElement).checked).toBe(true);
      expect((modeRadio("unsupervised") as HTMLInputElement).checked).toBe(false);
    });

    it("needs no confirm for Off or Supervised", async () => {
      const user = userEvent.setup();
      renderSwitches(allowsAll);
      await user.click(modeRadio("supervised"));
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(state.payloads).toEqual([{ cliDeviceId: "cli-1", mcpCommandMode: "supervised" }]);
    });

    it("needs no confirm to lower Unsupervised to Off", async () => {
      const user = userEvent.setup();
      renderSwitches({
        ...allowsAll,
        commands: commands({ mode: "unsupervised", effectiveMode: "unsupervised" }),
      });
      await user.click(modeRadio("off"));
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(state.payloads).toEqual([{ cliDeviceId: "cli-1", mcpCommandMode: "off" }]);
    });
  });
});
