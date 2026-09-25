import { cn } from "@ws-model-proxy/ui/lib/utils";

import type { TerminalTab } from "@/hooks/use-terminal-sessions";

type Tone = "live" | "pending" | "problem" | "ended";

function toneOf(tab: TerminalTab): Tone {
  if (tab.phase === "rejected") return "problem";
  if (tab.phase === "exited") return "ended";
  if (tab.phase === "opening" || tab.phase === "waiting" || tab.error === "slow") {
    return "pending";
  }
  if (tab.error && tab.error !== "detached") return "problem";
  return "live";
}

/** A small colored dot for a tab's phase. Its label comes from the tab or status text. */
export function TerminalStatusDot({ tab, className }: { tab: TerminalTab; className?: string }) {
  const tone = toneOf(tab);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        tone === "live" && "bg-emerald-400",
        tone === "pending" && "animate-pulse bg-amber-400",
        tone === "problem" && "bg-red-400",
        tone === "ended" && "bg-zinc-500",
        className,
      )}
    />
  );
}
