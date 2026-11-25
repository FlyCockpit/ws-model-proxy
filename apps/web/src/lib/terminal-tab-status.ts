/**
 * A browser-terminal tab's status, as one state machine. Every status change on a tab goes
 * through `transitionTab`, so a tab can never carry fields of a status it is not in (an
 * approval code on a live tab, a refusal reason on an opening one).
 */

/** Why an opening tab is opening again after it was live. */
export type TabReopenCause =
  /** The relay detached this viewer for falling behind; it reattaches with backoff. */
  | "slow"
  /** The relay detached this viewer for another reason; a list or a click attaches it again. */
  | "detached";

export type TabStatus =
  /**
   * Its handshake has not finished (or has not started: waiting for the CLI identity check, the
   * browser identity, a backoff, or the next socket). `approvalCode`: the CLI asked for this
   * handshake to be approved on the node. `reopen`: it was live, and the relay detached it.
   */
  | { phase: "opening"; approvalCode: string | null; reopen: TabReopenCause | null }
  /** Attached with session keys. `inputDropped`: the relay dropped some input moments ago. */
  | { phase: "live"; inputDropped: boolean }
  /**
   * Refused before or while attaching (by this page, the relay or the CLI). `approvalCode`: the
   * CLI refused this browser because it is not approved there yet (`approval_required`); approving
   * that code on the node and opening the terminal again lets it in.
   */
  | { phase: "rejected"; reason: string; approvalCode?: string }
  /** The terminal's process ended, with how it ended from the relay's exit message. */
  | { phase: "exited"; cause: "exit"; exitCode: number | null; exitSignal: string | null }
  /** The relay's terminal list no longer has the terminal (it ended while this page was away). */
  | { phase: "exited"; cause: "gone" };

export type TabEvent =
  /** Start the handshake again: everything about the earlier attempt is dropped. */
  | { type: "retry" }
  /** The relay took this tab's `open` or `attach` (`opening` / `attaching`). */
  | { type: "acknowledged" }
  /** The CLI asked for this handshake to be approved (`pending`). */
  | { type: "approvalRequested"; approvalCode: string | null }
  /** The session keys are in place. */
  | { type: "established" }
  /** Refused, for `reason` (with the approval code the CLI named, if any). */
  | { type: "refused"; reason: string; approvalCode?: string | null }
  /** An error from the relay naming this terminal: it refuses an opening tab, nothing else. */
  | { type: "relayError"; reason: string }
  /** The relay detached this viewer while the terminal runs on. */
  | { type: "detached"; cause: TabReopenCause }
  /** The socket closed: an attached or attaching tab attaches again on the next one. */
  | { type: "disconnected" }
  | { type: "exited"; exitCode: number | null; exitSignal: string | null }
  | { type: "gone" }
  | { type: "inputDropped" }
  | { type: "inputDroppedExpired" };

export const OPENING: TabStatus = { phase: "opening", approvalCode: null, reopen: null };

/** The tab no longer attaches: it ended, or it was refused. */
export function tabEnded(status: TabStatus): boolean {
  return status.phase === "exited" || status.phase === "rejected";
}

/** The refusal reason of a rejected tab, or null. */
export function tabRejection(status: TabStatus): string | null {
  return status.phase === "rejected" ? status.reason : null;
}

/** The approval code an opening tab waits on, or a refused tab needs before it is opened again. */
export function tabApprovalCode(status: TabStatus): string | null {
  if (status.phase === "opening") return status.approvalCode;
  if (status.phase === "rejected") return status.approvalCode ?? null;
  return null;
}

/**
 * The next status of a tab for an event, or the same object when the event does not apply in
 * its status. An exited tab stays exited, except that a later exit message fills in how a
 * terminal already marked gone ended.
 */
export function transitionTab(status: TabStatus, event: TabEvent): TabStatus {
  switch (event.type) {
    case "retry":
      if (status.phase === "exited") return status;
      return status.phase === "opening" && status.approvalCode === null && status.reopen === null
        ? status
        : OPENING;
    case "acknowledged":
      // The relay answered this attempt: a notice from an earlier attach no longer applies.
      if (status.phase !== "opening" || status.reopen === null) return status;
      return { ...status, reopen: null };
    case "approvalRequested":
      if (status.phase !== "opening" || status.approvalCode === event.approvalCode) return status;
      return { ...status, approvalCode: event.approvalCode };
    case "established":
      if (status.phase === "opening") return { phase: "live", inputDropped: false };
      return status;
    case "refused": {
      if (status.phase === "exited") return status;
      const approvalCode = event.approvalCode ?? undefined;
      if (
        status.phase === "rejected" &&
        status.reason === event.reason &&
        status.approvalCode === approvalCode
      )
        return status;
      return approvalCode === undefined
        ? { phase: "rejected", reason: event.reason }
        : { phase: "rejected", reason: event.reason, approvalCode };
    }
    case "relayError":
      return status.phase === "opening" ? { phase: "rejected", reason: event.reason } : status;
    case "detached":
      if (status.phase !== "live" && status.phase !== "opening") return status;
      if (
        status.phase === "opening" &&
        status.approvalCode === null &&
        status.reopen === event.cause
      )
        return status;
      return { phase: "opening", approvalCode: null, reopen: event.cause };
    case "disconnected":
      if (status.phase !== "live" && status.phase !== "opening") return status;
      return transitionTab(status, { type: "retry" });
    case "exited":
      if (status.phase === "exited" && status.cause === "exit") return status;
      return {
        phase: "exited",
        cause: "exit",
        exitCode: event.exitCode,
        exitSignal: event.exitSignal,
      };
    case "gone":
      if (status.phase === "exited") return status;
      return { phase: "exited", cause: "gone" };
    case "inputDropped":
      if (status.phase !== "live" || status.inputDropped) return status;
      return { phase: "live", inputDropped: true };
    case "inputDroppedExpired":
      if (status.phase !== "live" || !status.inputDropped) return status;
      return { phase: "live", inputDropped: false };
  }
}
