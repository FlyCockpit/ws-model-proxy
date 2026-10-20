import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  DEFAULT_TERMINAL_SETTINGS,
  parseTerminalSettings,
  type TerminalCopyMode,
  type TerminalSettings,
  type TerminalShiftEnterMode,
} from "@/lib/terminal-settings";

interface UiPreferencesState extends TerminalSettings {
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setTerminalCopy: (mode: TerminalCopyMode) => void;
  setTerminalShiftEnter: (mode: TerminalShiftEnterMode) => void;
  setTerminalMaximized: (maximized: boolean) => void;
}

export const useUiPreferences = create<UiPreferencesState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      ...DEFAULT_TERMINAL_SETTINGS,
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      setTerminalCopy: (mode) => set({ terminalCopy: mode }),
      setTerminalShiftEnter: (mode) => set({ terminalShiftEnter: mode }),
      setTerminalMaximized: (maximized) => set({ terminalMaximized: maximized }),
    }),
    {
      name: "ui-preferences",
      storage: createJSONStorage(() => localStorage),
      // Stored values are untrusted (older builds, hand edits): unknown ones fall back.
      merge: (persisted, current) => {
        const stored = typeof persisted === "object" && persisted !== null ? persisted : {};
        const sidebarCollapsed =
          "sidebarCollapsed" in stored && typeof stored.sidebarCollapsed === "boolean"
            ? stored.sidebarCollapsed
            : current.sidebarCollapsed;
        return { ...current, sidebarCollapsed, ...parseTerminalSettings(stored) };
      },
    },
  ),
);
