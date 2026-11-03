/**
 * Terminals this page asked the relay to end, until the relay says they ended. Owned by the
 * sessions hook, not the socket: a queued `close` dies with its socket, so an intent outlives it
 * and is sent again on the next one.
 */

/** What the socket did with a `close` frame. */
export type CloseSendOutcome = "taken" | "full" | "closed";

/**
 * Where an intent's `close` frame is:
 * - `unsent`: none is out on the current socket (it closed, or the page just disconnected).
 *   The next list that still names the terminal sends it, as does pressing End session again.
 * - `sent`: one is out, under `requestId`; the relay's answer names it.
 * - `backoff`: the socket's queue was full or the relay was busy: it goes again after a window.
 */
export type CloseSend =
  | { state: "unsent" }
  | { state: "sent"; requestId: string }
  | { state: "backoff"; retry: ReturnType<typeof setTimeout> };

export type CloseIntent = {
  /** The tab showing End session as pending, or null when no tab waits for it. */
  localId: string | null;
  /**
   * The list sequence number when this page learned of the terminal (or, if unknown, when the
   * intent began). A list requested after it that omits the terminal proves it is gone.
   */
  since: number;
  send: CloseSend;
};

export type CloseIntentsOptions = {
  /** Send `close` for `terminalId` under `requestId` on the current socket. */
  send: (terminalId: string, requestId: string) => CloseSendOutcome;
  newRequestId: () => string;
  /** How long a refused (`full` or `rate_limited`) close waits before it is sent again. */
  retryMs: number;
};

export class TerminalCloseIntents {
  private readonly intents = new Map<string, CloseIntent>();

  constructor(private readonly options: CloseIntentsOptions) {}

  has(terminalId: string): boolean {
    return this.intents.has(terminalId);
  }

  get(terminalId: string): Readonly<CloseIntent> | undefined {
    return this.intents.get(terminalId);
  }

  terminalIds(): string[] {
    return [...this.intents.keys()];
  }

  /** Whether an End session pressed on this tab still waits for the relay. */
  pendingFor(localId: string): boolean {
    for (const intent of this.intents.values()) if (intent.localId === localId) return true;
    return false;
  }

  /** The terminal whose `close` is out under `requestId`. */
  byRequestId(requestId: string): string | undefined {
    for (const [terminalId, intent] of this.intents) {
      if (intent.send.state === "sent" && intent.send.requestId === requestId) return terminalId;
    }
    return undefined;
  }

  /**
   * Ask the relay to end a terminal, and keep asking (across reconnects) until it says it did.
   * `localId`: the tab to remove once it has; null when no tab shows this terminal any more.
   * An existing intent takes the tab and is sent again if nothing of it is out.
   */
  request(terminalId: string, localId: string | null, since: number): void {
    const existing = this.intents.get(terminalId);
    if (existing) {
      if (localId) existing.localId = localId;
      if (existing.send.state === "unsent") this.sendNow(terminalId);
      return;
    }
    this.intents.set(terminalId, { localId, since, send: { state: "unsent" } });
    this.sendNow(terminalId);
  }

  /** A list still names the terminal: send its close again if none is out. */
  resendIfUnsent(terminalId: string): void {
    if (this.intents.get(terminalId)?.send.state === "unsent") this.sendNow(terminalId);
  }

  /** The relay refused the close unread (rate): send it again after one window. */
  backoff(terminalId: string): void {
    const intent = this.intents.get(terminalId);
    if (!intent || intent.send.state === "backoff") return;
    const retry = setTimeout(() => {
      if (this.intents.get(terminalId) !== intent) return;
      if (intent.send.state !== "backoff" || intent.send.retry !== retry) return;
      intent.send = { state: "unsent" };
      this.sendNow(terminalId);
    }, this.options.retryMs);
    intent.send = { state: "backoff", retry };
  }

  /** The intent is over (the relay ended the terminal, or refused for good): forget it. */
  settle(terminalId: string): Readonly<CloseIntent> | undefined {
    const intent = this.intents.get(terminalId);
    if (!intent) return undefined;
    this.clearRetry(intent);
    this.intents.delete(terminalId);
    return intent;
  }

  /** The tab is gone: its closes go on without it. */
  forgetTab(localId: string): void {
    for (const intent of this.intents.values())
      if (intent.localId === localId) intent.localId = null;
  }

  /**
   * Terminals whose close has taken effect by a list's word: the list (requested at
   * `requestedAt`) no longer names them, and they were known before it was requested.
   */
  provenGone(listed: ReadonlySet<string>, requestedAt: number): string[] {
    const gone: string[] = [];
    for (const [terminalId, intent] of this.intents) {
      if (!listed.has(terminalId) && intent.since < requestedAt) gone.push(terminalId);
    }
    return gone;
  }

  /** The socket closed: nothing out on it is answered, and a queued frame never left. */
  socketClosed(): void {
    for (const intent of this.intents.values()) {
      this.clearRetry(intent);
      intent.send = { state: "unsent" };
    }
  }

  /** The page is gone: no retry fires. */
  dispose(): void {
    this.socketClosed();
  }

  private sendNow(terminalId: string): void {
    const intent = this.intents.get(terminalId);
    if (!intent) return;
    this.clearRetry(intent);
    const requestId = this.options.newRequestId();
    const outcome = this.options.send(terminalId, requestId);
    intent.send = outcome === "taken" ? { state: "sent", requestId } : { state: "unsent" };
    if (outcome === "full") this.backoff(terminalId);
  }

  private clearRetry(intent: CloseIntent): void {
    if (intent.send.state === "backoff") clearTimeout(intent.send.retry);
  }
}
