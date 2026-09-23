import { cn } from "@ws-model-proxy/ui/lib/utils";
import { useTerminalPane } from "@/hooks/use-terminal-pane";
import type { TerminalOutputEvent } from "@/hooks/use-terminal-sessions";
import type { TerminalSize } from "@/lib/terminal-writer";

type TerminalPaneProps = {
  localId: string;
  active: boolean;
  follow: TerminalSize | null;
  sendInput: (localId: string, data: string) => void;
  sendResize: (localId: string, cols: number, rows: number) => void;
  subscribeOutput: (
    localId: string,
    listener: (event: TerminalOutputEvent) => void,
    reset?: () => void,
  ) => () => void;
};

export function TerminalPane(props: TerminalPaneProps) {
  const containerRef = useTerminalPane(props);
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
    </div>
  );
}
