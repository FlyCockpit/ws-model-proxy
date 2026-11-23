import { create } from "zustand";

import type { TerminalKeyModifiers } from "@/lib/terminal-key-encoding";
import {
  consumeModifierLatch,
  type ModifierLatch,
  tapModifierLatch,
} from "@/lib/terminal-key-gestures";

export type LatchableModifier = "ctrl" | "alt";

type TerminalModifiersState = {
  ctrl: ModifierLatch;
  alt: ModifierLatch;
  /** When each latch last turned `once` (for the double tap that locks it). */
  tappedAt: Record<LatchableModifier, number>;
  tap: (modifier: LatchableModifier, now: number) => void;
  /** The latched modifiers, or null when none is latched. */
  active: () => TerminalKeyModifiers | null;
  /** A key used the latched modifiers: one-key latches end. */
  consume: () => void;
  clear: () => void;
};

/**
 * The key row's latched Ctrl/Alt (tap = the next key, double-tap = locked). Not persisted: a
 * latch belongs to this page, and applies to the next key whichever pane it goes to.
 */
export const useTerminalModifiers = create<TerminalModifiersState>()((set, get) => ({
  ctrl: "off",
  alt: "off",
  tappedAt: { ctrl: 0, alt: 0 },
  tap: (modifier, now) =>
    set((state) => {
      const next = tapModifierLatch(state[modifier], state.tappedAt[modifier], now);
      return {
        [modifier]: next,
        tappedAt: next === "once" ? { ...state.tappedAt, [modifier]: now } : state.tappedAt,
      };
    }),
  active: () => {
    const { ctrl, alt } = get();
    if (ctrl === "off" && alt === "off") return null;
    return { ctrl: ctrl !== "off", alt: alt !== "off" };
  },
  consume: () => {
    const { ctrl, alt } = get();
    const next = { ctrl: consumeModifierLatch(ctrl), alt: consumeModifierLatch(alt) };
    if (next.ctrl !== ctrl || next.alt !== alt) set(next);
  },
  clear: () => set({ ctrl: "off", alt: "off" }),
}));
