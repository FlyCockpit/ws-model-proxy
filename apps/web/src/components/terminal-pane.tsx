import { Button } from "@ws-model-proxy/ui/components/button";
import { toast } from "@ws-model-proxy/ui/components/sileo";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { WideContent } from "@/components/wide-content";
import { useTerminalCopy } from "@/hooks/use-terminal-copy";
import { useTerminalPane } from "@/hooks/use-terminal-pane";
import type { TerminalOutputEvent } from "@/hooks/use-terminal-sessions";
import type { TerminalImageAttachment } from "@/lib/terminal-images";
import { TERMINAL_FONT_FAMILY } from "@/lib/terminal-theme";
import type { TerminalInputOrigin, TerminalSize } from "@/lib/terminal-writer";
import { useUiPreferences } from "@/stores/ui-preferences";

type TerminalPaneProps = {
  localId: string;
  active: boolean;
  /** The id of this pane's tab, for its tabpanel's label. */
  tabId: string;
  panelId: string;
  follow: TerminalSize | null;
  /** Select text mode is on for this pane. */
  selecting: boolean;
  onDoneSelecting: () => void;
  sendInput: (localId: string, data: string | Uint8Array, origin?: TerminalInputOrigin) => void;
  uploadImage: (
    localId: string,
    file: File,
    progress: (percent: number) => void,
  ) => Promise<TerminalImageAttachment>;
  pasteImage: (localId: string, id: string, data: string) => Promise<boolean>;
  sendResize: (localId: string, cols: number, rows: number) => void;
  sizeUnavailable: (localId: string) => void;
  currentSession: (localId: string) => unknown;
  subscribeOutput: (
    localId: string,
    listener: (event: TerminalOutputEvent) => void,
    reset?: () => void,
    retire?: () => void,
  ) => () => void;
};

export function TerminalPane(props: TerminalPaneProps) {
  const { t } = useTranslation("terminals");
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const shiftEnter = useUiPreferences((prefs) => prefs.terminalShiftEnter);
  const copy = useTerminalCopy();
  const { containerRef, selectionText } = useTerminalPane({
    ...props,
    shiftEnter,
    onCopy: copy.onCopy,
    // A copy prompted before a new attach belongs to the old one.
    onReset: copy.clear,
    onImage: async (file) => {
      setUploadPercent(0);
      try {
        return await props.uploadImage(props.localId, file, setUploadPercent);
      } finally {
        setUploadPercent(null);
      }
    },
    onImageError: (error) => {
      const reason = error instanceof Error ? error.message : "other";
      switch (reason) {
        case "update":
          toast.error(t("imagePaste.update"));
          break;
        case "too_large":
          toast.error(t("imagePaste.tooLarge"));
          break;
        case "unsupported":
          toast.error(t("imagePaste.unsupported"));
          break;
        case "busy":
          toast.error(t("imagePaste.busy"));
          break;
        case "selecting":
          toast.error(t("imagePaste.selecting"));
          break;
        case "hidden":
          toast.error(t("imagePaste.hidden"));
          break;
        case "limit":
          toast.error(t("imagePaste.limit"));
          break;
        case "node_limit":
          toast.error(t("imagePaste.nodeLimit"));
          break;
        case "overloaded":
          toast.error(t("imagePaste.overloaded"));
          break;
        case "timeout":
          toast.error(t("imagePaste.timeout"));
          break;
        default:
          toast.error(t("imagePaste.failed"));
      }
    },
  });
  return (
    <div
      id={props.panelId}
      role="tabpanel"
      aria-labelledby={props.tabId}
      className={cn(
        // Padding sits here, not on the xterm box: FitAddon measures that box's
        // border-box height, so padding there would overflow by a row.
        "absolute inset-0 min-w-0 bg-(--term-bg) py-2 ps-3 pe-1",
        props.active ? "visible" : "invisible",
      )}
      aria-hidden={props.active ? undefined : true}
    >
      <div
        ref={containerRef}
        // Select text: the live terminal takes no focus, keys, or mouse until it ends.
        inert={selectionText !== null}
        className={cn(
          "h-full min-h-0 w-full min-w-0 [&_.xterm-viewport]:[scrollbar-color:#3a414b_transparent]",
          // Following: the PTY-sized terminal sits top-left in a two-axis
          // scroll box, and the area it does not cover is shaded. This box cannot be split into
          // a vertical scroller around WideContent: xterm opens directly in it and FitAddon
          // measures it as the pane's size, so it must stay the pane-sized box itself.
          props.follow
            ? "overflow-x-auto overflow-y-auto overscroll-contain bg-(--term-shade) [&>.xterm]:w-fit"
            : "overflow-x-hidden overflow-y-hidden",
        )}
      />
      {selectionText !== null ? (
        <SelectTextOverlay text={selectionText} onDone={props.onDoneSelecting} />
      ) : null}
      {copy.pending && selectionText === null ? (
        <CopyBar onCopy={copy.copyPending} onDismiss={copy.clear} />
      ) : null}
      {uploadPercent !== null ? (
        <div
          role="status"
          className="pointer-events-none absolute bottom-3 start-3 rounded-md bg-background px-3 py-2 text-sm text-foreground shadow-sm"
        >
          {t("imagePaste.uploading", { percent: uploadPercent })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A program's copy waiting for a click. It sits over the bottom of the pane rather than taking
 * layout space, so showing it never refits the terminal (which would resize the PTY).
 */
function CopyBar({ onCopy, onDismiss }: { onCopy: () => void; onDismiss: () => void }) {
  const { t } = useTranslation("terminals");
  return (
    <section
      aria-label={t("copyOut.promptTitle")}
      className="absolute inset-x-0 bottom-0 flex min-w-0 flex-wrap items-center justify-between gap-2 border-(--term-border) border-t bg-(--term-chrome) px-3 py-1.5 text-(--term-fg) text-sm"
    >
      <div className="min-w-0" role="status">
        <p>{t("copyOut.promptTitle")}</p>
        <p className="text-(--term-muted) text-xs">{t("copyOut.promptBody")}</p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button type="button" size="touch" variant="ghost" onClick={onDismiss}>
          {t("copyOut.dismiss")}
        </Button>
        <Button type="button" size="touch" variant="secondary" onClick={onCopy}>
          {t("copyOut.promptAction")}
        </Button>
      </div>
    </section>
  );
}

/** Select text: a frozen plain-text copy of the terminal that selects and copies natively. */
function SelectTextOverlay({ text, onDone }: { text: string; onDone: () => void }) {
  const { t } = useTranslation("terminals");
  // Open at the bottom, where the newest output is, once per opening: a stable callback, so a
  // re-render never scrolls the person away from history they are selecting.
  const scrollToNewest = useCallback((node: HTMLDivElement | null) => {
    if (node) node.scrollTop = node.scrollHeight;
  }, []);
  return (
    <div className="absolute inset-0 flex min-h-0 min-w-0 flex-col bg-(--term-bg)">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-(--term-border) border-b bg-(--term-chrome) px-3 py-1.5 text-(--term-fg) text-sm">
        <div className="min-w-0" role="status">
          <p>{t("selectText.paused")}</p>
          <p className="text-(--term-muted) text-xs">{t("selectText.tmuxNote")}</p>
        </div>
        <Button type="button" size="touch" variant="secondary" onClick={onDone}>
          {t("selectText.done")}
        </Button>
      </div>
      {/* Lines keep their terminal width: the box scrolls vertically, and wide lines scroll
          sideways in WideContent. */}
      <div
        ref={scrollToNewest}
        // A scrollable region must be reachable by keyboard to scroll it.
        tabIndex={0}
        role="region"
        aria-label={t("selectText.label")}
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
      >
        {/* Its own tab stop: the sideways scroller is a separate box from the vertical one. */}
        <WideContent tabIndex={0} role="region" aria-label={t("selectText.wideLabel")}>
          <pre
            style={{ fontFamily: TERMINAL_FONT_FAMILY }}
            className="w-fit select-text whitespace-pre py-2 ps-3 pe-1 text-(--term-fg) text-[13px] leading-[1.2]"
          >
            {text}
          </pre>
        </WideContent>
      </div>
    </div>
  );
}
