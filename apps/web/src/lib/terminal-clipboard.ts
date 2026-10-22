import type { Osc52Copy } from "@/lib/terminal-copy-out";
import type { TerminalCopyMode } from "@/lib/terminal-settings";

export type TerminalCopyUi = {
  writeText: (text: string) => Promise<void>;
  /** Ask first: a Copy button whose click is a fresh user gesture. */
  prompt: (text: string) => void;
  copied: () => void;
  tooLarge: () => void;
};

/**
 * Deliver a program's copy request per the person's setting. `auto` writes at once and falls back
 * to the prompt when the browser refuses (Safari wants the write inside a gesture).
 */
export async function deliverTerminalCopy(
  mode: TerminalCopyMode,
  copy: Osc52Copy,
  ui: TerminalCopyUi,
): Promise<void> {
  if (mode === "off") return;
  if (copy.kind === "too_large") {
    ui.tooLarge();
    return;
  }
  if (mode === "prompt") {
    ui.prompt(copy.text);
    return;
  }
  try {
    await ui.writeText(copy.text);
    ui.copied();
  } catch {
    ui.prompt(copy.text);
  }
}
