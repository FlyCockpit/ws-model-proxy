/**
 * A terminal a node session holds (`session-manager.ts`): a browser shell or the operator
 * terminal of an interactive step, its phase and its viewers.
 *
 * Phases:
 * - `pending`: a browser shell that waits for its approval on the node (`approvalRequired`).
 *   Not counted against the terminal limits.
 * - `opening`: `term.open` was sent (browser shell) or the job was sent (operator terminal) and
 *   the node has not answered yet. A browser shell counts against the limits here.
 * - `open`: the node opened it (`term.opened`, or `awaiting_operator` for an operator
 *   terminal); people may attach.
 *
 * A browser shell that does not leave `pending` or `opening` by `expiresAt` is dropped by the
 * sweep (`sweepExpiredPendingTerminals`), so a node that never answers cannot hold a limit slot
 * forever. An operator terminal has no deadline: its step's lifecycle ends it.
 */
import { randomBytes } from "node:crypto";
import type { OperatorStep } from "./operator-step.js";

/** How long a node has to answer an open (or an attachment) before it is dropped. */
export const TERMINAL_PENDING_TTL_MS = 2 * 60 * 1000;

export type TerminalPhase =
  | { readonly kind: "pending"; readonly expiresAt: number }
  | { readonly kind: "opening"; readonly expiresAt: number | null }
  | { readonly kind: "open" };

/**
 * One browser tab's attachment to a terminal, by server-minted viewer id. `pending` waits for
 * the node (approval, or term.opened / term.attached); `attached` receives output.
 */
export type TerminalViewer =
  | { readonly state: "pending"; readonly connId: string; readonly requestedAt: number }
  | { readonly state: "attached"; readonly connId: string; readonly attachedAt: number };

export type AttachedViewer = Extract<TerminalViewer, { state: "attached" }>;
export type PendingViewer = Extract<TerminalViewer, { state: "pending" }>;

/** A terminal on a node (multi-viewer: every node frame names its viewer). */
export type TerminalRecord = {
  terminalId: string;
  userId: string;
  nodeId: string;
  cols: number;
  rows: number;
  viewers: Map<string, TerminalViewer>;
  /** Reported by the node with term.writer. */
  writerViewerId: string | null;
  phase: TerminalPhase;
  createdAt: number;
  /**
   * The interactive step this operator terminal belongs to (spec §4.7): opened by the node for
   * a `runtime.job` this server sent, attached only by a ticket from `runtimes.steps.attach`,
   * allowed at Relay only too, never listed with the browser shells and never counted against
   * their limits. Null for a browser shell. Its stage is the step's, not copied here.
   */
  operator: OperatorStep | null;
};

export function attachedViewer(
  terminal: TerminalRecord,
  viewerId: string,
): AttachedViewer | undefined {
  const viewer = terminal.viewers.get(viewerId);
  return viewer?.state === "attached" ? viewer : undefined;
}

export function pendingViewer(
  terminal: TerminalRecord,
  viewerId: string,
): PendingViewer | undefined {
  const viewer = terminal.viewers.get(viewerId);
  return viewer?.state === "pending" ? viewer : undefined;
}

export function attachedViewers(terminal: TerminalRecord): Array<[string, AttachedViewer]> {
  const attached: Array<[string, AttachedViewer]> = [];
  for (const [viewerId, viewer] of terminal.viewers)
    if (viewer.state === "attached") attached.push([viewerId, viewer]);
  return attached;
}

export function pendingViewers(terminal: TerminalRecord): Array<[string, PendingViewer]> {
  const pending: Array<[string, PendingViewer]> = [];
  for (const [viewerId, viewer] of terminal.viewers)
    if (viewer.state === "pending") pending.push([viewerId, viewer]);
  return pending;
}

export function mintViewerId(terminal?: TerminalRecord): string {
  for (;;) {
    const viewerId = randomBytes(16).toString("base64url");
    if (!terminal?.viewers.has(viewerId)) return viewerId;
  }
}

/** Distinct browser sockets that hold or wait for this terminal. */
export function terminalConnIds(terminal: TerminalRecord): string[] {
  const connIds = new Set<string>();
  for (const viewer of terminal.viewers.values()) connIds.add(viewer.connId);
  return [...connIds];
}

/** The (terminal, browser socket) -> viewer ids lookup, attached and pending. */
export function connViewerIds(terminal: TerminalRecord, connId: string): string[] {
  const viewerIds: string[] = [];
  for (const [viewerId, viewer] of terminal.viewers) {
    if (viewer.connId === connId) viewerIds.push(viewerId);
  }
  return viewerIds;
}

export function viewerIdForConn(
  terminal: TerminalRecord,
  connId: string,
  state: TerminalViewer["state"],
): string | null {
  for (const [viewerId, viewer] of terminal.viewers) {
    if (viewer.connId === connId && viewer.state === state) return viewerId;
  }
  return null;
}

/** A browser shell that holds a slot of the terminal limits (opening or open, not pending). */
export function holdsTerminalSlot(terminal: TerminalRecord): boolean {
  return terminal.operator === null && terminal.phase.kind !== "pending";
}

/** A browser shell the node never answered (approval or open) before its deadline. */
export function openDeadlinePassed(terminal: TerminalRecord, now: number): boolean {
  const phase = terminal.phase;
  if (phase.kind === "open") return false;
  return phase.expiresAt !== null && now >= phase.expiresAt;
}
