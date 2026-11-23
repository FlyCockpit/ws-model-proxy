import { useEffect } from "react";

import { useTerminalModifiers } from "@/stores/terminal-modifiers";

/**
 * The key row's latched Ctrl/Alt belong to the terminal workspace on screen: leaving it (another
 * page, the last terminal closed) drops them, so a lock never turns a later key into a control key.
 */
export function useTerminalModifiersLifetime(): void {
  useEffect(() => () => useTerminalModifiers.getState().clear(), []);
}
