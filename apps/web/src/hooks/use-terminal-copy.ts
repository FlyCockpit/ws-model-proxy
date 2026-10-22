import { toast } from "@ws-model-proxy/ui/components/sileo";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { deliverTerminalCopy } from "@/lib/terminal-clipboard";
import type { Osc52Copy } from "@/lib/terminal-copy-out";
import { useUiPreferences } from "@/stores/ui-preferences";

/** A copy waiting for the person's click, shown in its own pane. */
export type PendingTerminalCopy = { id: number; text: string };

/** Write to the clipboard, turning a synchronous failure (no Clipboard API) into a rejection. */
function writeClipboard(text: string): Promise<void> {
  try {
    return navigator.clipboard.writeText(text);
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * One pane's copy requests (OSC 52), delivered per the person's "When a program copies text"
 * setting. A request that needs a click waits in the pane's copy bar, not a toast: it belongs to
 * this tab, so closing the tab, a new attach (`clear`) or turning copying off drops it. Only the
 * newest request counts: an older one finishing late never replaces it.
 */
export function useTerminalCopy(): {
  onCopy: (copy: Osc52Copy) => void;
  /** The copy waiting for a click, or null. Hidden while copying is off. */
  pending: PendingTerminalCopy | null;
  /** The Copy button: a fresh gesture, so the write works in every browser. */
  copyPending: () => void;
  /** Dismiss the bar, or drop a pending copy at a session boundary. */
  clear: () => void;
} {
  const { t } = useTranslation("terminals");
  const mode = useUiPreferences((prefs) => prefs.terminalCopy);
  const [pending, setPending] = useState<PendingTerminalCopy | null>(null);
  const latestRef = useRef(0);

  const onCopy = useCallback(
    (copy: Osc52Copy) => {
      latestRef.current += 1;
      const id = latestRef.current;
      const isLatest = () => latestRef.current === id;
      void deliverTerminalCopy(useUiPreferences.getState().terminalCopy, copy, {
        writeText: writeClipboard,
        copied: () => {
          if (!isLatest()) return;
          setPending(null);
          toast.success(t("copyOut.copied"));
        },
        tooLarge: () => toast.warning(t("copyOut.tooLarge")),
        prompt: (text) => {
          if (isLatest()) setPending({ id, text });
        },
      });
    },
    [t],
  );

  const copyPending = useCallback(() => {
    const current = pending;
    setPending(null);
    // The setting may have changed since the request: it is checked again at the click.
    if (!current || useUiPreferences.getState().terminalCopy === "off") return;
    writeClipboard(current.text).then(
      () => toast.success(t("copyOut.copied")),
      () => toast.error(t("copyOut.blocked")),
    );
  }, [pending, t]);

  const clear = useCallback(() => {
    latestRef.current += 1;
    setPending(null);
  }, []);

  return { onCopy, pending: mode === "off" ? null : pending, copyPending, clear };
}
