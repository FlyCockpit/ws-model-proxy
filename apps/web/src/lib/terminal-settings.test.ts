import { describe, expect, it } from "vitest";

import { DEFAULT_TERMINAL_SETTINGS, parseTerminalSettings } from "./terminal-settings";

describe("parseTerminalSettings", () => {
  it("keeps valid stored values", () => {
    expect(
      parseTerminalSettings({
        terminalCopy: "auto",
        terminalShiftEnter: "esc-cr",
        terminalMaximized: true,
        terminalKeysShown: true,
        terminalFontSize: 16,
      }),
    ).toEqual({
      terminalCopy: "auto",
      terminalShiftEnter: "esc-cr",
      terminalMaximized: true,
      terminalKeysShown: true,
      terminalFontSize: 16,
    });
  });

  it("falls back per value when missing or unknown", () => {
    expect(parseTerminalSettings(undefined)).toEqual(DEFAULT_TERMINAL_SETTINGS);
    expect(parseTerminalSettings({ sidebarCollapsed: true })).toEqual(DEFAULT_TERMINAL_SETTINGS);
    expect(
      parseTerminalSettings({
        terminalCopy: "always",
        terminalShiftEnter: "lf",
        terminalMaximized: 1,
        terminalKeysShown: "yes",
        terminalFontSize: 99,
      }),
    ).toEqual({ ...DEFAULT_TERMINAL_SETTINGS, terminalShiftEnter: "lf" });
  });

  it("keeps only whole text sizes in range", () => {
    for (const size of [0, -1, 0.5, 21, 13.5, "14", Number.NaN]) {
      expect(parseTerminalSettings({ terminalFontSize: size }).terminalFontSize).toBeNull();
    }
    expect(parseTerminalSettings({ terminalFontSize: 1 }).terminalFontSize).toBe(1);
    expect(parseTerminalSettings({ terminalFontSize: 8 }).terminalFontSize).toBe(8);
    expect(parseTerminalSettings({ terminalFontSize: 20 }).terminalFontSize).toBe(20);
  });

  it("gives the defaults for stored values of the wrong shape, without throwing", () => {
    for (const stored of [[], ["auto"], "auto", 42, null]) {
      expect(parseTerminalSettings(stored)).toEqual(DEFAULT_TERMINAL_SETTINGS);
    }
  });
});
