/**
 * Where each browser-terminal tab is in attaching to its terminal, as one state machine per tab.
 * Every stage of an attach lives in one `AttachStage`, keyed by the tab's local id (with an index
 * by terminal id for relay messages), so a tab can never be in two stages at once and leaving a
 * stage cleans up what it held: a backoff's timer is cleared, a live session's attach ends.
 *
 * The stages overlap in time only where they hold each other: `handshake_sent` (and
 * `checking_identity` before it) is the whole attach until the relay answers; an exited shell's
 * session stays in `draining` until the output it sent first has been delivered, and a tab whose
 * keys are still being derived when its shell exits stays `establishing` so that output is not lost.
 */
import type { ReattachState } from "@/lib/terminal-writer";

/** What a handshake in progress must carry for the state machine. */
export type AttachHandshakeLike = {
  localId: string;
  /** The terminal it is for; null for an `open` until the relay names the terminal it made. */
  terminalId: string | null;
};

/** What a session must carry for the state machine. */
export type AttachSessionLike = {
  terminalId: string;
  /** The attach has ended: it sends nothing more (see the hook's `retireAttachment`). */
  ended: boolean;
};

export type AttachStage<H, S> =
  /** No attach under way and no session. A list, a click or a retry may start one. */
  | { stage: "idle" }
  /**
   * The handshake waits for the browser identity to load (or was refused because it had not
   * loaded). The identity effect retries the tab once it has. A tab here may still be attached.
   */
  | { stage: "awaiting_identity" }
  /**
   * Checking (and pinning) the CLI identity, then making the ephemeral key, before anything is
   * sent. The stage object is the attempt's token: a continuation whose token is no longer the
   * tab's stage stops.
   */
  | { stage: "checking_identity"; mode: "open" | "attach" }
  /** `open` or `attach` went out: waiting for the relay and the CLI (`opening`, `pending`...). */
  | { stage: "handshake_sent"; handshake: H }
  /** The CLI answered (`opened` / `attached`): deriving the session keys. */
  | { stage: "establishing"; handshake: H }
  /** Refused for rate (or slow): attach again when the timer fires. */
  | { stage: "backoff"; timer: ReturnType<typeof setTimeout> }
  /** Attached with session keys; input goes out on it. */
  | { stage: "live"; session: S }
  /** End session was pressed: the attach ended, its output still shows until the relay answers. */
  | { stage: "retired"; session: S }
  /** The shell exited (or is gone): output received first is delivered, then the session goes. */
  | { stage: "draining"; session: S };

export type AttachStageName = AttachStage<unknown, unknown>["stage"];

export type AttachEvent<H, S> =
  /** Start an attempt (`open` or `attach`): a fresh identity check, unless a session is held. */
  | { type: "check"; mode: "open" | "attach" }
  /** The identity check passed but the browser identity is still loading. */
  | { type: "identityLoading" }
  | { type: "handshakeSent"; handshake: H }
  /** The CLI answered the handshake: its keys are derived next. */
  | { type: "establishing" }
  | { type: "established"; session: S }
  /** Drop a handshake under way (identity check, sent, or deriving keys). Nothing else. */
  | { type: "abandon" }
  /** Drop the session (live, retired or draining). Nothing else. */
  | { type: "endAttach" }
  | { type: "backoff"; timer: ReturnType<typeof setTimeout> }
  | { type: "backoffElapsed" }
  /** Refused only because the browser identity had not loaded: retry once it has. */
  | { type: "awaitIdentity" }
  /** A retry: whatever it waited for is no longer awaited. */
  | { type: "retry" }
  /** End session pressed on a live tab. */
  | { type: "endSession" }
  /** The shell exited. Keys being derived still finish, so its last output is shown. */
  | { type: "exited" }
  /** The relay no longer lists the terminal. */
  | { type: "gone" }
  /** The receive chain of a draining session has been delivered. */
  | { type: "drained"; session: S }
  | { type: "socketClosed" }
  /** A new socket: nothing sent on an earlier one will be answered. */
  | { type: "socketOpened" };

const IDLE = { stage: "idle" } as const;
const AWAITING_IDENTITY = { stage: "awaiting_identity" } as const;

/** The session a stage holds (live, retired or draining), or null. */
export function stageSession<H, S>(stage: AttachStage<H, S>): S | null {
  return stage.stage === "live" || stage.stage === "retired" || stage.stage === "draining"
    ? stage.session
    : null;
}

/** A handshake is under way: from the identity check until the session is made. */
export function handshakeUnderWay<H, S>(stage: AttachStage<H, S>): boolean {
  return (
    stage.stage === "checking_identity" ||
    stage.stage === "handshake_sent" ||
    stage.stage === "establishing"
  );
}

/** Nothing holds the terminal: a new attach may start (a pending backoff gives way to it). */
export function attachIdle<H, S>(stage: AttachStage<H, S>): boolean {
  return stage.stage === "idle" || stage.stage === "awaiting_identity" || stage.stage === "backoff";
}

/**
 * The next stage for an event, or the same object when the event does not apply in this stage.
 * Pure: the cleanup of the stage left behind is `TerminalAttachments.apply`'s.
 */
export function transitionAttach<H, S>(
  stage: AttachStage<H, S>,
  event: AttachEvent<H, S>,
): AttachStage<H, S> {
  const session = stageSession(stage);
  switch (event.type) {
    case "check":
      return session ? stage : { stage: "checking_identity", mode: event.mode };
    case "identityLoading":
      return stage.stage === "checking_identity" ? AWAITING_IDENTITY : stage;
    case "handshakeSent":
      return stage.stage === "checking_identity"
        ? { stage: "handshake_sent", handshake: event.handshake }
        : stage;
    case "establishing":
      return stage.stage === "handshake_sent"
        ? { stage: "establishing", handshake: stage.handshake }
        : stage;
    case "established":
      return stage.stage === "establishing" ? { stage: "live", session: event.session } : stage;
    case "abandon":
      return handshakeUnderWay(stage) ? IDLE : stage;
    case "endAttach":
      return session ? IDLE : stage;
    case "backoff":
      return session ? stage : { stage: "backoff", timer: event.timer };
    case "backoffElapsed":
      return stage.stage === "backoff" ? IDLE : stage;
    case "awaitIdentity":
      return session ? stage : AWAITING_IDENTITY;
    case "retry":
      return stage.stage === "awaiting_identity" ? IDLE : stage;
    case "endSession":
      return stage.stage === "live" ? { stage: "retired", session: stage.session } : stage;
    case "exited":
      if (stage.stage === "live" || stage.stage === "retired")
        return { stage: "draining", session: stage.session };
      if (
        stage.stage === "checking_identity" ||
        stage.stage === "handshake_sent" ||
        stage.stage === "backoff"
      )
        return IDLE;
      // Deriving keys: the session still comes, to deliver what the shell sent first.
      return stage;
    case "gone":
      if (stage.stage === "live" || stage.stage === "retired")
        return { stage: "draining", session: stage.session };
      return stage.stage === "draining" ? stage : IDLE;
    case "drained":
      return stage.stage === "draining" && stage.session === event.session ? IDLE : stage;
    case "socketClosed":
      // Waiting for the browser identity outlives the socket: the identity effect retries it.
      return stage.stage === "awaiting_identity" ? stage : IDLE;
    case "socketOpened":
      return handshakeUnderWay(stage) ? IDLE : stage;
  }
}

/** One tab's attach state, and what belongs to its attaches whatever the stage. */
export type AttachEntry<H, S, F> = {
  readonly localId: string;
  /** The terminal this tab shows, once known (listed, or named by `opening`). */
  terminalId: string | null;
  stage: AttachStage<H, S>;
  /** The ticket an `open` redeems, until the relay has read it (a ticket opens one terminal). */
  ticket: string | null;
  /** Backoff history across this tab's rate-limited and slow reattaches. */
  reattach: ReattachState | undefined;
  /** The next output (a new attach's replay) resets the pane first. */
  resetBeforeOutput: boolean;
  /** Frames that arrived while no session holds the terminal; the next session reads them. */
  early: F[];
  /** The receive chain: frames decrypt and deliver one at a time, in order. */
  received: Promise<void> | null;
};

export type TerminalAttachmentsOptions<S> = {
  /**
   * End a session's attach (nothing more is sent, input settled, its pane told). Runs when a
   * stage holding it as `live` is left. `dropOutput`: the session leaves outright (its buffered
   * output is redrawn by the next attach's replay), not into `retired` or `draining`.
   */
  retire: (session: S, dropOutput: boolean) => void;
};

/** Every tab's attach state, keyed by local id, with an index by terminal id. */
export class TerminalAttachments<
  H extends AttachHandshakeLike,
  S extends AttachSessionLike,
  F = unknown,
> {
  private readonly byLocal = new Map<string, AttachEntry<H, S, F>>();
  private readonly byTerminal = new Map<string, Set<string>>();

  constructor(private readonly options: TerminalAttachmentsOptions<S>) {}

  add(localId: string, init: { terminalId: string | null; ticket?: string | null }): void {
    if (this.byLocal.has(localId)) return;
    this.byLocal.set(localId, {
      localId,
      terminalId: null,
      stage: IDLE,
      ticket: init.ticket ?? null,
      reattach: undefined,
      resetBeforeOutput: false,
      early: [],
      received: null,
    });
    if (init.terminalId) this.setTerminal(localId, init.terminalId);
  }

  get(localId: string): AttachEntry<H, S, F> | undefined {
    return this.byLocal.get(localId);
  }

  stage(localId: string): AttachStage<H, S> | undefined {
    return this.byLocal.get(localId)?.stage;
  }

  values(): AttachEntry<H, S, F>[] {
    return [...this.byLocal.values()];
  }

  /** The relay named the tab's terminal (an `open`'s `opening`). */
  setTerminal(localId: string, terminalId: string): void {
    const entry = this.byLocal.get(localId);
    if (!entry || entry.terminalId === terminalId) return;
    if (entry.terminalId) this.unindex(entry.terminalId, localId);
    entry.terminalId = terminalId;
    let locals = this.byTerminal.get(terminalId);
    if (!locals) {
      locals = new Set();
      this.byTerminal.set(terminalId, locals);
    }
    locals.add(localId);
  }

  /** Entries for a terminal (normally one: a terminal has one tab on a page). */
  forTerminal(terminalId: string): AttachEntry<H, S, F>[] {
    const locals = this.byTerminal.get(terminalId);
    if (!locals) return [];
    const entries: AttachEntry<H, S, F>[] = [];
    for (const localId of locals) {
      const entry = this.byLocal.get(localId);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  /** The entry holding a session (live, retired or draining) for the terminal. */
  sessionEntry(terminalId: string): AttachEntry<H, S, F> | undefined {
    return this.forTerminal(terminalId).find(
      (entry) => stageSession(entry.stage)?.terminalId === terminalId,
    );
  }

  sessionOf(terminalId: string): S | undefined {
    const entry = this.sessionEntry(terminalId);
    return entry ? (stageSession(entry.stage) ?? undefined) : undefined;
  }

  /**
   * The handshake waiting for the relay's answer for exactly this terminal id. No fallback to
   * the only handshake under way: an answer for another terminal must never match it.
   */
  handshakeFor(terminalId: string): H | undefined {
    if (terminalId.length === 0) return undefined;
    for (const entry of this.forTerminal(terminalId)) {
      if (entry.stage.stage === "handshake_sent" && entry.stage.handshake.terminalId === terminalId)
        return entry.stage.handshake;
    }
    return undefined;
  }

  /**
   * A new attach of the tab to `terminalId` may start: nothing of the tab's is under way, and no
   * tab holds a handshake or a session for the terminal.
   */
  canStartAttach(localId: string, terminalId: string): boolean {
    const entry = this.byLocal.get(localId);
    if (!entry || !attachIdle(entry.stage)) return false;
    return this.forTerminal(terminalId).every((other) => attachIdle(other.stage));
  }

  localIdsIn(stage: AttachStageName): string[] {
    const ids: string[] = [];
    for (const entry of this.byLocal.values())
      if (entry.stage.stage === stage) ids.push(entry.localId);
    return ids;
  }

  /**
   * Apply an event to a tab's stage and clean up the stage it leaves. Returns the stage now
   * (the same object when the event did not apply), or undefined for an unknown tab.
   */
  apply(localId: string, event: AttachEvent<H, S>): AttachStage<H, S> | undefined {
    const entry = this.byLocal.get(localId);
    if (!entry) return undefined;
    const previous = entry.stage;
    const next = transitionAttach(previous, event);
    if (next === previous) return next;
    this.leave(previous, next);
    entry.stage = next;
    return next;
  }

  /** Drop a handshake under way for the tab, and any other tab's for the same terminal. */
  abandon(localId: string, terminalId: string | null): void {
    this.apply(localId, { type: "abandon" });
    if (!terminalId) return;
    for (const entry of this.forTerminal(terminalId)) {
      const stage = entry.stage.stage;
      if (stage === "checking_identity" || stage === "handshake_sent")
        this.apply(entry.localId, { type: "abandon" });
    }
  }

  /** End and forget whatever session holds the terminal. */
  endAttachOf(terminalId: string): void {
    const entry = this.sessionEntry(terminalId);
    if (entry) this.apply(entry.localId, { type: "endAttach" });
  }

  /** Keep a frame no session can read yet, for the tab that will hold the terminal. */
  bufferEarly(terminalId: string, frame: F, limit: number): void {
    const entries = this.forTerminal(terminalId);
    const entry = entries.find((item) => handshakeUnderWay(item.stage)) ?? entries[0];
    if (!entry) return;
    entry.early.push(frame);
    if (entry.early.length > limit) entry.early.shift();
  }

  clearEarly(terminalId: string): void {
    for (const entry of this.forTerminal(terminalId)) entry.early = [];
  }

  /** The tab is gone: its stage is left (a live attach ends, a timer is cleared). */
  delete(localId: string): void {
    const entry = this.byLocal.get(localId);
    if (!entry) return;
    this.leave(entry.stage, IDLE);
    entry.stage = IDLE;
    this.byLocal.delete(localId);
    if (entry.terminalId) this.unindex(entry.terminalId, localId);
  }

  /** The page is gone: every attach ends and no timer fires. Entries stay. */
  dispose(): void {
    for (const entry of this.byLocal.values()) {
      this.leave(entry.stage, IDLE);
      entry.stage = IDLE;
    }
  }

  private leave(previous: AttachStage<H, S>, next: AttachStage<H, S>): void {
    if (previous.stage === "backoff") clearTimeout(previous.timer);
    if (previous.stage === "live") {
      const kept = stageSession(next) === previous.session;
      this.options.retire(previous.session, !kept);
    }
  }

  private unindex(terminalId: string, localId: string): void {
    const locals = this.byTerminal.get(terminalId);
    if (!locals) return;
    locals.delete(localId);
    if (locals.size === 0) this.byTerminal.delete(terminalId);
  }
}
