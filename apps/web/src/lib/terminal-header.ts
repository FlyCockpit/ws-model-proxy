import type { TerminalWriterLabel } from "@/lib/terminal-protocol";
import type { TabStatus } from "@/lib/terminal-tab-status";

/**
 * The phone terminal header (640px wide or less): one fixed row with the terminal picker, the ⋯
 * menu and Maximize/Restore. Wider screens keep the tab strip and toolbar.
 */
export const TERMINAL_PHONE_HEADER_QUERY = "(max-width: 640px)";

type HeaderTab = { status: TabStatus; writer: TerminalWriterLabel };

/** Keyboard: this viewer can type. Eye: view only, because another viewer holds the input. */
export function terminalInputIcon(tab: HeaderTab): "keyboard" | "eye" {
  return tab.writer === "other" ? "eye" : "keyboard";
}

/** The status icon's color: green connected, amber opening, red refused, grey ended. */
export type TerminalTone = "live" | "opening" | "rejected" | "exited";

export function terminalTone(status: TabStatus): TerminalTone {
  return status.phase;
}

/**
 * The picker list's second line, as locale keys: the phase, then (connected only) whether this
 * viewer is typing or only viewing.
 */
export function terminalModeKeys(tab: HeaderTab): { phase: string; mode: string | null } {
  const phase = `terminals:phase.${tab.status.phase}`;
  if (tab.status.phase !== "live") return { phase, mode: null };
  return {
    phase,
    mode: terminalInputIcon(tab) === "eye" ? "terminals:header.viewing" : "terminals:header.typing",
  };
}

/**
 * Names for the picker: a node's name alone, or numbered (`name (2)`) when several open tabs
 * are on the same node, in tab order.
 */
export function pickerLabels<T>(tabs: readonly T[], nameOf: (tab: T) => string): Map<T, string> {
  const counts = new Map<string, number>();
  for (const tab of tabs) counts.set(nameOf(tab), (counts.get(nameOf(tab)) ?? 0) + 1);
  const seen = new Map<string, number>();
  const labels = new Map<T, string>();
  for (const tab of tabs) {
    const name = nameOf(tab);
    if ((counts.get(name) ?? 0) < 2) {
      labels.set(tab, name);
      continue;
    }
    const index = (seen.get(name) ?? 0) + 1;
    seen.set(name, index);
    labels.set(tab, `${name} (${index})`);
  }
  return labels;
}

/**
 * Whether a tab has something the phone header must still say, inline in the terminal area: how
 * it ended, why it was refused, an approval to run on the node, a failed End session, or dropped
 * input. Who is typing and how many view are shown by the picker instead.
 */
export function terminalNoticeNeeded(tab: {
  status: TabStatus;
  ending: "pending" | "failed" | null;
}): boolean {
  const { status } = tab;
  if (status.phase === "exited" || status.phase === "rejected") return true;
  // A refused End session shows while the tab is (re)opening too.
  if (tab.ending === "failed") return true;
  if (status.phase === "opening") return status.approvalCode !== null;
  return status.inputDropped;
}

/**
 * What the phone notice says, as a key: a dismissed notice stays away only until it has something
 * else to say (a new refusal, exit or approval, End session failing again, input dropped again).
 */
export function terminalNoticeKey(tab: {
  localId: string;
  status: TabStatus;
  ending: "pending" | "failed" | null;
}): string {
  const { status } = tab;
  const what =
    status.phase === "exited"
      ? status.cause === "gone"
        ? "gone"
        : `exit:${status.exitCode ?? ""}:${status.exitSignal ?? ""}`
      : status.phase === "rejected"
        ? `rejected:${status.reason}`
        : status.phase === "opening"
          ? `approval:${status.approvalCode ?? ""}`
          : `live:${status.inputDropped ? "dropped" : ""}`;
  return `${tab.localId}|${what}|${tab.ending ?? ""}`;
}
