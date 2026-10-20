import { toast } from "@ws-model-proxy/ui/components/sileo";
import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";

import { deliverTerminalCopy } from "@/lib/terminal-clipboard";
import type { Osc52Copy } from "@/lib/terminal-copy-out";
import { useUiPreferences } from "@/stores/ui-preferences";

/** How long the "Copy" prompt stays up. */
const COPY_PROMPT_MS = 15_000;

/**
 * Deliver a program's copy request (OSC 52) per the person's "When a program copies text"
 * setting. Only the latest prompt is shown: a newer copy replaces it.
 */
export function useTerminalCopy(): (copy: Osc52Copy) => void {
  const { t } = useTranslation("terminals");
  const promptIdRef = useRef<string | null>(null);

  return useCallback(
    (copy: Osc52Copy) => {
      const writeText = (text: string) => navigator.clipboard.writeText(text);
      const copied = () => toast.success(t("copyOut.copied"));
      const blocked = () => toast.error(t("copyOut.blocked"));
      void deliverTerminalCopy(useUiPreferences.getState().terminalCopy, copy, {
        writeText,
        copied,
        tooLarge: () => toast.warning(t("copyOut.tooLarge")),
        prompt: (text) => {
          if (promptIdRef.current) toast.dismiss(promptIdRef.current);
          const id = toast.info(t("copyOut.promptTitle"), {
            description: t("copyOut.promptBody"),
            duration: COPY_PROMPT_MS,
            action: {
              label: t("copyOut.promptAction"),
              // The click is a fresh user gesture, so the write works in every browser.
              onClick: () => {
                toast.dismiss(id);
                if (promptIdRef.current === id) promptIdRef.current = null;
                writeText(text).then(copied, blocked);
              },
            },
          });
          promptIdRef.current = id;
        },
      });
    },
    [t],
  );
}
