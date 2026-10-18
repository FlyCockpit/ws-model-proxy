import { toast } from "@ws-model-proxy/ui/components/sileo";
import { cn } from "@ws-model-proxy/ui/lib/utils";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useTerminalPane } from "@/hooks/use-terminal-pane";
import type { TerminalOutputEvent } from "@/hooks/use-terminal-sessions";
import type { TerminalImageAttachment } from "@/lib/terminal-images";
import type { TerminalSize } from "@/lib/terminal-writer";

type TerminalPaneProps = {
  localId: string;
  active: boolean;
  follow: TerminalSize | null;
  sendInput: (localId: string, data: string) => void;
  uploadImage: (
    localId: string,
    file: File,
    progress: (percent: number) => void,
  ) => Promise<TerminalImageAttachment>;
  pasteImage: (localId: string, id: string, data: string) => Promise<boolean>;
  sendResize: (localId: string, cols: number, rows: number) => void;
  subscribeOutput: (
    localId: string,
    listener: (event: TerminalOutputEvent) => void,
    reset?: () => void,
  ) => () => void;
};

export function TerminalPane(props: TerminalPaneProps) {
  const { t } = useTranslation("terminals");
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const containerRef = useTerminalPane({
    ...props,
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
        className={cn(
          "h-full min-h-0 w-full min-w-0 [&_.xterm-viewport]:[scrollbar-color:#3a414b_transparent]",
          // Following: the PTY-sized terminal sits top-left in a two-axis
          // scroll box, and the area it does not cover is shaded.
          props.follow
            ? "overflow-x-auto overflow-y-auto overscroll-contain bg-(--term-shade) [&>.xterm]:w-fit"
            : "overflow-x-hidden overflow-y-hidden",
        )}
      />
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
