import { toast } from "@ws-model-proxy/ui/components/sileo";
import { useCallback, useEffect, useRef, useState } from "react";
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
 * this tab, so closing the tab, a new attach (`clear`) or turning copying off drops it (turning it
 * back on does not bring it back). Only the newest live request counts: an older one, or one from
 * a closed pane, finishing late does nothing.
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
  /** The current request's generation; anything that retires requests advances it. */
  const latestRef = useRef(0);

  const clear = useCallback(() => {
    latestRef.current += 1;
    setPending(null);
  }, []);

  // Turning copying off retires what is pending, rather than hiding it until it is turned back on.
  useEffect(() => {
    if (mode === "off") clear();
  }, [mode, clear]);

  // A closed pane's requests are retired: a write still in flight reports nothing.
  useEffect(
    () => () => {
      latestRef.current += 1;
    },
    [],
  );

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
        tooLarge: () => {
          if (isLatest()) toast.warning(t("copyOut.tooLarge"));
        },
        prompt: (text) => {
          // An automatic copy the browser refused falls back to the bar, unless copying was
          // turned off meanwhile.
          if (isLatest() && useUiPreferences.getState().terminalCopy !== "off")
            setPending({ id, text });
        },
      });
    },
    [t],
  );

  const copyPending = useCallback(() => {
    const current = pending;
    setPending(null);
    // The click may land before a retirement (a new attach, the setting) re-renders the bar:
    // the request must still be the current one, and copying still allowed.
    if (!current || current.id !== latestRef.current) return;
    if (useUiPreferences.getState().terminalCopy === "off") return;
    writeClipboard(current.text).then(
      () => toast.success(t("copyOut.copied")),
      () => toast.error(t("copyOut.blocked")),
    );
  }, [pending, t]);

  return { onCopy, pending: mode === "off" ? null : pending, copyPending, clear };
}
