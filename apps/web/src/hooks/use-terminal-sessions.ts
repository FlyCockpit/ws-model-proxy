import { TERMINAL_BROWSER_JSON_WINDOW_MS } from "@ws-model-proxy/config/terminal-socket-policy";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLatestRef } from "@/hooks/use-latest-ref";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  concatBytes,
  DIRECTION_BROWSER_TO_CLI,
  DIRECTION_CLI_TO_BROWSER,
  decodeTerminalPlaintextV2,
  deriveTerminalSessionKeysV2,
  encodeTerminalData,
  encodeTerminalResize,
  generateEphemeralHandshake,
  importEcdhPublicRaw,
  importTerminalOutputKey,
  openTerminalBroadcast,
  openTerminalBytesV2,
  sealTerminalBytesV2,
  type TerminalPlaintext,
  useTerminalIdentity,
} from "@/hooks/use-terminal-crypto";
import {
  sendTaken,
  type TerminalSendResult,
  type TerminalSocketStatus,
  useTerminalSocket,
} from "@/hooks/use-terminal-socket";
import {
  type ChangedCliTrust,
  type CliPinStore,
  type CliTrust,
  cliTrustInputKey,
  evaluateCliTrust,
  indexedDbCliPinStore,
  trustAllowsHandshake,
  trustAppliedSnapshot,
  trustNewCliKey,
  trustRejectionReason,
} from "@/lib/terminal-cli-identity";
import {
  encodeTerminalImageControl,
  TERMINAL_IMAGE_PASTE,
  type TerminalImageAttachment,
  TerminalImageTransfer,
} from "@/lib/terminal-images";
import { takePendingByTerminalId } from "@/lib/terminal-pending";
import {
  clampTerminalAxis,
  encodeSealedFrame,
  type ListedCli,
  type SealedTerminalFrame,
  type TerminalClientMessage,
  type TerminalServerMessage,
  type TerminalWriterLabel,
  typableCommand,
} from "@/lib/terminal-protocol";
import {
  canSendResize,
  classifyBroadcastEpoch,
  needsTakeover,
  nextReattach,
  type ReattachState,
  sameSize,
  TERMINAL_FUTURE_EPOCH_QUEUE,
  TERMINAL_RESIZE_DEBOUNCE_MS,
  type TerminalInputOrigin,
  type TerminalSize,
  type TerminalWriterState,
} from "@/lib/terminal-writer";

export type { TerminalInputOrigin };

const textEncoder = new TextEncoder();
/**
 * Leading-edge input throttle per tab. The first keystroke goes out at once;
 * later ones in the same window share one frame. This keeps key repeat under
 * the server's 30 frames per second per tab.
 */
const INPUT_FLUSH_INTERVAL_MS = 50;
const INPUT_BATCH_MAX_CHARS = 16 * 1024;
const INPUT_DROPPED_NOTICE_MS = 5_000;
/** Frames that arrive before the handshake finishes. Covers a full scrollback replay. */
const EARLY_FRAME_QUEUE = 64;
const OUTPUT_BUFFER_EVENTS = 256;
/** Open a terminal anyway if the relay does not answer a CLI list request. */
const CLI_LIST_REFRESH_TIMEOUT_MS = 5_000;
/**
 * A ticket's command is typed once the shell's output has been quiet this long, so it lands
 * after the prompt and not inside a login banner or an rc file's output. A heuristic: a shell
 * that pauses longer mid-startup still gets the text early, which the line discipline buffers
 * and echoes; the person reads it before pressing Enter either way.
 */
const TYPED_COMMAND_QUIET_MS = 300;
/** Refusals that "Trust new key" can lift. A key swapped mid-handshake cannot. */
const IDENTITY_RETRY_REASONS = new Set(["identity_changed", "identity_invalid"]);
/** The CLI refuses a handshake that carries no browser identity with this reason. */
const BROWSER_IDENTITY_REQUIRED = "approval_required";
/**
 * `error` on a tab marked exited because the relay's terminal list no longer
 * has its terminal (it ended, or its CLI restarted, while this page was away).
 */
export const TERMINAL_GONE = "gone";

/**
 * One piece of queued input. `text`: a ticket's typed command, kept so it can be typed again if
 * it cannot go out now. `image`: an image's path, sent as its own image-paste frame; `done`
 * reports whether it reached the socket.
 */
type InputItem = {
  bytes: Uint8Array;
  origin: TerminalInputOrigin;
  text?: string;
  image?: { id: string; data: string; done: (sent: boolean) => void };
};

type InputBatch = {
  items: InputItem[];
  /**
   * Input from frames sealed but then not sent (the tab's rules changed while it was being
   * encrypted), in the order it was made. It goes out ahead of `items`.
   */
  returned: InputItem[];
  /** A gateway step for this batch is queued on the send chain; it takes the batch when it runs. */
  draining: boolean;
  /** Bytes in `items`. */
  size: number;
  lastSentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
};

export type TerminalTab = {
  localId: string;
  terminalId: string | null;
  cliDeviceId: string;
  /** This tab's own fitted size. */
  cols: number;
  rows: number;
  phase: "opening" | "live" | "rejected" | "exited";
  /**
   * The interactive runtime step whose operator terminal this tab attached to
   * (`runtimes.steps.attach`), or null for a shell. An operator terminal ends
   * with its command; it is cancelled by its step, never by End session.
   */
  stepId: string | null;
  /** How the terminal's process ended, from the relay's exit message. */
  exitCode: number | null;
  exitSignal: string | null;
  approvalCode: string | null;
  rejectionReason: string | null;
  error: string | null;
  viewerId: string | null;
  writer: TerminalWriterLabel;
  viewerCount: number;
  /** The PTY size the CLI reported, or null before the first report. */
  ptyCols: number | null;
  ptyRows: number | null;
  /** This tab asked the CLI to spawn the terminal and it has not gone live yet. */
  opener: boolean;
  /**
   * End session on this tab:
   * - `pending`: pressed, and the relay has not yet said the terminal ended
   *   (its `closed` answer, the exit, or a list without it). The close is
   *   sent again on the next socket if this one closes first. The tab stays
   *   until then, so it never looks ended while the shell still runs.
   * - `failed`: the relay refused the close for a reason a retry on its own
   *   would not fix. The terminal may still run; End session can be pressed
   *   again.
   */
  ending: "pending" | "failed" | null;
};

/**
 * Output for a pane, in CLI order: bytes, and PTY size changes. `replay` marks scrollback the CLI
 * sent this viewer alone on join (unicast data); live output is broadcast. `attach` is the attach
 * it arrived on: a pane drops output from an attach older than one it has already seen.
 */
export type TerminalOutputEvent = (
  | { kind: "data"; data: Uint8Array; replay: boolean; attach: number }
  | { kind: "size"; cols: number; rows: number; attach: number }
) & {
  /**
   * Set on delivery: its attach has ended (detach, exit, rejection...). It is shown, but it can
   * never reopen copy-out, however late it arrives or whenever the pane subscribes.
   */
  retired?: boolean;
};

type PendingHandshake = {
  localId: string;
  terminalId: string;
  /** Server-minted viewer id, from `opening` / `attaching`. */
  viewerId: string | null;
  privateKey: CryptoKey;
  browserPublicRaw: Uint8Array;
  browserNonce: Uint8Array;
  /** 2.5: the ECDH key the pinned identity signed. The CLI must answer with it. */
  expectedCliPublicKey: string;
  /** The handshake went out without a browser identity (it had not loaded). */
  withoutIdentity: boolean;
};

type HandshakeInput = {
  localId: string;
  cliDeviceId: string;
  terminalId: string;
  cols: number;
  rows: number;
  mode: "open" | "attach";
};

type OutputKeyState = {
  epoch: number;
  key: CryptoKey;
  recvSeq: bigint;
};

/**
 * One attach of a tab to its terminal: its keys and cursors, and everything that belongs to
 * this connection alone. Ending it (`retireAttachment`) is the one place an attach stops: its
 * queued input is settled, nothing more of it is sent, and its pane is told. Every way an attach
 * ends (detach, exit, gone, rejection, End session, tab close, disconnect, a replacement)
 * goes through there.
 */
type LiveSession = {
  /** Which attach this is (increasing per page): output carries it, so a pane can drop stale output. */
  attach: number;
  /** Ended: it sends nothing more, and its queued input has been settled. */
  ended: boolean;
  /**
   * Its frame queue. Every frame it sends (input, resize, image controls) is numbered, sealed and
   * sent in a step here, so sequence numbers reach the socket in increasing order.
   */
  queue: Promise<void>;
  /** Input waiting to be sent on this attach (it never moves to another attach). */
  batch: InputBatch;
  /** The size last sent on this attach (a new attach sends its size again). */
  lastSentSize: TerminalSize | null;
  images: TerminalImageTransfer;
  localId: string;
  terminalId: string;
  viewerId: string;
  browserToCli: CryptoKey;
  cliToBrowser: CryptoKey;
  sendSeq: bigint;
  /** Unicast (pairwise) receive cursor. */
  recvSeq: bigint;
  /** The shared output key and its own receive cursor. */
  output: OutputKeyState | null;
  /** Broadcast frames for an epoch whose key has not arrived yet. */
  future: SealedTerminalFrame[];
};

/**
 * A terminal this page asked the relay to end, until the relay says it did.
 * Owned here, not by the socket: a queued `close` dies with its socket, so the
 * intent outlives it and is sent again on the next one.
 */
type CloseIntent = {
  /** Request id of the close out on the current socket; null: none is out. */
  requestId: string | null;
  /** The tab showing `ending`, or null when no tab waits for it. */
  localId: string | null;
  /**
   * `listSeqRef` when this page learned of the terminal (or, if unknown, when
   * the intent began). A list requested after it that omits the terminal
   * proves the terminal is gone.
   */
  since: number;
  /** Sends it again after the socket's queue was full or the relay was busy. */
  retry: ReturnType<typeof setTimeout> | null;
};

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function newId(prefix: string): string {
  return `${prefix}_${bytesToBase64Url(crypto.getRandomValues(new Uint8Array(12)))}`;
}

function patchTab(
  tabs: TerminalTab[],
  localId: string,
  patch: Partial<TerminalTab>,
): TerminalTab[] {
  let changed = false;
  const next = tabs.map((tab) => {
    if (tab.localId !== localId) return tab;
    for (const [key, value] of Object.entries(patch)) {
      if (tab[key as keyof TerminalTab] !== value) {
        changed = true;
        break;
      }
    }
    return changed ? { ...tab, ...patch } : tab;
  });
  return changed ? next : tabs;
}

/** A step's operator-terminal tab lost its attachment: attach again from the step. */
export const STEP_DETACHED = "step_detached";

function newTab(input: {
  localId: string;
  terminalId: string | null;
  cliDeviceId: string;
  cols: number;
  rows: number;
  opener: boolean;
  viewerCount: number;
  stepId?: string | null;
}): TerminalTab {
  return {
    ...input,
    stepId: input.stepId ?? null,
    exitCode: null,
    exitSignal: null,
    phase: "opening",
    approvalCode: null,
    rejectionReason: null,
    error: null,
    viewerId: null,
    // The opener is the first writer. An attaching tab follows until told.
    writer: input.opener ? "you" : "none",
    ptyCols: null,
    ptyRows: null,
    ending: null,
  };
}

/** A terminal ticket to open, for the node `cliDeviceId` names. */
export type OpenTicketInput = {
  cliDeviceId: string;
  ticket: string;
  /** Typed into the shell once it shows output; never with a newline. */
  typedCommand?: string;
  /** An attach ticket for this interactive step's operator terminal. */
  stepId?: string;
};

export type UseTerminalSessionsOptions = {
  /** Pinned CLI identity keys. Defaults to IndexedDB. */
  pinStore?: CliPinStore;
  /**
   * Connect to the relay. Connecting attaches every listed terminal, taking a
   * viewer slot on each, so wait until terminals are actually wanted.
   * Defaults to true.
   */
  enabled?: boolean;
};

export function useTerminalSessions(options: UseTerminalSessionsOptions = {}): {
  status: TerminalSocketStatus;
  identityReady: boolean;
  /** CLIs from the relay's list, in its order. */
  clis: ListedCli[];
  /** Identity trust per `cliDeviceId`; missing while it is being checked. */
  cliTrust: Record<string, CliTrust>;
  /**
   * After an in-page confirmation: pin the identity key in `expected`, the
   * `changed` state the dialog showed. Resolves false when the listed identity
   * no longer matches it; nothing is pinned and the new state is published.
   */
  trustNewKey: (cliDeviceId: string, expected: ChangedCliTrust) => Promise<boolean>;
  tabs: TerminalTab[];
  activeLocalId: string | null;
  selectTab: (localId: string) => void;
  /**
   * The tab in Select text mode, or null. Only the active tab can be; switching or closing tabs
   * ends the mode. Its input is paused where all input passes: keys, pastes, image pastes,
   * mouse reports, xterm's replies and a ticket's typed command all wait or are dropped.
   */
  selectingLocalId: string | null;
  setSelecting: (localId: string | null) => void;
  /** The live session a tab's input goes to (compared by identity), or null. */
  currentSession: (localId: string) => unknown;
  /**
   * Open a terminal from a ticket (`nodes.terminals.openTicket` / `nodes.queued.run`). Refreshes
   * the CLI list first, so a node that just came online can open. `typedCommand` is typed into
   * the shell once it shows output, without a newline: the person presses Enter.
   */
  openTicket: (input: OpenTicketInput) => void;
  /** Ask the relay for the current CLI list; resolves when it arrives (or times out). */
  refreshClis: () => Promise<void>;
  /** X button: stop viewing. The shell keeps running for other viewers. */
  detachTab: (localId: string) => void;
  /** End session: close the shell for everyone. */
  endSession: (localId: string) => void;
  /**
   * Receive a tab's output. `reset` runs before a new attach's replay; `retire` runs as soon as
   * the tab's session ends (detach, disconnect), before any replacement attaches.
   */
  subscribeOutput: (
    localId: string,
    listener: (event: TerminalOutputEvent) => void,
    reset?: () => void,
    retire?: () => void,
  ) => () => void;
  /**
   * Queue input for a tab: a string is UTF-8, bytes are sent as they are (xterm's binary mouse
   * reports). The origin decides what the send-time gateway allows; it defaults to `user`.
   */
  sendInput: (localId: string, data: string | Uint8Array, origin?: TerminalInputOrigin) => void;
  uploadImage: (
    localId: string,
    file: File,
    progress: (percent: number) => void,
  ) => Promise<TerminalImageAttachment>;
  pasteImage: (localId: string, id: string, data: string) => Promise<boolean>;
  sendResize: (localId: string, cols: number, rows: number) => void;
  /**
   * The tab's box has no measurable size now (hidden, or zero-size): drop any resize scheduled
   * from an earlier size, and take no size from it until it reports one again.
   */
  sizeUnavailable: (localId: string) => void;
} {
  const identity = useTerminalIdentity();
  const pinStore = options.pinStore ?? indexedDbCliPinStore;
  const pinStoreRef = useRef(pinStore);
  const [clis, setClis] = useState<ListedCli[]>([]);
  const [cliTrust, setCliTrust] = useState<Record<string, CliTrust>>({});
  const cliListRef = useRef(new Map<string, ListedCli>());
  const cliTrustRef = useRef(new Map<string, CliTrust>());
  const trustRef = useRef(new Map<string, { key: string; promise: Promise<CliTrust> }>());
  const [listReady] = useState<Deferred>(deferred);
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeLocalId, setActiveLocalIdState] = useState<string | null>(null);
  const [selectingLocalId, setSelectingLocalIdState] = useState<string | null>(null);
  /** Select text's tab, updated synchronously: input checks it before the render. */
  const selectingRef = useRef<string | null>(null);
  /**
   * Tabs as of the last commit. Handlers that add or remove tabs also write it
   * at once, so later messages in the same tick see the change.
   */
  const tabsRef = useRef(tabs);
  const activeRef = useRef(activeLocalId);
  /** A new active tab (or none) always ends Select text, wherever the switch came from. */
  /** Resumes a tab's held input once its Select text ends (set once the handlers exist). */
  const resumeInputRef = useRef<(localId: string) => void>(() => undefined);
  /**
   * The one Select text transition. Every way the mode ends (Done, the toolbar, switching or
   * closing tabs) goes through here, so held input always resumes.
   */
  const changeSelecting = useCallback((next: string | null) => {
    const previous = selectingRef.current;
    if (previous === next) return;
    selectingRef.current = next;
    setSelectingLocalIdState(next);
    if (previous !== null) resumeInputRef.current(previous);
  }, []);
  /** A new active tab (or none) always ends Select text, wherever the switch came from. */
  const setActiveLocalId = useCallback(
    (localId: string | null) => {
      activeRef.current = localId;
      setActiveLocalIdState(localId);
      if (selectingRef.current !== null && selectingRef.current !== localId) changeSelecting(null);
      // Input or a ticket's command waiting for this tab to be shown can go now.
      if (localId !== null) resumeInputRef.current(localId);
    },
    [changeSelecting],
  );
  const cliKeysRef = useRef(new Map<string, string | null>());
  /** Writer state per tab, updated synchronously ahead of the render. */
  const viewRef = useRef(new Map<string, TerminalWriterState>());
  const ownSizeRef = useRef(new Map<string, TerminalSize>());
  const resizeTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const reattachRef = useRef(new Map<string, ReattachState>());
  const reattachTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingRef = useRef(new Map<string, PendingHandshake>());
  const sessionsRef = useRef(new Map<string, LiveSession>());
  const attachingRef = useRef(new Set<string>());
  const listenersRef = useRef(new Map<string, (event: TerminalOutputEvent) => void>());
  const resettersRef = useRef(new Map<string, () => void>());
  /** Per pane: its session just ended (detach, disconnect), before any replacement attaches. */
  const retireRef = useRef(new Map<string, () => void>());
  /** Per tab: the newest attach that has ended. Its output is delivered marked `retired`. */
  const retiredThroughRef = useRef(new Map<string, number>());
  /** `endAttachment`, for the handlers defined before it. */
  const endAttachmentRef = useRef<(terminalId: string, dropOutput?: boolean) => void>(
    () => undefined,
  );
  /** The last attach number given out (see LiveSession.attach). */
  const attachCounterRef = useRef(0);
  const buffersRef = useRef(new Map<string, TerminalOutputEvent[]>());
  const pendingResizeRef = useRef(new Map<string, TerminalSize>());
  const sendRef = useRef<(message: TerminalClientMessage) => TerminalSendResult>(() => "closed");
  const frameRef = useRef<(frame: ArrayBuffer) => boolean>(() => false);
  /** `failOpening`, for the handshake code defined before it. */
  const failOpeningRef = useRef<(localId: string, reason: string) => void>(() => undefined);
  const signRef = useRef(identity.sign);
  const publicKeyRef = useRef(identity.publicKey);
  const readyRef = useRef(identity.ready);
  // Mirror the committed render into the refs the callbacks read. A layout
  // effect runs before passive effects (the socket connects in one) and
  // before the browser paints, so no handler sees an older value.
  useLayoutEffect(() => {
    pinStoreRef.current = pinStore;
    tabsRef.current = tabs;
    activeRef.current = activeLocalId;
    signRef.current = identity.sign;
    publicKeyRef.current = identity.publicKey;
    readyRef.current = identity.ready;
  }, [pinStore, tabs, activeLocalId, identity.sign, identity.publicKey, identity.ready]);
  /**
   * Bumped on every socket connect and disconnect. An async continuation that
   * started on an earlier connection must not write session state.
   */
  const generationRef = useRef(0);
  /** Tabs whose handshake waits for the browser identity to load. */
  const awaitingIdentityRef = useRef(new Set<string>());
  /**
   * localId -> the ticket its `open` redeems. Gone once the relay answered the open (`opening`
   * or a refusal it read): a ticket opens one terminal, so a used one is never sent again.
   */
  const ticketsRef = useRef(new Map<string, string>());
  /** localId -> a command to type (no newline) once the tab's shell shows output. */
  const typedCommandsRef = useRef(new Map<string, string>());
  /** localId -> the quiet-period timer before its command is typed. */
  const typedTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** `sendInput`, for the output path defined before it. */
  const sendInputRef = useRef<
    (localId: string, data: string | Uint8Array, origin?: TerminalInputOrigin) => void
  >(() => undefined);
  /** `flushInput`, for the Select text transition defined before it. */
  const flushInputRef = useRef<(localId: string) => void>(() => undefined);
  /** Tabs whose box last reported a measurable size (see `sizeUnavailable`). */
  const measurableRef = useRef(new Set<string>());
  /** `open` frames not yet answered by `opening`, in the order sent. */
  const inflightOpensRef = useRef<{ localId: string; requestId: string }[]>([]);
  /**
   * terminalId -> an End session (or an internal close of a shell no tab
   * shows) the relay has not confirmed. See `CloseIntent`.
   */
  const closesRef = useRef(new Map<string, CloseIntent>());
  /**
   * Opens closed locally while their `open` still waits for `opening`. The ack
   * names the terminal the relay made, so it is closed as soon as it arrives.
   */
  const closedOpensRef = useRef(new Set<string>());
  const resetBeforeOutputRef = useRef(new Set<string>());
  const earlySealedRef = useRef(new Map<string, SealedTerminalFrame[]>());
  const recvChainRef = useRef(new Map<string, Promise<void>>());
  const acceptSealedRef = useRef<(frame: SealedTerminalFrame) => void>(() => undefined);
  /**
   * localId -> the handshake whose keys are being derived. Anything that ends
   * the tab's session meanwhile (exit, refusal, detach, close) removes it, so
   * the derived keys never bring the tab back.
   */
  const establishingRef = useRef(new Map<string, PendingHandshake>());
  const droppedNoticeRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** Number of `list` requests sent so far; each request takes the next number. */
  const listSeqRef = useRef(0);
  /** `list` requests on this socket whose `terminals` answer has not arrived. */
  const listRequestsRef = useRef<number[]>([]);
  /**
   * Terminals this page stopped viewing with X. Their shells keep running, so
   * every later list names them; they must not come back as tabs (and take a
   * viewer slot) until the page reloads.
   */
  const detachedRef = useRef(new Set<string>());
  /** Callers of `refreshClis` waiting for the next terminal and CLI list. */
  const listWaitersRef = useRef<(() => void)[]>([]);
  /**
   * terminalId -> `listSeqRef` when this page learned it. A list answers for a
   * terminal only when the terminal was known before that list was requested;
   * one the relay registered later may be missing from it.
   */
  const knownSinceRef = useRef(new Map<string, number>());

  const viewOf = useCallback((localId: string): TerminalWriterState => {
    return viewRef.current.get(localId) ?? { writer: "you" };
  }, []);

  const setView = useCallback(
    (localId: string, patch: Partial<TerminalWriterState>, extra?: Partial<TerminalTab>) => {
      const next = { ...viewOf(localId), ...patch };
      viewRef.current.set(localId, next);
      setTabs((current) => patchTab(current, localId, { ...next, ...extra }));
    },
    [viewOf],
  );

  /** Patch a tab and the ref at once, so async work in this tick sees it. */
  const patchTabNow = useCallback((localId: string, patch: Partial<TerminalTab>) => {
    tabsRef.current = patchTab(tabsRef.current, localId, patch);
    setTabs((current) => patchTab(current, localId, patch));
  }, []);

  const tabByTerminal = useCallback(
    (terminalId: string) => tabsRef.current.find((tab) => tab.terminalId === terminalId),
    [],
  );

  const clearTimer = useCallback(
    (timers: Map<string, ReturnType<typeof setTimeout>>, localId: string) => {
      const timer = timers.get(localId);
      if (timer) clearTimeout(timer);
      timers.delete(localId);
    },
    [],
  );

  /** Call right before a `list` request goes out on the current socket. */
  const noteListRequest = useCallback(() => {
    listSeqRef.current += 1;
    listRequestsRef.current.push(listSeqRef.current);
  }, []);

  /** Ask for a fresh list on the current socket (no-op while it is closed). */
  const requestList = useCallback(() => {
    noteListRequest();
    if (!sendTaken(sendRef.current({ type: "list" }))) listRequestsRef.current.pop();
  }, [noteListRequest]);

  const removeTab = useCallback(
    (tab: TerminalTab) => {
      const localId = tab.localId;
      if (!tab.terminalId && inflightOpensRef.current.some((open) => open.localId === localId)) {
        closedOpensRef.current.add(localId);
      }
      pendingRef.current.delete(localId);
      establishingRef.current.delete(localId);
      ticketsRef.current.delete(localId);
      typedCommandsRef.current.delete(localId);
      clearTimer(typedTimersRef.current, localId);
      if (tab.terminalId) {
        // A close still owed for it goes on without the tab.
        const intent = closesRef.current.get(tab.terminalId);
        if (intent?.localId === localId) intent.localId = null;
        endAttachmentRef.current(tab.terminalId);
        pendingRef.current.delete(tab.terminalId);
        attachingRef.current.delete(tab.terminalId);
        earlySealedRef.current.delete(tab.terminalId);
        knownSinceRef.current.delete(tab.terminalId);
      }
      // Ending the attach may hand a typed command back to the tab: the tab is going, so drop it.
      typedCommandsRef.current.delete(localId);
      clearTimer(typedTimersRef.current, localId);
      buffersRef.current.delete(localId);
      listenersRef.current.delete(localId);
      resettersRef.current.delete(localId);
      retireRef.current.delete(localId);
      retiredThroughRef.current.delete(localId);
      clearTimer(droppedNoticeRef.current, localId);
      clearTimer(resizeTimersRef.current, localId);
      clearTimer(reattachTimersRef.current, localId);
      reattachRef.current.delete(localId);
      viewRef.current.delete(localId);
      ownSizeRef.current.delete(localId);
      pendingResizeRef.current.delete(localId);
      const remaining = tabsRef.current.filter((item) => item.localId !== localId);
      tabsRef.current = remaining;
      setTabs((current) => current.filter((item) => item.localId !== localId));
      if (activeRef.current === localId) {
        setActiveLocalId(remaining[remaining.length - 1]?.localId ?? null);
      }
      measurableRef.current.delete(localId);
      if (selectingRef.current === localId) changeSelecting(null);
    },
    [changeSelecting, clearTimer, setActiveLocalId],
  );

  /** Send a close intent's frame on the current socket (see `sendCloseIntent`). */
  const sendClose = useCallback((terminalId: string) => {
    sendCloseIntent(closesRef.current, sendRef, terminalId);
  }, []);

  /**
   * Ask the relay to end a terminal, and keep asking (across reconnects)
   * until it says it did. `localId`: the tab to remove once it has; null when
   * no tab shows this terminal any more (the tab stays gone either way).
   */
  const requestClose = useCallback(
    (terminalId: string, localId: string | null) => {
      const existing = closesRef.current.get(terminalId);
      if (existing) {
        if (localId) existing.localId = localId;
        if (existing.requestId === null && existing.retry === null) sendClose(terminalId);
        return;
      }
      closesRef.current.set(terminalId, {
        requestId: null,
        localId,
        // Known since then, so any list asked for later names it while it runs.
        since: knownSinceRef.current.get(terminalId) ?? listSeqRef.current,
        retry: null,
      });
      sendClose(terminalId);
    },
    [sendClose],
  );

  /** The relay ended the terminal (or has none by that id): the intent is done. */
  const finishClose = useCallback(
    (terminalId: string) => {
      const intent = closesRef.current.get(terminalId);
      if (!intent) return;
      if (intent.retry) clearTimeout(intent.retry);
      closesRef.current.delete(terminalId);
      const tab = intent.localId
        ? tabsRef.current.find((item) => item.localId === intent.localId)
        : undefined;
      if (tab) removeTab(tab);
    },
    [removeTab],
  );

  /**
   * The relay refused the close for good. Show it: on the tab that asked, or
   * on the tab still naming the terminal; with none, a fresh list brings the
   * still-running terminal back as a tab instead of leaving it unseen.
   */
  const failClose = useCallback(
    (terminalId: string) => {
      const intent = closesRef.current.get(terminalId);
      if (!intent) return;
      if (intent.retry) clearTimeout(intent.retry);
      closesRef.current.delete(terminalId);
      const tab =
        (intent.localId
          ? tabsRef.current.find((item) => item.localId === intent.localId)
          : undefined) ?? tabByTerminal(terminalId);
      if (tab) patchTabNow(tab.localId, { ending: "failed" });
      else requestList();
    },
    [patchTabNow, requestList, tabByTerminal],
  );

  const noteTerminalKnown = useCallback((terminalId: string) => {
    if (!knownSinceRef.current.has(terminalId)) {
      knownSinceRef.current.set(terminalId, listSeqRef.current);
    }
  }, []);

  /** Type a ticket's command once the shell's output settles (the prompt). */
  /** The tab's attach that can still send: live, not exited or ending, not ended. */
  const liveSessionOf = useCallback((localId: string): LiveSession | null => {
    const tab = tabsRef.current.find((item) => item.localId === localId);
    if (!tab?.terminalId || tab.phase === "exited" || tab.ending === "pending") return null;
    const session = sessionsRef.current.get(tab.terminalId);
    return session && !session.ended ? session : null;
  }, []);

  const scheduleTypedCommand = useCallback(
    (localId: string) => {
      if (!typedCommandsRef.current.has(localId)) return;
      const timers = typedTimersRef.current;
      const previous = timers.get(localId);
      if (previous) clearTimeout(previous);
      timers.set(
        localId,
        setTimeout(() => {
          timers.delete(localId);
          const typed = typedCommandsRef.current.get(localId);
          // Not live now (the socket dropped): wait for output after the reattach.
          if (typed === undefined || !liveSessionOf(localId)) return;
          // Select text pauses input: the command waits until the mode ends.
          if (selectingRef.current === localId) return;
          // Typing it as a follower takes over, which needs the visible, measured tab: it waits
          // until the tab is shown and measured (sendResize schedules it again).
          const following = needsTakeover(viewRef.current.get(localId) ?? { writer: "you" });
          if (following && !(activeRef.current === localId && measurableRef.current.has(localId)))
            return;
          typedCommandsRef.current.delete(localId);
          sendInputRef.current(localId, typed, "typed");
        }, TYPED_COMMAND_QUIET_MS),
      );
    },
    [liveSessionOf],
  );

  /** Output as delivered to a pane: marked `retired` when its attach has ended. */
  const delivered = useCallback(
    (localId: string, event: TerminalOutputEvent): TerminalOutputEvent => {
      const through = retiredThroughRef.current.get(localId);
      return through !== undefined && event.attach <= through ? { ...event, retired: true } : event;
    },
    [],
  );

  const emitOutput = useCallback(
    (localId: string, event: TerminalOutputEvent) => {
      // A frame that was mid-decryption when its tab closed has nowhere to go.
      if (!tabsRef.current.some((tab) => tab.localId === localId)) return;
      if (event.kind === "data") scheduleTypedCommand(localId);
      const listener = listenersRef.current.get(localId);
      if (listener) {
        if (resetBeforeOutputRef.current.delete(localId)) resettersRef.current.get(localId)?.();
        listener(delivered(localId, event));
        return;
      }
      const queued = buffersRef.current.get(localId) ?? [];
      queued.push(event);
      if (queued.length > OUTPUT_BUFFER_EVENTS) queued.shift();
      buffersRef.current.set(localId, queued);
    },
    [delivered, scheduleTypedCommand],
  );

  const applyPtySize = useCallback(
    (localId: string, cols: number, rows: number, attach: number) => {
      if (cols < 1 || rows < 1) return;
      setTabs((current) => patchTab(current, localId, { ptyCols: cols, ptyRows: rows }));
      emitOutput(localId, { kind: "size", cols, rows, attach });
    },
    [emitOutput],
  );

  /**
   * Run a step on an attach's frame queue, in order. A step for an attach that has ended by the
   * time its turn comes does not run; `onSkip` runs instead.
   */
  const runOnQueue = useCallback(
    (session: LiveSession, step: () => Promise<void>, onSkip?: () => void) => {
      session.queue = session.queue
        .catch(() => undefined)
        .then(() => (session.ended ? onSkip?.() : step()))
        .catch(() => onSkip?.());
    },
    [],
  );

  /**
   * Number, seal and send frames from inside a queue step. Numbers are taken here, in queue
   * order, so they reach the socket in increasing order. `stillAllowed` is checked after sealing,
   * right before the send; refused (or the attach ended meanwhile), nothing is sent and the result
   * is null. The CLI accepts any later sequence number, so a skipped one is never reused.
   * Otherwise each frame's socket result (a send that throws counts as not sent).
   */
  const sealAndSend = useCallback(
    async (
      session: LiveSession,
      plaintexts: readonly Uint8Array[],
      stillAllowed: () => boolean,
    ): Promise<boolean[] | null> => {
      const numbered = plaintexts.map((plaintext) => {
        session.sendSeq += 1n;
        return { plaintext, seq: session.sendSeq };
      });
      const frames = await Promise.all(
        numbered.map(async ({ plaintext, seq }) => {
          const body = await sealTerminalBytesV2({
            key: session.browserToCli,
            terminalId: session.terminalId,
            viewerId: session.viewerId,
            direction: DIRECTION_BROWSER_TO_CLI,
            seq,
            plaintext,
          });
          return encodeSealedFrame({ terminalId: session.terminalId, seq: Number(seq), body });
        }),
      );
      if (session.ended || sessionsRef.current.get(session.terminalId) !== session) return null;
      if (!stillAllowed()) return null;
      return frames.map((frame) => {
        try {
          return frameRef.current(frame);
        } catch {
          return false;
        }
      });
    },
    [],
  );

  /** Send one frame on an attach's queue; resolves with whether it reached the socket. */
  const sendOnQueue = useCallback(
    (session: LiveSession, plaintext: Uint8Array, stillAllowed: () => boolean = () => true) =>
      new Promise<boolean>((resolve) => {
        runOnQueue(
          session,
          async () => {
            const sent = await sealAndSend(session, [plaintext], stillAllowed);
            resolve(sent?.[0] ?? false);
          },
          () => resolve(false),
        );
      }),
    [runOnQueue, sealAndSend],
  );

  /** Whether this tab may send input as the writer right now. */
  const mayWrite = useCallback(
    (localId: string) => selectingRef.current !== localId && !needsTakeover(viewOf(localId)),
    [viewOf],
  );

  /** The visible tab with a measured box: the only one that can give the PTY its size. */
  const canTakeOver = useCallback(
    (localId: string) =>
      activeRef.current === localId &&
      measurableRef.current.has(localId) &&
      ownSizeRef.current.has(localId),
    [],
  );

  /**
   * Input that could not go out: a ticket's typed command waits for its tab again (typed once the
   * output settles, or the tab is shown and measured), an image paste reports failure, anything
   * else is dropped. A tab being ended or closed keeps no command.
   */
  const settleUnsent = useCallback(
    (localId: string, items: readonly InputItem[]) => {
      const tab = tabsRef.current.find((item) => item.localId === localId);
      let restored = false;
      for (const item of items) {
        item.image?.done(false);
        if (
          item.origin === "typed" &&
          item.text !== undefined &&
          tab &&
          tab.ending !== "pending" &&
          !typedCommandsRef.current.has(localId)
        ) {
          typedCommandsRef.current.set(localId, item.text);
          restored = true;
        }
      }
      if (restored) scheduleTypedCommand(localId);
    },
    [scheduleTypedCommand],
  );

  /**
   * End an attach: the one place every way of ending goes through. Nothing more of it is sent,
   * its queued input is settled, and its pane is told at once (before any replacement attaches)
   * so it retires its copy bar and copy authorization. Its output keeps arriving marked `retired`
   * (an exit drains what the shell sent first); `dropOutput` also drops output buffered for a
   * pane not yet subscribed, which the next attach's replay redraws.
   */
  const retireAttachment = useCallback(
    (session: LiveSession, dropOutput: boolean) => {
      if (session.ended) return;
      session.ended = true;
      const localId = session.localId;
      const batch = session.batch;
      if (batch.timer) clearTimeout(batch.timer);
      batch.timer = null;
      const unsent = [...batch.returned, ...batch.items];
      batch.returned = [];
      batch.items = [];
      batch.size = 0;
      settleUnsent(localId, unsent);
      session.images.abort();
      clearTimer(resizeTimersRef.current, localId);
      const through = retiredThroughRef.current.get(localId) ?? 0;
      if (session.attach > through) retiredThroughRef.current.set(localId, session.attach);
      if (dropOutput) buffersRef.current.delete(localId);
      retireRef.current.get(localId)?.();
    },
    [clearTimer, settleUnsent],
  );

  /** End and forget the attach of a terminal (see retireAttachment). */
  const endAttachment = useCallback(
    (terminalId: string, dropOutput = true) => {
      const session = sessionsRef.current.get(terminalId);
      if (!session) return;
      retireAttachment(session, dropOutput);
      sessionsRef.current.delete(terminalId);
    },
    [retireAttachment],
  );
  useLayoutEffect(() => {
    endAttachmentRef.current = endAttachment;
  }, [endAttachment]);

  /**
   * One step of the input gateway, run on the attach's queue when its turn comes. It takes the
   * batch then (so nothing later can be sealed ahead of it), decides by the tab's rules at that
   * moment, seals, checks the rules again, and only then sends. Taking over is part of the step:
   * the writer becomes "you" only once its resize and first input actually reached the socket.
   * - Select text: input waits; replies are dropped (they answer output that has moved on).
   * - Replies go out only from the writer, in their own frames: they never claim the writer.
   * - Input from a follower takes over first, only from the visible, measured tab, at the size
   *   it measured (a newer measurement rebuilds the step); otherwise user input is dropped and a
   *   typed command waits for the tab.
   * - Refused after sealing: the items go back to the front of the batch, in order.
   */
  const drainInput = useCallback(
    async (session: LiveSession) => {
      const localId = session.localId;
      const batch = session.batch;
      batch.draining = false;
      const items = [...batch.returned, ...batch.items];
      batch.returned = [];
      batch.items = [];
      batch.size = 0;
      if (items.length === 0) return;
      // Input waits in order; an image paste does not wait (Select text drops it).
      const hold = (held: readonly InputItem[]) => {
        settleUnsent(
          localId,
          held.filter((item) => item.image),
        );
        batch.returned.push(...held.filter((item) => !item.image && item.origin !== "reply"));
      };
      if (selectingRef.current === localId) {
        hold(items);
        return;
      }
      batch.lastSentAt = performance.now();
      const writer = !needsTakeover(viewOf(localId));
      const takeOver =
        !writer && items.some((item) => item.origin !== "reply") && canTakeOver(localId);
      const own = ownSizeRef.current.get(localId);
      const sending = items.filter((item) =>
        item.origin === "reply" ? writer : writer || takeOver,
      );
      const going = new Set(sending);
      settleUnsent(
        localId,
        items.filter((item) => !going.has(item) && item.origin !== "reply"),
      );
      if (sending.length === 0) return;
      // Frames in order: the takeover resize, then runs of input and replies, an image paste
      // always on its own.
      const frames: { plaintext: Uint8Array; items: InputItem[] }[] = [];
      if (takeOver && own)
        frames.push({ plaintext: encodeTerminalResize(own.cols, own.rows), items: [] });
      let run: InputItem[] = [];
      const endRun = () => {
        if (run.length === 0) return;
        frames.push({
          plaintext: encodeTerminalData(concatBytes(run.map((item) => item.bytes))),
          items: run,
        });
        run = [];
      };
      for (const item of sending) {
        if (item.image) {
          endRun();
          frames.push({
            plaintext: encodeTerminalImageControl(
              TERMINAL_IMAGE_PASTE,
              item.image.id,
              item.image.data,
            ),
            items: [item],
          });
          continue;
        }
        const previous = run[run.length - 1];
        if (previous && (previous.origin === "reply") !== (item.origin === "reply")) endRun();
        run.push(item);
      }
      endRun();
      let results: boolean[] | null;
      try {
        results = await sealAndSend(
          session,
          frames.map((frame) => frame.plaintext),
          () => {
            const tab = tabsRef.current.find((item) => item.localId === localId);
            if (!tab || tab.ending === "pending" || selectingRef.current === localId) return false;
            if (!takeOver) return mayWrite(localId);
            // Taking over: still a follower, still the visible measured tab, same measurement.
            return (
              needsTakeover(viewOf(localId)) &&
              canTakeOver(localId) &&
              sameSize(ownSizeRef.current.get(localId), own)
            );
          },
        );
      } catch {
        settleUnsent(localId, sending);
        return;
      }
      if (!results) {
        if (session.ended) {
          settleUnsent(localId, sending);
          return;
        }
        hold(sending);
        // Back through the gateway, which decides again as the rules now say (Select text
        // resumes held input itself when it ends).
        if (selectingRef.current !== localId && batch.returned.length > 0)
          batch.timer ??= setTimeout(() => flushInputRef.current(localId), 0);
        return;
      }
      // A takeover counts only once its resize and first input reached the socket.
      if (takeOver && own && results[0] === true && results[1] === true) {
        clearTimer(resizeTimersRef.current, localId);
        setView(localId, { writer: "you" });
        session.lastSentSize = own;
      }
      frames.forEach((frame, index) => {
        const sent = results?.[index] === true;
        if (sent) for (const item of frame.items) item.image?.done(true);
        else settleUnsent(localId, frame.items);
      });
    },
    [canTakeOver, clearTimer, mayWrite, sealAndSend, setView, settleUnsent, viewOf],
  );

  /** Queue a gateway step for the tab's batch on its attach's queue (one at a time). */
  const flushInput = useCallback(
    (localId: string) => {
      const session = liveSessionOf(localId);
      if (!session) return;
      const batch = session.batch;
      if (batch.timer) clearTimeout(batch.timer);
      batch.timer = null;
      if (batch.draining || (batch.items.length === 0 && batch.returned.length === 0)) return;
      batch.draining = true;
      runOnQueue(
        session,
        () => drainInput(session),
        () => {
          batch.draining = false;
        },
      );
    },
    [drainInput, liveSessionOf, runOnQueue],
  );
  useLayoutEffect(() => {
    flushInputRef.current = flushInput;
  }, [flushInput]);

  /**
   * Send this tab's own size, if it is allowed to and it changed, as a step on its attach's queue
   * behind any input made before it. Decided and checked again when its turn comes; recorded as
   * sent only when it reached the socket.
   */
  const flushResize = useCallback(
    (localId: string) => {
      clearTimer(resizeTimersRef.current, localId);
      const session = liveSessionOf(localId);
      if (!session) {
        // Not attached: the size goes with the next attach.
        const own = ownSizeRef.current.get(localId);
        if (own) pendingResizeRef.current.set(localId, own);
        return;
      }
      // Keep typed input ahead of the resize, in the order the user made them.
      flushInput(localId);
      const allowed = (own: TerminalSize) =>
        activeRef.current === localId &&
        measurableRef.current.has(localId) &&
        canSendResize(viewOf(localId)) &&
        sameSize(ownSizeRef.current.get(localId), own);
      runOnQueue(session, async () => {
        const own = ownSizeRef.current.get(localId);
        if (!own || sameSize(own, session.lastSentSize) || !allowed(own)) return;
        const sent = await sealAndSend(session, [encodeTerminalResize(own.cols, own.rows)], () =>
          allowed(own),
        );
        if (sent?.[0] === true) session.lastSentSize = own;
      });
    },
    [clearTimer, flushInput, liveSessionOf, runOnQueue, sealAndSend, viewOf],
  );

  const publishTrust = useCallback((cliDeviceId: string, trust: CliTrust) => {
    cliTrustRef.current.set(cliDeviceId, trust);
    setCliTrust((current) =>
      current[cliDeviceId] === trust ? current : { ...current, [cliDeviceId]: trust },
    );
  }, []);

  /** Verify the CLI identity for the listed terminal key, once per list entry. */
  const ensureTrust = useCallback(
    async (cliDeviceId: string): Promise<CliTrust> => {
      await listReady.promise;
      const cli = cliListRef.current.get(cliDeviceId);
      if (!cli) return { status: "offline" };
      const key = cliTrustInputKey(cli);
      const cached = trustRef.current.get(cliDeviceId);
      if (cached && cached.key === key) return cached.promise;
      const promise = evaluateCliTrust(cli, pinStoreRef.current).catch(
        (): CliTrust => ({ status: "invalid" }),
      );
      trustRef.current.set(cliDeviceId, { key, promise });
      const trust = await promise;
      if (trustRef.current.get(cliDeviceId)?.promise === promise) {
        publishTrust(cliDeviceId, trust);
      }
      return trust;
    },
    [listReady, publishTrust],
  );

  /** Refuse a tab before any handshake message goes out. */
  const refuseTab = useCallback(
    (localId: string, reason: string) => {
      patchTabNow(localId, {
        phase: "rejected",
        approvalCode: null,
        rejectionReason: reason,
        error: null,
      });
    },
    [patchTabNow],
  );

  /**
   * End a session once every frame already on its receive chain is decrypted
   * and delivered. The shell has exited, but output it sent first still counts.
   */
  const retireAfterDrain = useCallback(
    (terminalId: string, session: LiveSession) => {
      // Ended now (nothing more is sent, the pane is told); output it sent first still arrives,
      // marked retired, until the receive chain drains.
      retireAttachment(session, false);
      const previous = recvChainRef.current.get(terminalId) ?? Promise.resolve();
      const run: Promise<void> = previous
        .catch(() => undefined)
        .then(() => {
          if (sessionsRef.current.get(terminalId) === session)
            sessionsRef.current.delete(terminalId);
          // Drop the keys and any broadcast that never got its epoch key.
          session.output = null;
          session.future = [];
          earlySealedRef.current.delete(terminalId);
          if (recvChainRef.current.get(terminalId) === run) recvChainRef.current.delete(terminalId);
        });
      recvChainRef.current.set(terminalId, run);
    },
    [retireAttachment],
  );

  /**
   * The CLI answered with an ECDH key its pinned identity did not sign. Drop
   * the handshake, leave the terminal, and refresh the list: a CLI restart
   * lists a new signed key, a relay substitution does not.
   */
  const refuseSubstitutedKey = useCallback(
    (pending: PendingHandshake, terminalId: string) => {
      attachingRef.current.delete(terminalId);
      const tab = tabsRef.current.find((item) => item.localId === pending.localId);
      // This page opened it and nobody can use it: end it, and keep at that
      // until the relay confirms (the tab shows the refusal meanwhile).
      if (tab?.opener) requestClose(terminalId, null);
      else sendRef.current({ type: "detach", terminalId });
      refuseTab(pending.localId, "identity_mismatch");
      requestList();
    },
    [refuseTab, requestClose, requestList],
  );

  const establish = useCallback(
    async (
      pending: PendingHandshake,
      message: {
        type: "opened" | "attached";
        terminalId: string;
        cliPublicKey: string;
        cliNonce: string;
      },
    ) => {
      const generation = generationRef.current;
      pendingRef.current.delete(pending.localId);
      if (pending.terminalId) pendingRef.current.delete(pending.terminalId);
      attachingRef.current.delete(message.terminalId);
      const viewerId = pending.viewerId;
      if (!viewerId) {
        setTabs((current) =>
          patchTab(current, pending.localId, { phase: "rejected", error: "bad_handshake" }),
        );
        return;
      }
      if (message.cliPublicKey !== pending.expectedCliPublicKey) {
        refuseSubstitutedKey(pending, message.terminalId);
        return;
      }
      establishingRef.current.set(pending.localId, pending);
      const cliPublicRaw = base64UrlToBytes(message.cliPublicKey);
      const shared = {
        browserPrivateKey: pending.privateKey,
        cliPublicKey: await importEcdhPublicRaw(cliPublicRaw),
        browserNonce: pending.browserNonce,
        cliNonce: base64UrlToBytes(message.cliNonce),
        terminalId: message.terminalId,
        cliPublicRaw,
        browserPublicRaw: pending.browserPublicRaw,
      };
      const keys = await deriveTerminalSessionKeysV2({ ...shared, viewerId });
      // The socket this handshake ran on is gone; its keys are obsolete. The
      // tab stays "opening", so the next connection attaches it again.
      if (generationRef.current !== generation) return;
      // A refusal, a detach, or the X button ended this handshake meanwhile.
      if (establishingRef.current.get(pending.localId) !== pending) return;
      establishingRef.current.delete(pending.localId);
      const tab = tabsRef.current.find((item) => item.localId === pending.localId);
      if (!tab || tab.phase === "rejected") {
        earlySealedRef.current.delete(message.terminalId);
        return;
      }
      attachCounterRef.current += 1;
      // A previous attach of this terminal still registered ends here, through the one path.
      endAttachment(message.terminalId);
      const session: LiveSession = {
        attach: attachCounterRef.current,
        ended: false,
        queue: Promise.resolve(),
        batch: {
          items: [],
          returned: [],
          draining: false,
          size: 0,
          lastSentAt: Number.NEGATIVE_INFINITY,
          timer: null,
        },
        lastSentSize: null,
        images: new TerminalImageTransfer(),
        localId: pending.localId,
        terminalId: message.terminalId,
        viewerId,
        browserToCli: keys.browserToCli,
        cliToBrowser: keys.cliToBrowser,
        sendSeq: 0n,
        recvSeq: 0n,
        output: null,
        future: [],
      };
      sessionsRef.current.set(message.terminalId, session);
      const early = earlySealedRef.current.get(message.terminalId) ?? [];
      earlySealedRef.current.delete(message.terminalId);
      for (const frame of early) acceptSealedRef.current(frame);
      // The shell exited while the keys were derived: deliver what it sent
      // before exiting, then end the session. The tab stays exited.
      if (tab.phase === "exited") {
        retireAfterDrain(message.terminalId, session);
        return;
      }
      reattachTimersRef.current.delete(pending.localId);
      const view = viewOf(pending.localId);
      const writer: TerminalWriterLabel =
        message.type === "opened" && view.writer === "none" ? "you" : view.writer;
      setView(
        pending.localId,
        { writer },
        {
          terminalId: message.terminalId,
          phase: "live",
          approvalCode: null,
          rejectionReason: null,
          error: null,
          opener: false,
          viewerId,
        },
      );
      const resize = pendingResizeRef.current.get(pending.localId);
      pendingResizeRef.current.delete(pending.localId);
      if (resize && !ownSizeRef.current.has(pending.localId)) {
        ownSizeRef.current.set(pending.localId, resize);
      }
      flushResize(pending.localId);
    },
    [flushResize, refuseSubstitutedKey, retireAfterDrain, setView, viewOf],
  );

  const beginHandshake = useCallback(
    async (input: HandshakeInput): Promise<void> => {
      const generation = generationRef.current;
      // The socket changed while this ran. A new socket restarts opens and
      // lists terminals to attach again, so this attempt just stops.
      const stale = () => generationRef.current !== generation;
      // Verify (and pin on first use) the CLI identity before any key leaves.
      const trust = await ensureTrust(input.cliDeviceId);
      if (stale()) return;
      if (!tabsRef.current.some((tab) => tab.localId === input.localId)) return;
      if (input.mode === "open" && !ticketsRef.current.has(input.localId)) {
        // Its ticket was used (the relay read the open): only a new ticket opens a terminal.
        refuseTab(input.localId, "ticket_invalid");
        return;
      }
      const gate = trustAllowsHandshake(trust);
      if (!gate.ok) {
        if (input.mode === "attach") attachingRef.current.delete(input.terminalId);
        refuseTab(input.localId, trustRejectionReason(trust));
        return;
      }
      const handshake = await generateEphemeralHandshake();
      if (stale()) return;
      if (!tabsRef.current.some((tab) => tab.localId === input.localId)) return;
      if (!readyRef.current) {
        // An approval-enabled CLI refuses a handshake without the browser
        // identity. Wait for it to load; the identity effect retries this tab.
        if (input.mode === "attach") attachingRef.current.delete(input.terminalId);
        awaitingIdentityRef.current.add(input.localId);
        return;
      }
      awaitingIdentityRef.current.delete(input.localId);
      const publicKey = publicKeyRef.current();
      const identity = publicKey ? { publicKey } : undefined;
      pendingRef.current.set(input.mode === "open" ? input.localId : input.terminalId, {
        localId: input.localId,
        terminalId: input.mode === "open" ? "" : input.terminalId,
        viewerId: null,
        privateKey: handshake.privateKey,
        browserPublicRaw: handshake.publicKeyRaw,
        browserNonce: handshake.nonce,
        expectedCliPublicKey: gate.expectedCliPublicKey,
        withoutIdentity: identity === undefined,
      });
      const shared = {
        publicKey: handshake.publicKeyB64,
        nonce: bytesToBase64Url(handshake.nonce),
        ...(identity ? { identity } : {}),
      };
      const cols = clampDimension(input.cols);
      const rows = clampDimension(input.rows);
      // A socket that closed first drops nothing that matters: the next one
      // opens and attaches again. A full queue refused it: start again later.
      if (input.mode === "open") {
        const ticket = ticketsRef.current.get(input.localId);
        if (ticket === undefined) {
          pendingRef.current.delete(input.localId);
          refuseTab(input.localId, "ticket_invalid");
          return;
        }
        const requestId = newId("open");
        inflightOpensRef.current.push({ localId: input.localId, requestId });
        const result = sendRef.current({
          type: "open",
          requestId,
          ticket,
          cols,
          rows,
          ...shared,
        });
        if (result === "full") {
          inflightOpensRef.current = inflightOpensRef.current.filter(
            (open) => open.requestId !== requestId,
          );
          pendingRef.current.delete(input.localId);
          failOpeningRef.current(input.localId, "rate_limited");
        }
        return;
      }
      const result = sendRef.current({ type: "attach", terminalId: input.terminalId, ...shared });
      if (result === "full") {
        pendingRef.current.delete(input.terminalId);
        attachingRef.current.delete(input.terminalId);
        failOpeningRef.current(input.localId, "rate_limited");
      }
    },
    [ensureTrust, refuseTab],
  );

  const attach = useCallback(
    (tab: TerminalTab) => {
      if (!tab.terminalId) return;
      clearTimer(reattachTimersRef.current, tab.localId);
      attachingRef.current.add(tab.terminalId);
      const own = ownSizeRef.current.get(tab.localId);
      void beginHandshake({
        mode: "attach",
        localId: tab.localId,
        cliDeviceId: tab.cliDeviceId,
        terminalId: tab.terminalId,
        cols: own?.cols ?? tab.cols,
        rows: own?.rows ?? tab.rows,
      });
    },
    [beginHandshake, clearTimer],
  );

  const canAttach = useCallback((tab: TerminalTab) => {
    if (!tab.terminalId || tab.phase === "exited" || tab.phase === "rejected") return false;
    // Being ended: no new viewer slot for it.
    if (closesRef.current.has(tab.terminalId)) return false;
    if (sessionsRef.current.has(tab.terminalId)) return false;
    // An attach may still be checking the CLI identity before its handshake.
    if (attachingRef.current.has(tab.terminalId)) return false;
    return !pendingFor(pendingRef.current, tab.localId, tab.terminalId);
  }, []);

  /** Start a tab's handshake again, after whatever blocked it has cleared. */
  const retryTab = useCallback(
    (tab: TerminalTab) => {
      awaitingIdentityRef.current.delete(tab.localId);
      const retry: TerminalTab = { ...tab, phase: "opening", rejectionReason: null };
      setTabs((current) =>
        patchTab(current, tab.localId, { phase: "opening", rejectionReason: null }),
      );
      if (tab.terminalId) {
        if (canAttach(retry)) attach(retry);
      } else if (tab.opener) {
        void beginHandshake({
          mode: "open",
          localId: tab.localId,
          cliDeviceId: tab.cliDeviceId,
          terminalId: "",
          cols: tab.cols,
          rows: tab.rows,
        });
      }
    },
    [attach, beginHandshake, canAttach],
  );

  /**
   * An opening tab whose `open`, `attach` or `auth` the relay refused before
   * acting on it. Refused for rate: nothing was made, so start the tab again
   * with backoff. Refused as invalid: the tab is rejected.
   */
  const failOpening = useCallback(
    (localId: string, reason: string) => {
      if (reason !== "rate_limited") {
        patchTabNow(localId, { phase: "rejected", rejectionReason: reason, error: reason });
        return;
      }
      const step = nextReattach(reattachRef.current.get(localId), Date.now());
      reattachRef.current.set(localId, step.state);
      clearTimer(reattachTimersRef.current, localId);
      reattachTimersRef.current.set(
        localId,
        setTimeout(() => {
          reattachTimersRef.current.delete(localId);
          const current = tabsRef.current.find((item) => item.localId === localId);
          if (current?.phase === "opening") retryTab(current);
        }, step.delayMs),
      );
    },
    [clearTimer, patchTabNow, retryTab],
  );

  /** A viewer left this tab (slow, stolen, or the socket dropped). */
  const dropSession = useCallback(
    (localId: string, terminalId: string) => {
      endAttachment(terminalId);
      attachingRef.current.delete(terminalId);
      establishingRef.current.delete(localId);
      takePendingByTerminalId(pendingRef.current, terminalId);
      earlySealedRef.current.delete(terminalId);
      clearTimer(resizeTimersRef.current, localId);
    },
    [clearTimer, endAttachment],
  );

  /**
   * The relay no longer lists this tab's terminal: it ended, or its CLI
   * restarted, while this page was not attached. End the tab like an exit.
   */
  const markTerminalGone = useCallback(
    (localId: string, terminalId: string) => {
      clearTimer(reattachTimersRef.current, localId);
      clearTimer(resizeTimersRef.current, localId);
      reattachRef.current.delete(localId);
      pendingResizeRef.current.delete(localId);
      awaitingIdentityRef.current.delete(localId);
      establishingRef.current.delete(localId);
      pendingRef.current.delete(localId);
      takePendingByTerminalId(pendingRef.current, terminalId);
      attachingRef.current.delete(terminalId);
      knownSinceRef.current.delete(terminalId);
      const session = sessionsRef.current.get(terminalId);
      if (session) retireAfterDrain(terminalId, session);
      else earlySealedRef.current.delete(terminalId);
      patchTabNow(localId, { phase: "exited", approvalCode: null, error: TERMINAL_GONE });
    },
    [clearTimer, patchTabNow, retireAfterDrain],
  );

  /**
   * A `terminals` list is authoritative for this user's terminals. End every
   * tab whose terminal it leaves out, but only tabs whose terminal was known
   * before the list was requested. With several lists outstanding it is not
   * known which request this answers, so the oldest request bounds it.
   */
  const reconcileListedTerminals = useCallback(
    (listed: ReadonlySet<string>, pushed: boolean) => {
      if (pushed) {
        // A pushed list is a snapshot as of now, but a shell this page is
        // still opening may not be registered yet: only settled tabs count.
        // A terminal with a close out is settled by the close's own answers.
        for (const tab of tabsRef.current) {
          const terminalId = tab.terminalId;
          // Operator terminals are never listed: their tabs end by exit, never by a list.
          if (!terminalId || tab.stepId || listed.has(terminalId)) continue;
          if (closesRef.current.has(terminalId)) continue;
          if (tab.phase !== "live") continue;
          if (!knownSinceRef.current.has(terminalId)) continue;
          markTerminalGone(tab.localId, terminalId);
        }
        return;
      }
      const outstanding = listRequestsRef.current;
      if (outstanding.length === 0) return;
      const requestedAt = Math.min(...outstanding);
      outstanding.splice(outstanding.indexOf(Math.max(...outstanding)), 1);
      // A close whose terminal a list asked for after it no longer names has
      // taken effect (or the terminal ended some other way).
      for (const [terminalId, intent] of [...closesRef.current]) {
        if (!listed.has(terminalId) && intent.since < requestedAt) finishClose(terminalId);
      }
      for (const tab of tabsRef.current) {
        const terminalId = tab.terminalId;
        if (!terminalId || tab.stepId || listed.has(terminalId)) continue;
        if (tab.phase === "exited" || tab.phase === "rejected") continue;
        const knownSince = knownSinceRef.current.get(terminalId);
        if (knownSince === undefined || knownSince >= requestedAt) continue;
        markTerminalGone(tab.localId, terminalId);
      }
    },
    [finishClose, markTerminalGone],
  );

  const onMessage = useCallback(
    (message: TerminalServerMessage) => {
      if (message.type === "terminals") {
        const listedIds = new Set(message.terminals.map((remote) => remote.terminalId));
        reconcileListedTerminals(listedIds, message.pushed === true);
        // A detached terminal that is no longer listed has ended; forget it.
        for (const terminalId of detachedRef.current) {
          if (!listedIds.has(terminalId)) detachedRef.current.delete(terminalId);
        }
        cliListRef.current = new Map(message.clis.map((cli) => [cli.cliDeviceId, cli]));
        setClis(message.clis);
        for (const cli of message.clis) {
          cliKeysRef.current.set(cli.cliDeviceId, cli.publicKey);
        }
        listReady.resolve();
        if (!message.pushed) for (const resolve of listWaitersRef.current.splice(0)) resolve();
        // Check every CLI now, so the page can show fingerprints and refusals.
        for (const cli of message.clis) void ensureTrust(cli.cliDeviceId);
        const additions: TerminalTab[] = [];
        const toAttach: TerminalTab[] = [];
        for (const remote of message.terminals) {
          const closing = closesRef.current.get(remote.terminalId);
          // Still running with no close out (its socket closed first): again.
          if (closing && closing.requestId === null && closing.retry === null) {
            sendClose(remote.terminalId);
          }
          const known = tabByTerminal(remote.terminalId);
          if (known) {
            patchTabNow(known.localId, { viewerCount: remote.viewerCount });
            if (canAttach(known)) toAttach.push(known);
            continue;
          }
          if (additions.some((tab) => tab.terminalId === remote.terminalId)) continue;
          if (detachedRef.current.has(remote.terminalId)) continue;
          // Being closed without a tab: it does not come back as one.
          if (closing) continue;
          const tab = newTab({
            localId: newId("local"),
            terminalId: remote.terminalId,
            cliDeviceId: remote.cliDeviceId,
            cols: remote.cols,
            rows: remote.rows,
            opener: false,
            viewerCount: remote.viewerCount,
          });
          noteTerminalKnown(remote.terminalId);
          viewRef.current.set(tab.localId, { writer: tab.writer });
          additions.push(tab);
          toAttach.push(tab);
        }
        if (additions.length > 0) {
          tabsRef.current = [
            ...tabsRef.current,
            ...additions.filter(
              (tab) => !tabsRef.current.some((existing) => existing.terminalId === tab.terminalId),
            ),
          ];
          setTabs((current) => [
            ...current,
            ...additions.filter(
              (tab) => !current.some((existing) => existing.terminalId === tab.terminalId),
            ),
          ]);
          if (!activeRef.current) setActiveLocalId(additions[0]?.localId ?? null);
        }
        for (const tab of toAttach) attach(tab);
        return;
      }
      if (message.type === "opening") {
        const inflight = inflightOpensRef.current;
        // Matched by request id: a refused `open` is never answered here.
        const index = message.requestId
          ? inflight.findIndex((open) => open.requestId === message.requestId)
          : 0;
        if (index === -1) return;
        const localId = inflight.splice(index, 1)[0]?.localId;
        if (!localId) return;
        ticketsRef.current.delete(localId);
        if (closedOpensRef.current.delete(localId)) {
          // The tab is gone. Close the shell, or it would hold a slot unseen,
          // until the relay confirms. Its later `pending` / `opened` find no
          // handshake and are ignored.
          requestClose(message.terminalId, null);
          return;
        }
        const pending = pendingRef.current.get(localId);
        if (!pending) return;
        pending.terminalId = message.terminalId;
        pending.viewerId = message.viewerId;
        pendingRef.current.delete(localId);
        pendingRef.current.set(message.terminalId, pending);
        noteTerminalKnown(message.terminalId);
        // Into the ref too: a close before the next commit must name this terminal.
        patchTabNow(localId, {
          terminalId: message.terminalId,
          viewerId: message.viewerId,
          error: null,
        });
        return;
      }
      if (message.type === "attaching") {
        const pending = pendingRef.current.get(message.terminalId);
        if (!pending || pending.terminalId !== message.terminalId) return;
        pending.viewerId = message.viewerId;
        setTabs((current) =>
          patchTab(current, pending.localId, { viewerId: message.viewerId, error: null }),
        );
        return;
      }
      if (message.type === "pending") {
        const pending = pendingRef.current.get(message.terminalId);
        if (!pending || pending.terminalId !== message.terminalId) return;
        setTabs((current) =>
          patchTab(current, pending.localId, {
            terminalId: message.terminalId,
            approvalCode: message.approvalCode,
            phase: "opening",
          }),
        );
        // Never sign a transcript for an ECDH key the pinned identity did not sign.
        if (message.cliPublicKey !== pending.expectedCliPublicKey) {
          takePendingByTerminalId(pendingRef.current, message.terminalId);
          refuseSubstitutedKey(pending, message.terminalId);
          return;
        }
        // The transcript signs the viewer id. Without one the CLI would reject it.
        if (!pending.viewerId) return;
        const generation = generationRef.current;
        void signRef
          .current({
            terminalId: message.terminalId,
            browserPublicKey: pending.browserPublicRaw,
            browserNonce: pending.browserNonce,
            cliPublicKey: base64UrlToBytes(message.cliPublicKey),
            cliNonce: base64UrlToBytes(message.cliNonce),
            viewerId: pending.viewerId,
          })
          .then((proof) => {
            // A proof for a socket that has since closed answers nothing.
            if (!proof || generationRef.current !== generation) return;
            const result = sendRef.current({
              type: "auth",
              terminalId: message.terminalId,
              signature: proof.signature,
            });
            if (result !== "full") return;
            // Refused by a full queue, like a rate-limited auth: start again.
            takePendingByTerminalId(pendingRef.current, message.terminalId);
            attachingRef.current.delete(message.terminalId);
            failOpening(pending.localId, "rate_limited");
          })
          .catch(() => undefined);
        return;
      }
      if (message.type === "opened" || message.type === "attached") {
        const pending = takePendingByTerminalId(pendingRef.current, message.terminalId);
        if (!pending) return;
        if (message.type === "attached") resetBeforeOutputRef.current.add(pending.localId);
        const generation = generationRef.current;
        void establish(pending, message).catch(() => {
          if (generationRef.current !== generation) return;
          // Only the handshake still in charge of the tab may refuse it.
          if (establishingRef.current.get(pending.localId) !== pending) return;
          establishingRef.current.delete(pending.localId);
          patchTabNow(pending.localId, { phase: "rejected", error: "bad_handshake" });
        });
        return;
      }
      if (message.type === "viewers") {
        const tab = tabByTerminal(message.terminalId);
        if (!tab) return;
        if (message.writer !== "you") clearTimer(resizeTimersRef.current, tab.localId);
        setView(tab.localId, { writer: message.writer }, { viewerCount: message.count });
        return;
      }
      if (message.type === "rejected") {
        if (!message.terminalId) return;
        const pending = takePendingByTerminalId(pendingRef.current, message.terminalId);
        const localId = pending?.localId ?? tabByTerminal(message.terminalId)?.localId;
        if (!localId) return;
        attachingRef.current.delete(message.terminalId);
        establishingRef.current.delete(localId);
        // A 2.5 CLI can drop one viewer (bad frame) while the shell runs on. Its attach ends
        // through the one path: input settled, copy bar and copy-out retired.
        endAttachment(message.terminalId);
        patchTabNow(localId, {
          phase: "rejected",
          approvalCode: message.approvalCode,
          rejectionReason: message.reason,
        });
        // Refused only because the browser identity had not loaded: retry
        // once it has.
        if (pending?.withoutIdentity && message.reason === BROWSER_IDENTITY_REQUIRED) {
          awaitingIdentityRef.current.add(localId);
        }
        return;
      }
      if (message.type === "exit") {
        const terminalId = message.terminalId;
        // A close this page owed is done; its tab (End session) goes now.
        finishClose(terminalId);
        const session = sessionsRef.current.get(terminalId);
        const localId = tabByTerminal(terminalId)?.localId;
        if (!localId) {
          endAttachment(terminalId);
          earlySealedRef.current.delete(terminalId);
          return;
        }
        clearTimer(reattachTimersRef.current, localId);
        clearTimer(resizeTimersRef.current, localId);
        // Mark it exited now; frames that arrive from here on are dropped.
        patchTabNow(localId, {
          phase: "exited",
          exitCode: message.exitCode,
          exitSignal: message.signal,
        });
        if (session) {
          // Frames received before the exit may still be decrypting.
          retireAfterDrain(terminalId, session);
        } else if (!establishingRef.current.has(localId)) {
          // No keys and none coming: nothing queued can be read.
          takePendingByTerminalId(pendingRef.current, terminalId);
          attachingRef.current.delete(terminalId);
          earlySealedRef.current.delete(terminalId);
        }
        return;
      }
      if (message.type === "closed") {
        // The relay ended this terminal for a close from this socket.
        finishClose(message.terminalId);
        return;
      }
      if (message.type === "detached") {
        const tab = tabByTerminal(message.terminalId);
        if (!tab) {
          endAttachment(message.terminalId);
          return;
        }
        // `self` answers this tab's own detach; the tab is already gone.
        if (message.reason === "self") return;
        dropSession(tab.localId, message.terminalId);
        if (tab.stepId) {
          // Re-attaching an operator terminal needs a fresh ticket from its step.
          patchTabNow(tab.localId, {
            phase: "rejected",
            rejectionReason: STEP_DETACHED,
            error: null,
            writer: "none",
          });
          return;
        }
        setView(
          tab.localId,
          { writer: "none" },
          { phase: "opening", error: message.reason === "slow" ? "slow" : "detached" },
        );
        if (message.reason !== "slow") return;
        // This tab fell behind. Reattach with backoff; the others kept going.
        const step = nextReattach(reattachRef.current.get(tab.localId), Date.now());
        reattachRef.current.set(tab.localId, step.state);
        clearTimer(reattachTimersRef.current, tab.localId);
        reattachTimersRef.current.set(
          tab.localId,
          setTimeout(() => {
            reattachTimersRef.current.delete(tab.localId);
            const current = tabsRef.current.find((item) => item.localId === tab.localId);
            if (current && canAttach(current)) attach(current);
          }, step.delayMs),
        );
        return;
      }
      if (message.requestId) {
        // The relay's answer to one close.
        for (const [terminalId, intent] of closesRef.current) {
          if (intent.requestId !== message.requestId) continue;
          // No such terminal (any more): nothing left to end.
          if (message.code === "not_found") finishClose(terminalId);
          // Refused unread: it runs on; send the close again after a window.
          else if (message.code === "rate_limited") {
            scheduleCloseRetry(closesRef.current, sendRef, terminalId);
          } else failClose(terminalId);
          return;
        }
        // A refused `open`: it made no terminal, so no `opening` follows.
        const inflight = inflightOpensRef.current;
        const index = inflight.findIndex((open) => open.requestId === message.requestId);
        if (index !== -1 && !message.terminalId) {
          const localId = inflight.splice(index, 1)[0]?.localId;
          if (!localId) return;
          // Refused unread (rate) keeps the ticket for the retry; any other answer used it.
          if (message.code !== "rate_limited") ticketsRef.current.delete(localId);
          pendingRef.current.delete(localId);
          establishingRef.current.delete(localId);
          if (closedOpensRef.current.delete(localId)) return;
          failOpening(localId, message.code ?? message.message);
          return;
        }
      }
      if (!message.terminalId) return;
      const errorTerminalId = message.terminalId;
      const tab = tabByTerminal(errorTerminalId);
      if (!tab) return;
      const localId = tab.localId;
      if (message.code === "input_dropped") {
        const previous = droppedNoticeRef.current.get(localId);
        if (previous) clearTimeout(previous);
        droppedNoticeRef.current.set(
          localId,
          setTimeout(() => {
            droppedNoticeRef.current.delete(localId);
            setTabs((current) =>
              current.map((item) =>
                item.localId === localId && item.error === "input_dropped"
                  ? { ...item, error: null }
                  : item,
              ),
            );
          }, INPUT_DROPPED_NOTICE_MS),
        );
        setTabs((current) => patchTab(current, localId, { error: "input_dropped" }));
        return;
      }
      // A live tab gets not_found for a frame that raced a CLI reconnect.
      // A real loss arrives as exit or detached.
      if (message.code === "not_found" && tab.phase === "live") return;
      takePendingByTerminalId(pendingRef.current, errorTerminalId);
      attachingRef.current.delete(errorTerminalId);
      if (tab.phase === "opening") establishingRef.current.delete(localId);
      const reason = message.code ?? message.message;
      if (message.code === "rate_limited" && tab.phase === "opening") {
        // This tab's attach or auth was refused unread: start it again.
        failOpening(localId, reason);
        return;
      }
      setTabs((current) =>
        current.map((item) =>
          item.localId === localId
            ? {
                ...item,
                error: reason,
                phase: item.phase === "opening" ? "rejected" : item.phase,
                rejectionReason: item.phase === "opening" ? reason : item.rejectionReason,
              }
            : item,
        ),
      );
    },
    [
      attach,
      canAttach,
      clearTimer,
      dropSession,
      ensureTrust,
      establish,
      failClose,
      failOpening,
      finishClose,
      listReady,
      noteTerminalKnown,
      patchTabNow,
      reconcileListedTerminals,
      refuseSubstitutedKey,
      requestClose,
      requestList,
      retireAfterDrain,
      sendClose,
      setView,
      tabByTerminal,
      viewOf,
    ],
  );

  const onDisconnect = useCallback(() => {
    generationRef.current += 1;
    for (const resolve of listWaitersRef.current.splice(0)) resolve();
    // Every attach ended with the socket, through the one path (input settled, panes told,
    // output buffered for them dropped).
    for (const session of [...sessionsRef.current.values()]) retireAttachment(session, true);
    for (const timer of resizeTimersRef.current.values()) clearTimeout(timer);
    for (const timer of reattachTimersRef.current.values()) clearTimeout(timer);
    resizeTimersRef.current.clear();
    reattachTimersRef.current.clear();
    sessionsRef.current.clear();
    pendingRef.current.clear();
    attachingRef.current.clear();
    establishingRef.current.clear();
    inflightOpensRef.current = [];
    closedOpensRef.current.clear();
    // Lists asked on the closed socket are never answered.
    listRequestsRef.current = [];
    // Nor are its closes (a queued one never left). The next socket's list sends
    // each again while it still names the terminal.
    for (const intent of closesRef.current.values()) {
      if (intent.retry) clearTimeout(intent.retry);
      intent.retry = null;
      intent.requestId = null;
    }
    earlySealedRef.current.clear();
    recvChainRef.current.clear();
    for (const [localId, view] of viewRef.current) {
      viewRef.current.set(localId, { ...view, writer: "none" });
    }
    const settle = (tabs: TerminalTab[]) =>
      tabs.flatMap((tab) => {
        if (!tab.terminalId && tab.phase === "opening") return [];
        // An operator terminal is re-attached only with a fresh ticket from its step.
        if (tab.stepId && (tab.phase === "live" || tab.phase === "opening")) {
          return [
            {
              ...tab,
              phase: "rejected" as const,
              rejectionReason: STEP_DETACHED,
              error: null,
              writer: "none" as const,
            },
          ];
        }
        if (tab.phase === "live" || tab.phase === "opening") {
          return [
            {
              ...tab,
              phase: "opening" as const,
              error: null,
              writer: "none" as const,
            },
          ];
        }
        return [tab];
      });
    tabsRef.current = settle(tabsRef.current);
    setTabs(settle);
    // Settling removes opening tabs: the active tab (and Select text with it) must still name a
    // tab that exists, through the same transition as any other switch.
    const remaining = tabsRef.current;
    if (activeRef.current !== null && !remaining.some((tab) => tab.localId === activeRef.current))
      setActiveLocalId(remaining[remaining.length - 1]?.localId ?? null);
  }, [retireAttachment, setActiveLocalId]);

  /**
   * A new socket: nothing sent before it opened reached the relay. Drop those
   * handshakes and start pending opens again. The list this socket asks for
   * attaches the rest.
   */
  const onOpen = useCallback(() => {
    generationRef.current += 1;
    pendingRef.current.clear();
    attachingRef.current.clear();
    inflightOpensRef.current = [];
    closedOpensRef.current.clear();
    // The socket sends its `list` right after this returns.
    listRequestsRef.current = [];
    noteListRequest();
    for (const tab of tabsRef.current) {
      if (tab.opener && !tab.terminalId && tab.phase === "opening") retryTab(tab);
    }
  }, [noteListRequest, retryTab]);

  const applyPlaintext = useCallback(
    (session: LiveSession, decoded: TerminalPlaintext, replay: boolean) => {
      if (decoded.kind === "data")
        emitOutput(session.localId, {
          kind: "data",
          data: decoded.data,
          replay,
          attach: session.attach,
        });
      else applyPtySize(session.localId, decoded.cols, decoded.rows, session.attach);
    },
    [applyPtySize, emitOutput],
  );

  const openBroadcast = useCallback(
    async (session: LiveSession, frame: SealedTerminalFrame) => {
      const output = session.output;
      if (!output || frame.epoch !== output.epoch) return;
      const seq = BigInt(frame.seq);
      if (seq <= output.recvSeq) return;
      let plaintext: Uint8Array;
      try {
        plaintext = await openTerminalBroadcast({
          key: output.key,
          terminalId: session.terminalId,
          epoch: output.epoch,
          seq,
          ciphertext: frame.body,
        });
      } catch {
        return;
      }
      // Advance only after authentication, only on the epoch still held, and only while this is
      // still the tab's session (a detach or reattach during decryption retires it).
      if (sessionsRef.current.get(session.terminalId) !== session) return;
      if (session.output !== output || seq <= output.recvSeq) return;
      output.recvSeq = seq;
      const decoded = decodeTerminalPlaintextV2(plaintext);
      // Output keys and image messages only ever arrive unicast.
      if (decoded.kind !== "data" && decoded.kind !== "resize") return;
      applyPlaintext(session, decoded, false);
    },
    [applyPlaintext],
  );

  const receiveV2 = useCallback(
    async (session: LiveSession, frame: SealedTerminalFrame) => {
      if (frame.epoch !== undefined) {
        const route = classifyBroadcastEpoch(session.output?.epoch ?? null, frame.epoch);
        if (route === "queue") {
          session.future.push(frame);
          if (session.future.length > TERMINAL_FUTURE_EPOCH_QUEUE) session.future.shift();
          return;
        }
        if (route === "open") await openBroadcast(session, frame);
        return;
      }
      const seq = BigInt(frame.seq);
      if (seq <= session.recvSeq) return;
      let plaintext: Uint8Array;
      try {
        plaintext = await openTerminalBytesV2({
          key: session.cliToBrowser,
          terminalId: session.terminalId,
          viewerId: session.viewerId,
          direction: DIRECTION_CLI_TO_BROWSER,
          seq,
          ciphertext: frame.body,
        });
      } catch {
        return;
      }
      // A detach or reattach during decryption retired this session.
      if (sessionsRef.current.get(session.terminalId) !== session) return;
      if (seq <= session.recvSeq) return;
      session.recvSeq = seq;
      const decoded = decodeTerminalPlaintextV2(plaintext);
      if (decoded.kind === "imageCapabilities") {
        session.images.supported = true;
        return;
      }
      if (decoded.kind === "imageReply") {
        session.images.receive(decoded.reply);
        return;
      }
      if (decoded.kind !== "outputKey") {
        // Unicast data is only ever the join's scrollback replay.
        applyPlaintext(session, decoded, true);
        return;
      }
      // A new key drops the old epoch. A stale or repeated key is ignored.
      if (session.output && decoded.epoch <= session.output.epoch) return;
      const key = await importTerminalOutputKey(decoded.key);
      decoded.key.fill(0);
      if (sessionsRef.current.get(session.terminalId) !== session) return;
      if (session.output && decoded.epoch <= session.output.epoch) return;
      session.output = { epoch: decoded.epoch, key, recvSeq: 0n };
      const queued = session.future;
      session.future = [];
      for (const pending of queued) {
        if (pending.epoch === undefined) continue;
        const route = classifyBroadcastEpoch(decoded.epoch, pending.epoch);
        if (route === "queue") session.future.push(pending);
        else if (route === "open") await openBroadcast(session, pending);
      }
    },
    [applyPlaintext, openBroadcast],
  );

  const onSealed = useCallback(
    (frame: SealedTerminalFrame) => {
      const session = sessionsRef.current.get(frame.terminalId);
      if (!session) {
        // Output sent after the shell exited is not shown.
        if (tabByTerminal(frame.terminalId)?.phase === "exited") return;
        const queued = earlySealedRef.current.get(frame.terminalId) ?? [];
        queued.push(frame);
        if (queued.length > EARLY_FRAME_QUEUE) queued.shift();
        earlySealedRef.current.set(frame.terminalId, queued);
        return;
      }
      const previous = recvChainRef.current.get(frame.terminalId) ?? Promise.resolve();
      const run = previous
        .catch(() => undefined)
        .then(async () => {
          // A detach or re-attach replaced this session; its frames are stale.
          if (sessionsRef.current.get(frame.terminalId) !== session) return;
          await receiveV2(session, frame);
        })
        .catch(() => undefined);
      recvChainRef.current.set(frame.terminalId, run);
    },
    [receiveV2, tabByTerminal],
  );
  const socket = useTerminalSocket(options.enabled ?? true, {
    onMessage,
    onSealed,
    onOpen,
    onDisconnect,
  });
  // Layout effects run before the socket's passive connect effect, so these
  // are in place before any message arrives.
  useLayoutEffect(() => {
    acceptSealedRef.current = onSealed;
    failOpeningRef.current = failOpening;
    sendRef.current = socket.send;
    frameRef.current = socket.sendFrame;
  }, [failOpening, onSealed, socket.send, socket.sendFrame]);

  // Handshakes held back until the browser identity loaded go out now.
  useEffect(() => {
    if (!identity.ready) return;
    if (awaitingIdentityRef.current.size === 0) return;
    const waiting = new Set(awaitingIdentityRef.current);
    awaitingIdentityRef.current.clear();
    for (const tab of tabsRef.current) {
      if (!waiting.has(tab.localId)) continue;
      const blocked =
        tab.phase === "opening" ||
        (tab.phase === "rejected" && tab.rejectionReason === BROWSER_IDENTITY_REQUIRED);
      if (blocked) retryTab(tab);
    }
  }, [identity.ready, retryTab]);

  const selectTab = useCallback(
    (localId: string) => {
      setActiveLocalId(localId);
      const tab = tabsRef.current.find((item) => item.localId === localId);
      if (!tab || !canAttach(tab)) return;
      attach(tab);
    },
    [attach, canAttach],
  );

  const socketStatusRef = useLatestRef(socket.status);
  const refreshClis = useCallback((): Promise<void> => {
    if (socketStatusRef.current !== "open") return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, CLI_LIST_REFRESH_TIMEOUT_MS);
      function done() {
        clearTimeout(timer);
        const waiters = listWaitersRef.current;
        const index = waiters.indexOf(done);
        if (index !== -1) waiters.splice(index, 1);
        resolve();
      }
      listWaitersRef.current.push(done);
      requestList();
    });
  }, [requestList, socketStatusRef]);

  const startOpen = useCallback(
    ({ cliDeviceId, ticket, typedCommand, stepId }: OpenTicketInput) => {
      if (!readyRef.current) return;
      const tab = newTab({
        localId: newId("local"),
        terminalId: null,
        cliDeviceId,
        stepId: stepId ?? null,
        cols: 80,
        rows: 24,
        opener: true,
        viewerCount: 1,
      });
      viewRef.current.set(tab.localId, { writer: tab.writer });
      ticketsRef.current.set(tab.localId, ticket);
      if (typedCommand !== undefined && typableCommand(typedCommand)) {
        typedCommandsRef.current.set(tab.localId, typedCommand);
      }
      tabsRef.current = [...tabsRef.current, tab];
      setTabs((current) => [...current, tab]);
      setActiveLocalId(tab.localId);
      void beginHandshake({
        mode: "open",
        localId: tab.localId,
        cliDeviceId,
        terminalId: "",
        cols: tab.cols,
        rows: tab.rows,
      });
    },
    [beginHandshake],
  );

  const openTicket = useCallback(
    (input: OpenTicketInput) => {
      if (!readyRef.current) return;
      // The relay does not push CLI changes. A CLI that came online after the
      // last list is missing from it, and its handshake would fail as offline.
      void refreshClis().then(() => startOpen(input));
    },
    [refreshClis, startOpen],
  );

  const detachTab = useCallback(
    (localId: string) => {
      const tab = tabsRef.current.find((item) => item.localId === localId);
      if (!tab) return;
      if (tab.terminalId && closesRef.current.has(tab.terminalId)) {
        // Ending already: the close goes on without the tab (removeTab).
        removeTab(tab);
        return;
      }
      if (tab.terminalId && tab.phase !== "exited" && tab.phase !== "rejected") {
        // An operator terminal is never closed from a tab (its step is cancelled instead).
        if (tab.opener && tab.phase !== "live" && !tab.stepId) {
          // An open that never went live has no other viewers: cancel it
          // outright, and keep at it until the relay confirms.
          requestClose(tab.terminalId, null);
        } else {
          // A lost detach needs no retry: the relay drops a closed socket's viewers.
          sendRef.current({ type: "detach", terminalId: tab.terminalId });
          detachedRef.current.add(tab.terminalId);
        }
      }
      removeTab(tab);
    },
    [removeTab, requestClose],
  );

  const endSession = useCallback(
    (localId: string) => {
      const tab = tabsRef.current.find((item) => item.localId === localId);
      if (!tab) return;
      if (!tab.terminalId || tab.phase === "exited" || tab.phase === "rejected") {
        removeTab(tab);
        return;
      }
      // The tab stays, marked ending, until the relay says the terminal ended
      // (`closed`, its exit, or a list without it). Only then is it removed. Its attach ends
      // now: nothing more is sent (input already being sealed included), output still shows.
      patchTabNow(localId, { ending: "pending" });
      const session = sessionsRef.current.get(tab.terminalId);
      if (session) retireAttachment(session, false);
      requestClose(tab.terminalId, localId);
    },
    [patchTabNow, removeTab, requestClose, retireAttachment],
  );

  const subscribeOutput = useCallback(
    (
      localId: string,
      listener: (event: TerminalOutputEvent) => void,
      reset?: () => void,
      retire?: () => void,
    ) => {
      listenersRef.current.set(localId, listener);
      if (reset) resettersRef.current.set(localId, reset);
      if (retire) retireRef.current.set(localId, retire);
      if (resetBeforeOutputRef.current.delete(localId)) reset?.();
      const queued = buffersRef.current.get(localId) ?? [];
      buffersRef.current.delete(localId);
      // Marked at delivery: an attach that ended while these waited is retired now.
      for (const event of queued) listener(delivered(localId, event));
      return () => {
        if (listenersRef.current.get(localId) === listener) listenersRef.current.delete(localId);
        if (retire && retireRef.current.get(localId) === retire) retireRef.current.delete(localId);
      };
    },
    [delivered],
  );

  const sendInput = useCallback(
    (localId: string, data: string | Uint8Array, origin: TerminalInputOrigin = "user") => {
      const tab = tabsRef.current.find((item) => item.localId === localId);
      // A session being ended takes no more keystrokes.
      if (!tab || tab.ending === "pending") return;
      // Input made while Select text is on is dropped: the terminal is inert then, so only
      // asynchronous paths can produce it. (Input queued before the mode started waits instead,
      // and a ticket's typed command is held by its own timer.)
      if (selectingRef.current === localId && origin !== "typed") return;
      const bytes = typeof data === "string" ? textEncoder.encode(data) : data;
      if (bytes.length === 0) return;
      // Input belongs to the attach it is made on. With none live it has nowhere to go (a
      // ticket's typed command waits for the next one).
      const session = liveSessionOf(localId);
      if (!session) {
        if (origin === "typed" && typeof data === "string")
          settleUnsent(localId, [{ bytes, origin, text: data }]);
        return;
      }
      const batch = session.batch;
      batch.items.push(
        origin === "typed" && typeof data === "string"
          ? { bytes, origin, text: data }
          : { bytes, origin },
      );
      batch.size += bytes.length;
      const wait = INPUT_FLUSH_INTERVAL_MS - (performance.now() - batch.lastSentAt);
      if (wait <= 0 || batch.size >= INPUT_BATCH_MAX_CHARS) {
        flushInput(localId);
        return;
      }
      batch.timer ??= setTimeout(() => flushInput(localId), wait);
    },
    [flushInput, liveSessionOf, settleUnsent],
  );
  // `emitOutput` types a ticket's command through it; it is defined before `sendInput`.
  useLayoutEffect(() => {
    sendInputRef.current = sendInput;
  }, [sendInput]);

  /**
   * An image's path, pasted as its own frame through the same gateway as typed input, in order
   * behind anything typed before it: not while Select text is on, and from a follower only by
   * taking over from the visible, measured tab. Resolves with whether it reached the socket.
   */
  const pasteImage = useCallback(
    (localId: string, id: string, data: string) => {
      const session = liveSessionOf(localId);
      if (!session || selectingRef.current === localId) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        let settled = false;
        session.batch.items.push({
          bytes: new Uint8Array(0),
          origin: "user",
          image: {
            id,
            data,
            done: (sent) => {
              if (settled) return;
              settled = true;
              resolve(sent);
            },
          },
        });
        flushInput(localId);
      });
    },
    [flushInput, liveSessionOf],
  );

  const sendResize = useCallback(
    (localId: string, cols: number, rows: number) => {
      const clampedCols = clampTerminalAxis(cols);
      const clampedRows = clampTerminalAxis(rows);
      if (clampedCols === null || clampedRows === null) return;
      const own = { cols: clampedCols, rows: clampedRows };
      ownSizeRef.current.set(localId, own);
      const wasMeasurable = measurableRef.current.has(localId);
      measurableRef.current.add(localId);
      setTabs((current) => patchTab(current, localId, own));
      // Measured again (shown, or its box came back): input and a ticket's command waiting for a
      // measured tab can go now.
      if (!wasMeasurable) {
        flushInput(localId);
        scheduleTypedCommand(localId);
      }
      // A follower only records its size. It sends it when it takes over.
      if (!canSendResize(viewOf(localId))) return;
      clearTimer(resizeTimersRef.current, localId);
      resizeTimersRef.current.set(
        localId,
        setTimeout(() => flushResize(localId), TERMINAL_RESIZE_DEBOUNCE_MS),
      );
    },
    [clearTimer, flushInput, flushResize, scheduleTypedCommand, viewOf],
  );

  const sizeUnavailable = useCallback(
    (localId: string) => {
      measurableRef.current.delete(localId);
      clearTimer(resizeTimersRef.current, localId);
    },
    [clearTimer],
  );

  const uploadImage = useCallback(
    async (localId: string, file: File, progress: (percent: number) => void) => {
      const tab = tabsRef.current.find((item) => item.localId === localId);
      const session = tab?.terminalId ? sessionsRef.current.get(tab.terminalId) : undefined;
      const isCurrent = () => {
        const current = tabsRef.current.find((item) => item.localId === localId);
        return (
          !!session &&
          current?.phase === "live" &&
          current.terminalId === session.terminalId &&
          !current.ending &&
          !current.stepId &&
          !session.ended &&
          sessionsRef.current.get(session.terminalId) === session
        );
      };
      if (!session || !isCurrent()) throw new Error("unavailable");
      flushInput(localId);
      // Upload frames go on the attach's queue like every other frame: numbered in send order,
      // and never sent once the attach has ended.
      return session.images.upload(
        file,
        (plaintext) => sendOnQueue(session, plaintext, isCurrent),
        isCurrent,
        progress,
      );
    },
    [flushInput, sendOnQueue],
  );

  useEffect(
    () => () => {
      for (const session of sessionsRef.current.values()) session.images.abort();
    },
    [],
  );

  const trustNewKey = useCallback(
    async (cliDeviceId: string, expected: ChangedCliTrust): Promise<boolean> => {
      const cli = cliListRef.current.get(cliDeviceId);
      if (!cli) return false;
      // Pin only the identity the user inspected. `trustNewCliKey` checks the
      // relay still lists exactly that key; otherwise it pins nothing and
      // returns a fresh evaluation, which is shown instead.
      const promise = trustNewCliKey(cli, expected, pinStoreRef.current).catch(
        (): CliTrust => ({ status: "invalid" }),
      );
      trustRef.current.set(cliDeviceId, { key: cliTrustInputKey(cli), promise });
      const trust = await promise;
      const applied = trustAppliedSnapshot(expected, trust);
      // A newer list re-evaluates this CLI; that result is the one to show.
      if (trustRef.current.get(cliDeviceId)?.promise !== promise) return applied;
      publishTrust(cliDeviceId, trust);
      if (!applied || !trustAllowsHandshake(trust).ok) return applied;
      // Retry the tabs this CLI's identity blocked before they sent anything.
      for (const tab of tabsRef.current) {
        if (tab.cliDeviceId !== cliDeviceId || tab.phase !== "rejected") continue;
        if (!IDENTITY_RETRY_REASONS.has(tab.rejectionReason ?? "")) continue;
        retryTab(tab);
      }
      return applied;
    },
    [publishTrust, retryTab],
  );

  const setSelecting = useCallback(
    (localId: string | null) => {
      // Only the active tab can be selecting.
      changeSelecting(localId !== null && localId === activeRef.current ? localId : null);
    },
    [changeSelecting],
  );
  // Held input resumes when Select text ends: a ticket's command is typed once the output
  // settles again, and keys queued just before the mode started go out.
  useLayoutEffect(() => {
    resumeInputRef.current = (localId: string) => {
      scheduleTypedCommand(localId);
      flushInputRef.current(localId);
    };
  }, [scheduleTypedCommand]);

  const currentSession = useCallback(
    (localId: string): unknown => liveSessionOf(localId),
    [liveSessionOf],
  );

  return {
    status: socket.status,
    identityReady: identity.ready,
    clis,
    cliTrust,
    trustNewKey,
    tabs,
    activeLocalId,
    selectTab,
    selectingLocalId,
    setSelecting,
    currentSession,
    openTicket,
    refreshClis,
    detachTab,
    endSession,
    subscribeOutput,
    sendInput,
    uploadImage,
    pasteImage,
    sendResize,
    sizeUnavailable,
  };
}

type SendRef = { readonly current: (message: TerminalClientMessage) => TerminalSendResult };

/**
 * Send a close intent's frame on the current socket. Not taken: a closed
 * socket's successor lists the terminal and the list sends it then; a full
 * queue tries again after a rate window.
 */
function sendCloseIntent(intents: Map<string, CloseIntent>, sendRef: SendRef, terminalId: string) {
  const intent = intents.get(terminalId);
  if (!intent) return;
  if (intent.retry) clearTimeout(intent.retry);
  intent.retry = null;
  const requestId = newId("close");
  const result = sendRef.current({ type: "close", terminalId, requestId });
  intent.requestId = sendTaken(result) ? requestId : null;
  if (result === "full") scheduleCloseRetry(intents, sendRef, terminalId);
}

/** Send an intent that has no close out again after one rate window. */
function scheduleCloseRetry(
  intents: Map<string, CloseIntent>,
  sendRef: SendRef,
  terminalId: string,
) {
  const intent = intents.get(terminalId);
  if (!intent || intent.retry) return;
  intent.requestId = null;
  intent.retry = setTimeout(() => {
    intent.retry = null;
    if (intents.get(terminalId) !== intent || intent.requestId !== null) return;
    sendCloseIntent(intents, sendRef, terminalId);
  }, TERMINAL_BROWSER_JSON_WINDOW_MS);
}

function clampDimension(value: number): number {
  return clampTerminalAxis(value) ?? 80;
}

function pendingFor(
  pending: Map<string, PendingHandshake>,
  localId: string,
  terminalId: string | null,
): boolean {
  for (const value of pending.values()) {
    if (value.localId === localId) return true;
    if (terminalId && value.terminalId === terminalId) return true;
  }
  return false;
}
