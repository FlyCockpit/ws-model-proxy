import { toast } from "@ws-model-proxy/ui/lib/toast";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { dataTransferHasFiles, findFileDropTarget } from "@/lib/file-drop-registry";

/** Protect the document without claiming the terminal's existing image drops. */
export function useFileDropGuard(): void {
  const { t } = useTranslation("common");
  useEffect(() => {
    const inTerminal = (event: DragEvent) =>
      event.composedPath().some((node) => node instanceof Element && node.matches(".xterm"));
    const onDragOver = (event: DragEvent) => {
      if (event.defaultPrevented || !dataTransferHasFiles(event.dataTransfer) || inTerminal(event))
        return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = findFileDropTarget(event.composedPath()) ? "copy" : "none";
      }
    };
    const onDrop = (event: DragEvent) => {
      if (event.defaultPrevented || !dataTransferHasFiles(event.dataTransfer) || inTerminal(event))
        return;
      event.preventDefault();
      const target = findFileDropTarget(event.composedPath());
      if (target) target.onFiles(Array.from(event.dataTransfer?.files ?? []));
      else toast.info(t("fileDrop.ignored"));
    };
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", onDrop);
    };
  }, [t]);
}
