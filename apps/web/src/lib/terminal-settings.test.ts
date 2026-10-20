import { describe, expect, it } from "vitest";

import { DEFAULT_TERMINAL_SETTINGS, parseTerminalSettings } from "./terminal-settings";

describe("parseTerminalSettings", () => {
  it("keeps valid stored values", () => {
    expect(
      parseTerminalSettings({
        terminalCopy: "auto",
        terminalShiftEnter: "esc-cr",
        terminalMaximized: true,
      }),
    ).toEqual({ terminalCopy: "auto", terminalShiftEnter: "esc-cr", terminalMaximized: true });
  });

  it("falls back per value when missing or unknown", () => {
    expect(parseTerminalSettings(undefined)).toEqual(DEFAULT_TERMINAL_SETTINGS);
    expect(parseTerminalSettings({ sidebarCollapsed: true })).toEqual(DEFAULT_TERMINAL_SETTINGS);
    expect(
      parseTerminalSettings({
        terminalCopy: "always",
        terminalShiftEnter: "lf",
        terminalMaximized: 1,
      }),
    ).toEqual({ ...DEFAULT_TERMINAL_SETTINGS, terminalShiftEnter: "lf" });
  });
});
