import { cn } from "@ws-model-proxy/ui/lib/utils";

import { useTerminalPane } from "@/hooks/use-terminal-pane";

type TerminalPaneProps = {
  localId: string;
  active: boolean;
  sendInput: (localId: string, data: string) => void;
  sendResize: (localId: string, cols: number, rows: number) => void;
  subscribeOutput: (
    localId: string,
    listener: (data: Uint8Array) => void,
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
        className="h-full min-h-0 w-full min-w-0 overflow-x-hidden overflow-y-hidden"
      />
    </div>
  );
}
