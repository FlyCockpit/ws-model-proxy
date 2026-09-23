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
        "absolute inset-0 min-w-0 bg-card text-card-foreground",
        props.active ? "visible" : "invisible",
      )}
      aria-hidden={props.active ? undefined : true}
    >
      <div
        ref={containerRef}
        className={cn(
          "h-full min-h-0 w-full min-w-0",
          // Following: the PTY-sized terminal sits top-left in a two-axis
          // scroll box, and the area it does not cover is shaded.
          props.follow
            ? "overflow-x-auto overflow-y-auto overscroll-contain bg-muted [&>.xterm]:w-fit"
            : "overflow-x-hidden overflow-y-hidden",
        )}
      />
    </div>
  );
}
