import { useCallback, useRef, useState } from "react";
import {
  assertIncreasingTerminalSeq,
  base64UrlToBytes,
  bytesToBase64Url,
  DIRECTION_BROWSER_TO_CLI,
  DIRECTION_CLI_TO_BROWSER,
  decodeTerminalPlaintext,
  decodeTerminalPlaintextV2,
  deriveTerminalSessionKeys,
  deriveTerminalSessionKeysV2,
  encodeTerminalData,
  encodeTerminalResize,
  generateEphemeralHandshake,
  importEcdhPublicRaw,
  importTerminalOutputKey,
  openTerminalBroadcast,
  openTerminalBytes,
  openTerminalBytesV2,
  sealTerminalBytes,
  sealTerminalBytesV2,
  type TerminalPlaintextV2,
  useTerminalIdentity,
} from "@/hooks/use-terminal-crypto";
import { type TerminalSocketStatus, useTerminalSocket } from "@/hooks/use-terminal-socket";
import { takePendingByTerminalId } from "@/lib/terminal-pending";
import {
  clampTerminalAxis,
  encodeSealedFrame,
  type SealedTerminalFrame,
  type TerminalClientMessage,
  type TerminalServerMessage,
  type TerminalWriterLabel,
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
  type TerminalSize,
  type TerminalWriterState,
} from "@/lib/terminal-writer";

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

type InputBatch = {
  pending: string;
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
  approvalCode: string | null;
  rejectionReason: string | null;
  error: string | null;
  /** Protocol 2.5 terminal: several viewers, v2 crypto, and a writer. */
  multiViewer: boolean;
  viewerId: string | null;
  writer: TerminalWriterLabel;
  viewerCount: number;
  /** The PTY size the CLI reported, or null before the first report. */
  ptyCols: number | null;
  ptyRows: number | null;
  /** This tab asked the CLI to spawn the terminal and it has not gone live yet. */
  opener: boolean;
};

/** Output for a pane, in CLI order: bytes, and PTY size changes. */
export type TerminalOutputEvent =
  | { kind: "data"; data: Uint8Array }
  | { kind: "size"; cols: number; rows: number };

type PendingHandshake = {
  localId: string;
  terminalId: string;
  version: 1 | 2;
  /** Server-minted viewer id, from `opening` / `attaching`. */
  viewerId: string | null;
  privateKey: CryptoKey;
  browserPublicRaw: Uint8Array;
  browserNonce: Uint8Array;
};

type OutputKeyState = {
  epoch: number;
  key: CryptoKey;
  recvSeq: bigint;
};

type LiveSession = {
  localId: string;
  terminalId: string;
  version: 1 | 2;
  /** Empty on v1. */
  viewerId: string;
  browserToCli: CryptoKey;
  cliToBrowser: CryptoKey;
  sendSeq: bigint;
  /** Unicast (pairwise) receive cursor. */
  recvSeq: bigint;
  /** v2: the shared output key and its own receive cursor. */
  output: OutputKeyState | null;
  /** v2: broadcast frames for an epoch whose key has not arrived yet. */
  future: SealedTerminalFrame[];
};

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

function newTab(input: {
  localId: string;
  terminalId: string | null;
  cliDeviceId: string;
  cols: number;
  rows: number;
  multiViewer: boolean;
  opener: boolean;
  viewerCount: number;
}): TerminalTab {
  return {
    ...input,
    phase: "opening",
    approvalCode: null,
    rejectionReason: null,
    error: null,
    viewerId: null,
    // The opener is the first writer. An attaching tab follows until told.
    writer: input.opener || !input.multiViewer ? "you" : "none",
    ptyCols: null,
    ptyRows: null,
  };
}

export function useTerminalSessions(): {
  status: TerminalSocketStatus;
  identityReady: boolean;
  tabs: TerminalTab[];
  activeLocalId: string | null;
  selectTab: (localId: string) => void;
  openCli: (cliDeviceId: string) => void;
  /** X button: stop viewing. The shell keeps running for other viewers. */
  detachTab: (localId: string) => void;
  /** End session: close the shell for everyone. */
  endSession: (localId: string) => void;
  subscribeOutput: (
    localId: string,
    listener: (event: TerminalOutputEvent) => void,
    reset?: () => void,
  ) => () => void;
  sendInput: (localId: string, data: string) => void;
  sendResize: (localId: string, cols: number, rows: number) => void;
} {
  const identity = useTerminalIdentity();
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeLocalId, setActiveLocalId] = useState<string | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeRef = useRef(activeLocalId);
  activeRef.current = activeLocalId;
  const cliKeysRef = useRef(new Map<string, string | null>());
  /** cliDeviceId -> the CLI speaks protocol 2.5 (multi-viewer, v2 crypto). */
  const cliViewersRef = useRef(new Map<string, boolean>());
  /** Writer state per tab, updated synchronously ahead of the render. */
  const viewRef = useRef(new Map<string, TerminalWriterState>());
  const ownSizeRef = useRef(new Map<string, TerminalSize>());
  const lastSentSizeRef = useRef(new Map<string, TerminalSize>());
  const resizeTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const reattachRef = useRef(new Map<string, ReattachState>());
  const reattachTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingRef = useRef(new Map<string, PendingHandshake>());
  const sessionsRef = useRef(new Map<string, LiveSession>());
  const attachingRef = useRef(new Set<string>());
  const listenersRef = useRef(new Map<string, (event: TerminalOutputEvent) => void>());
  const resettersRef = useRef(new Map<string, () => void>());
  const buffersRef = useRef(new Map<string, TerminalOutputEvent[]>());
  const pendingResizeRef = useRef(new Map<string, TerminalSize>());
  const sendRef = useRef<(message: TerminalClientMessage) => void>(() => undefined);
  const frameRef = useRef<(frame: ArrayBuffer) => void>(() => undefined);
  const signRef = useRef(identity.sign);
  signRef.current = identity.sign;
  const publicKeyRef = useRef(identity.publicKey);
  publicKeyRef.current = identity.publicKey;
  const readyRef = useRef(identity.ready);
  readyRef.current = identity.ready;
  const inflightOpensRef = useRef<string[]>([]);
  const resetBeforeOutputRef = useRef(new Set<string>());
  const earlySealedRef = useRef(new Map<string, SealedTerminalFrame[]>());
  const sendChainRef = useRef(new Map<string, Promise<void>>());
  const recvChainRef = useRef(new Map<string, Promise<void>>());
  const acceptSealedRef = useRef<(frame: SealedTerminalFrame) => void>(() => undefined);
  const inputRef = useRef(new Map<string, InputBatch>());
  const droppedNoticeRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const viewOf = useCallback((localId: string): TerminalWriterState => {
    return viewRef.current.get(localId) ?? { multiViewer: false, writer: "you" };
  }, []);

  const setView = useCallback(
    (localId: string, patch: Partial<TerminalWriterState>, extra?: Partial<TerminalTab>) => {
      const next = { ...viewOf(localId), ...patch };
      viewRef.current.set(localId, next);
      setTabs((current) => patchTab(current, localId, { ...next, ...extra }));
    },
    [viewOf],
  );

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

  const emitOutput = useCallback((localId: string, event: TerminalOutputEvent) => {
    const listener = listenersRef.current.get(localId);
    if (listener) {
      if (resetBeforeOutputRef.current.delete(localId)) resettersRef.current.get(localId)?.();
      listener(event);
      return;
    }
    const queued = buffersRef.current.get(localId) ?? [];
    queued.push(event);
    if (queued.length > OUTPUT_BUFFER_EVENTS) queued.shift();
    buffersRef.current.set(localId, queued);
  }, []);

  const applyPtySize = useCallback(
    (localId: string, cols: number, rows: number) => {
      if (cols < 1 || rows < 1) return;
      setTabs((current) => patchTab(current, localId, { ptyCols: cols, ptyRows: rows }));
      emitOutput(localId, { kind: "size", cols, rows });
    },
    [emitOutput],
  );

  const sendPlaintext = useCallback((localId: string, plaintext: Uint8Array) => {
    const tab = tabsRef.current.find((item) => item.localId === localId);
    const terminalId = tab?.terminalId;
    if (!terminalId) return;
    const session = sessionsRef.current.get(terminalId);
    if (!session) {
      const resize = decodeMaybeResize(plaintext);
      if (resize) pendingResizeRef.current.set(localId, resize);
      return;
    }
    const seq = session.sendSeq + 1n;
    session.sendSeq = seq;
    const previous = sendChainRef.current.get(terminalId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const body =
          session.version === 2
            ? await sealTerminalBytesV2({
                key: session.browserToCli,
                terminalId,
                viewerId: session.viewerId,
                direction: DIRECTION_BROWSER_TO_CLI,
                seq,
                plaintext,
              })
            : await sealTerminalBytes({
                key: session.browserToCli,
                terminalId,
                direction: DIRECTION_BROWSER_TO_CLI,
                seq,
                plaintext,
              });
        // A disconnect or re-attach replaces the session. Its keys are gone,
        // so the CLI would reject this frame.
        if (sessionsRef.current.get(terminalId) !== session) return;
        frameRef.current(encodeSealedFrame({ terminalId, seq: Number(seq), body }));
      })
      .catch(() => undefined);
    sendChainRef.current.set(terminalId, run);
  }, []);

  const flushInput = useCallback(
    (localId: string) => {
      const batch = inputRef.current.get(localId);
      if (!batch) return;
      if (batch.timer) clearTimeout(batch.timer);
      batch.timer = null;
      if (!batch.pending) return;
      const data = batch.pending;
      batch.pending = "";
      batch.lastSentAt = performance.now();
      sendPlaintext(localId, encodeTerminalData(textEncoder.encode(data)));
    },
    [sendPlaintext],
  );

  /** Send this tab's own size now, if it is allowed to and it changed. */
  const flushResize = useCallback(
    (localId: string) => {
      clearTimer(resizeTimersRef.current, localId);
      const own = ownSizeRef.current.get(localId);
      if (!own || !canSendResize(viewOf(localId))) return;
      if (sameSize(own, lastSentSizeRef.current.get(localId))) return;
      lastSentSizeRef.current.set(localId, own);
      // Keep typed input ahead of the resize, in the order the user made them.
      flushInput(localId);
      sendPlaintext(localId, encodeTerminalResize(own.cols, own.rows));
    },
    [clearTimer, flushInput, sendPlaintext, viewOf],
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
      pendingRef.current.delete(pending.localId);
      if (pending.terminalId) pendingRef.current.delete(pending.terminalId);
      attachingRef.current.delete(message.terminalId);
      const viewerId = pending.viewerId;
      if (pending.version === 2 && !viewerId) {
        setTabs((current) =>
          patchTab(current, pending.localId, { phase: "rejected", error: "bad_handshake" }),
        );
        return;
      }
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
      const keys =
        pending.version === 2 && viewerId
          ? await deriveTerminalSessionKeysV2({ ...shared, viewerId })
          : await deriveTerminalSessionKeys(shared);
      if (!tabsRef.current.some((tab) => tab.localId === pending.localId)) return;
      sessionsRef.current.set(message.terminalId, {
        localId: pending.localId,
        terminalId: message.terminalId,
        version: pending.version,
        viewerId: viewerId ?? "",
        browserToCli: keys.browserToCli,
        cliToBrowser: keys.cliToBrowser,
        sendSeq: 0n,
        recvSeq: 0n,
        output: null,
        future: [],
      });
      lastSentSizeRef.current.delete(pending.localId);
      reattachTimersRef.current.delete(pending.localId);
      const early = earlySealedRef.current.get(message.terminalId) ?? [];
      earlySealedRef.current.delete(message.terminalId);
      for (const frame of early) acceptSealedRef.current(frame);
      const view = viewOf(pending.localId);
      const writer: TerminalWriterLabel =
        pending.version === 1 || (message.type === "opened" && view.writer === "none")
          ? "you"
          : view.writer;
      setView(
        pending.localId,
        { writer, multiViewer: pending.version === 2 },
        {
          terminalId: message.terminalId,
          phase: "live",
          approvalCode: null,
          rejectionReason: null,
          error: null,
          opener: false,
          viewerId,
          ...(pending.version === 1 ? { viewerCount: 1 } : {}),
        },
      );
      const resize = pendingResizeRef.current.get(pending.localId);
      pendingResizeRef.current.delete(pending.localId);
      if (resize && !ownSizeRef.current.has(pending.localId)) {
        ownSizeRef.current.set(pending.localId, resize);
      }
      flushResize(pending.localId);
    },
    [flushResize, setView, viewOf],
  );

  const beginHandshake = useCallback(
    async (input: {
      localId: string;
      cliDeviceId: string;
      terminalId: string;
      cols: number;
      rows: number;
      mode: "open" | "attach";
      version: 1 | 2;
    }) => {
      const handshake = await generateEphemeralHandshake();
      if (!tabsRef.current.some((tab) => tab.localId === input.localId)) return;
      const publicKey = publicKeyRef.current();
      const identity = publicKey ? { publicKey } : undefined;
      pendingRef.current.set(input.mode === "open" ? input.localId : input.terminalId, {
        localId: input.localId,
        terminalId: input.mode === "open" ? "" : input.terminalId,
        version: input.version,
        viewerId: null,
        privateKey: handshake.privateKey,
        browserPublicRaw: handshake.publicKeyRaw,
        browserNonce: handshake.nonce,
      });
      const shared = {
        publicKey: handshake.publicKeyB64,
        nonce: bytesToBase64Url(handshake.nonce),
        ...(identity ? { identity } : {}),
      };
      const cols = clampDimension(input.cols);
      const rows = clampDimension(input.rows);
      if (input.mode === "open") {
        inflightOpensRef.current.push(input.localId);
        sendRef.current({
          type: "open",
          cliDeviceId: input.cliDeviceId,
          cols,
          rows,
          ...shared,
        });
        return;
      }
      sendRef.current({ type: "attach", terminalId: input.terminalId, ...shared });
    },
    [],
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
        version: viewOf(tab.localId).multiViewer ? 2 : 1,
      });
    },
    [beginHandshake, clearTimer, viewOf],
  );

  const canAttach = useCallback((tab: TerminalTab) => {
    if (!tab.terminalId || tab.phase === "exited" || tab.phase === "rejected") return false;
    if (sessionsRef.current.has(tab.terminalId)) return false;
    return !pendingFor(pendingRef.current, tab.localId, tab.terminalId);
  }, []);

  /** A viewer left this tab (slow, stolen, or the socket dropped). */
  const dropSession = useCallback(
    (localId: string, terminalId: string) => {
      sessionsRef.current.delete(terminalId);
      attachingRef.current.delete(terminalId);
      takePendingByTerminalId(pendingRef.current, terminalId);
      earlySealedRef.current.delete(terminalId);
      lastSentSizeRef.current.delete(localId);
      clearTimer(resizeTimersRef.current, localId);
    },
    [clearTimer],
  );

  const onMessage = useCallback(
    (message: TerminalServerMessage) => {
      if (message.type === "terminals") {
        for (const cli of message.clis) {
          cliKeysRef.current.set(cli.cliDeviceId, cli.publicKey);
          cliViewersRef.current.set(cli.cliDeviceId, cli.terminalViewers);
        }
        const additions: TerminalTab[] = [];
        const toAttach: TerminalTab[] = [];
        for (const remote of message.terminals) {
          const multiViewer = cliViewersRef.current.get(remote.cliDeviceId) ?? false;
          // 2.4: attaching steals the terminal from the tab that has it. Only
          // do that when the user selects it.
          const heldElsewhere = !multiViewer && remote.viewerAttached && !remote.attachedHere;
          const known = tabByTerminal(remote.terminalId);
          if (known) {
            viewRef.current.set(known.localId, { ...viewOf(known.localId), multiViewer });
            setTabs((current) =>
              patchTab(current, known.localId, {
                multiViewer,
                ...(multiViewer ? { viewerCount: remote.viewerCount } : {}),
              }),
            );
            if (canAttach(known) && !heldElsewhere) toAttach.push({ ...known, multiViewer });
            continue;
          }
          if (additions.some((tab) => tab.terminalId === remote.terminalId)) continue;
          const tab = newTab({
            localId: newId("local"),
            terminalId: remote.terminalId,
            cliDeviceId: remote.cliDeviceId,
            cols: remote.cols,
            rows: remote.rows,
            multiViewer,
            opener: false,
            viewerCount: remote.viewerCount,
          });
          if (heldElsewhere) tab.error = "detached";
          viewRef.current.set(tab.localId, { multiViewer, writer: tab.writer });
          additions.push(tab);
          if (!heldElsewhere) toAttach.push(tab);
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
        const localId = inflightOpensRef.current.shift();
        if (!localId) return;
        const pending = pendingRef.current.get(localId);
        if (!pending) return;
        pending.terminalId = message.terminalId;
        pending.viewerId = message.viewerId;
        pendingRef.current.delete(localId);
        pendingRef.current.set(message.terminalId, pending);
        setTabs((current) =>
          patchTab(current, localId, {
            terminalId: message.terminalId,
            viewerId: message.viewerId,
            error: null,
          }),
        );
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
        // v2 signs the viewer id too. Without one the CLI would reject it.
        if (pending.version === 2 && !pending.viewerId) return;
        void signRef
          .current({
            terminalId: message.terminalId,
            browserPublicKey: pending.browserPublicRaw,
            browserNonce: pending.browserNonce,
            cliPublicKey: base64UrlToBytes(message.cliPublicKey),
            cliNonce: base64UrlToBytes(message.cliNonce),
            ...(pending.version === 2 && pending.viewerId ? { viewerId: pending.viewerId } : {}),
          })
          .then((proof) => {
            if (!proof) return;
            sendRef.current({
              type: "auth",
              terminalId: message.terminalId,
              signature: proof.signature,
            });
          })
          .catch(() => undefined);
        return;
      }
      if (message.type === "opened" || message.type === "attached") {
        const pending = takePendingByTerminalId(pendingRef.current, message.terminalId);
        if (!pending) return;
        if (message.type === "attached") resetBeforeOutputRef.current.add(pending.localId);
        void establish(pending, message).catch(() => {
          setTabs((current) =>
            patchTab(current, pending.localId, { phase: "rejected", error: "bad_handshake" }),
          );
        });
        return;
      }
      if (message.type === "viewers") {
        const tab = tabByTerminal(message.terminalId);
        if (!tab) return;
        const view = viewOf(tab.localId);
        if (!view.multiViewer) return;
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
        // A 2.5 CLI can drop one viewer (bad frame) while the shell runs on.
        sessionsRef.current.delete(message.terminalId);
        setTabs((current) =>
          patchTab(current, localId, {
            phase: "rejected",
            approvalCode: message.approvalCode,
            rejectionReason: message.reason,
          }),
        );
        return;
      }
      if (message.type === "exit") {
        sessionsRef.current.delete(message.terminalId);
        const localId = tabByTerminal(message.terminalId)?.localId;
        if (!localId) return;
        clearTimer(reattachTimersRef.current, localId);
        clearTimer(resizeTimersRef.current, localId);
        setTabs((current) => patchTab(current, localId, { phase: "exited" }));
        return;
      }
      if (message.type === "detached") {
        const tab = tabByTerminal(message.terminalId);
        if (!tab) {
          sessionsRef.current.delete(message.terminalId);
          return;
        }
        // `self` answers this tab's own detach; the tab is already gone.
        if (message.reason === "self") return;
        dropSession(tab.localId, message.terminalId);
        const view = viewOf(tab.localId);
        setView(
          tab.localId,
          { writer: view.multiViewer ? "none" : "you" },
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
      const reason = message.code ?? message.message;
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
    [attach, canAttach, clearTimer, dropSession, establish, setView, tabByTerminal, viewOf],
  );

  const onDisconnect = useCallback(() => {
    for (const batch of inputRef.current.values()) {
      if (batch.timer) clearTimeout(batch.timer);
    }
    for (const timer of resizeTimersRef.current.values()) clearTimeout(timer);
    for (const timer of reattachTimersRef.current.values()) clearTimeout(timer);
    resizeTimersRef.current.clear();
    reattachTimersRef.current.clear();
    lastSentSizeRef.current.clear();
    inputRef.current.clear();
    sessionsRef.current.clear();
    pendingRef.current.clear();
    attachingRef.current.clear();
    inflightOpensRef.current = [];
    earlySealedRef.current.clear();
    sendChainRef.current.clear();
    recvChainRef.current.clear();
    for (const [localId, view] of viewRef.current) {
      if (view.multiViewer) viewRef.current.set(localId, { ...view, writer: "none" });
    }
    setTabs((current) =>
      current.flatMap((tab) => {
        if (!tab.terminalId && tab.phase === "opening") return [];
        if (tab.phase === "live" || tab.phase === "opening") {
          return [
            {
              ...tab,
              phase: "opening" as const,
              error: null,
              writer: tab.multiViewer ? ("none" as const) : tab.writer,
            },
          ];
        }
        return [tab];
      }),
    );
  }, []);

  const applyPlaintext = useCallback(
    (session: LiveSession, decoded: TerminalPlaintextV2) => {
      if (decoded.kind === "data")
        emitOutput(session.localId, { kind: "data", data: decoded.data });
      else if (decoded.kind === "resize") {
        applyPtySize(session.localId, decoded.cols, decoded.rows);
      }
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
      // Advance only after authentication, and only on the epoch still held.
      if (session.output !== output || seq <= output.recvSeq) return;
      output.recvSeq = seq;
      const decoded = decodeTerminalPlaintextV2(plaintext);
      // An output key only ever arrives unicast.
      if (decoded.kind === "outputKey") return;
      applyPlaintext(session, decoded);
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
      if (seq <= session.recvSeq) return;
      session.recvSeq = seq;
      const decoded = decodeTerminalPlaintextV2(plaintext);
      if (decoded.kind !== "outputKey") {
        applyPlaintext(session, decoded);
        return;
      }
      // A new key drops the old epoch. A stale or repeated key is ignored.
      if (session.output && decoded.epoch <= session.output.epoch) return;
      session.output = {
        epoch: decoded.epoch,
        key: await importTerminalOutputKey(decoded.key),
        recvSeq: 0n,
      };
      decoded.key.fill(0);
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

  const receiveV1 = useCallback(
    async (session: LiveSession, frame: SealedTerminalFrame) => {
      if (frame.epoch !== undefined) return;
      const seq = BigInt(frame.seq);
      try {
        assertIncreasingTerminalSeq(session.recvSeq, seq);
      } catch {
        return;
      }
      let plaintext: Uint8Array;
      try {
        plaintext = await openTerminalBytes({
          key: session.cliToBrowser,
          terminalId: session.terminalId,
          direction: DIRECTION_CLI_TO_BROWSER,
          seq,
          ciphertext: frame.body,
        });
      } catch {
        return;
      }
      if (session.recvSeq >= seq) return;
      session.recvSeq = seq;
      const decoded = decodeTerminalPlaintext(plaintext);
      if (decoded.kind === "data")
        emitOutput(session.localId, { kind: "data", data: decoded.data });
    },
    [emitOutput],
  );

  const onSealed = useCallback(
    (frame: SealedTerminalFrame) => {
      const session = sessionsRef.current.get(frame.terminalId);
      if (!session) {
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
          if (session.version === 2) await receiveV2(session, frame);
          else await receiveV1(session, frame);
        })
        .catch(() => undefined);
      recvChainRef.current.set(frame.terminalId, run);
    },
    [receiveV1, receiveV2],
  );
  acceptSealedRef.current = onSealed;

  const socket = useTerminalSocket(true, { onMessage, onSealed, onDisconnect });
  sendRef.current = socket.send;
  frameRef.current = socket.sendFrame;

  const selectTab = useCallback(
    (localId: string) => {
      setActiveLocalId(localId);
      const tab = tabsRef.current.find((item) => item.localId === localId);
      if (!tab || !canAttach(tab)) return;
      attach(tab);
    },
    [attach, canAttach],
  );

  const openCli = useCallback(
    (cliDeviceId: string) => {
      if (!readyRef.current) return;
      const multiViewer = cliViewersRef.current.get(cliDeviceId) ?? false;
      const tab = newTab({
        localId: newId("local"),
        terminalId: null,
        cliDeviceId,
        cols: 80,
        rows: 24,
        multiViewer,
        opener: true,
        viewerCount: 1,
      });
      viewRef.current.set(tab.localId, { multiViewer, writer: tab.writer });
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
        version: multiViewer ? 2 : 1,
      });
    },
    [beginHandshake],
  );

  const removeTab = useCallback(
    (tab: TerminalTab) => {
      const localId = tab.localId;
      pendingRef.current.delete(localId);
      if (tab.terminalId) {
        sessionsRef.current.delete(tab.terminalId);
        pendingRef.current.delete(tab.terminalId);
        attachingRef.current.delete(tab.terminalId);
        earlySealedRef.current.delete(tab.terminalId);
      }
      buffersRef.current.delete(localId);
      listenersRef.current.delete(localId);
      resettersRef.current.delete(localId);
      const batch = inputRef.current.get(localId);
      if (batch?.timer) clearTimeout(batch.timer);
      inputRef.current.delete(localId);
      clearTimer(droppedNoticeRef.current, localId);
      clearTimer(resizeTimersRef.current, localId);
      clearTimer(reattachTimersRef.current, localId);
      reattachRef.current.delete(localId);
      viewRef.current.delete(localId);
      ownSizeRef.current.delete(localId);
      lastSentSizeRef.current.delete(localId);
      pendingResizeRef.current.delete(localId);
      const remaining = tabsRef.current.filter((item) => item.localId !== localId);
      tabsRef.current = remaining;
      setTabs((current) => current.filter((item) => item.localId !== localId));
      if (activeRef.current === localId) {
        setActiveLocalId(remaining[remaining.length - 1]?.localId ?? null);
      }
    },
    [clearTimer],
  );

  const detachTab = useCallback(
    (localId: string) => {
      const tab = tabsRef.current.find((item) => item.localId === localId);
      if (!tab) return;
      if (tab.terminalId && tab.phase !== "exited" && tab.phase !== "rejected") {
        // An open that never went live has no other viewers: cancel it outright.
        const type = tab.opener && tab.phase !== "live" ? "close" : "detach";
        sendRef.current({ type, terminalId: tab.terminalId });
      }
      removeTab(tab);
    },
    [removeTab],
  );

  const endSession = useCallback(
    (localId: string) => {
      const tab = tabsRef.current.find((item) => item.localId === localId);
      if (!tab) return;
      if (tab.terminalId && tab.phase !== "exited" && tab.phase !== "rejected") {
        sendRef.current({ type: "close", terminalId: tab.terminalId });
      }
      removeTab(tab);
    },
    [removeTab],
  );

  const subscribeOutput = useCallback(
    (localId: string, listener: (event: TerminalOutputEvent) => void, reset?: () => void) => {
      listenersRef.current.set(localId, listener);
      if (reset) resettersRef.current.set(localId, reset);
      if (resetBeforeOutputRef.current.delete(localId)) reset?.();
      const queued = buffersRef.current.get(localId) ?? [];
      buffersRef.current.delete(localId);
      for (const event of queued) listener(event);
      return () => {
        if (listenersRef.current.get(localId) === listener) listenersRef.current.delete(localId);
      };
    },
    [],
  );

  const sendInput = useCallback(
    (localId: string, data: string) => {
      const tab = tabsRef.current.find((item) => item.localId === localId);
      const live = tab?.terminalId ? sessionsRef.current.has(tab.terminalId) : false;
      if (tab && live && needsTakeover(viewOf(localId))) {
        // Takeover: the CLI must see this tab's size before its first data
        // frame, so the PTY is resized before the keystroke lands. Both share
        // the per-terminal send chain, so the order holds.
        const own = ownSizeRef.current.get(localId) ?? { cols: tab.cols, rows: tab.rows };
        ownSizeRef.current.set(localId, own);
        clearTimer(resizeTimersRef.current, localId);
        setView(localId, { writer: "you" });
        lastSentSizeRef.current.set(localId, own);
        flushInput(localId);
        sendPlaintext(localId, encodeTerminalResize(own.cols, own.rows));
      }
      let batch = inputRef.current.get(localId);
      if (!batch) {
        batch = { pending: "", lastSentAt: Number.NEGATIVE_INFINITY, timer: null };
        inputRef.current.set(localId, batch);
      }
      batch.pending += data;
      const wait = INPUT_FLUSH_INTERVAL_MS - (performance.now() - batch.lastSentAt);
      if (wait <= 0 || batch.pending.length >= INPUT_BATCH_MAX_CHARS) {
        flushInput(localId);
        return;
      }
      batch.timer ??= setTimeout(() => flushInput(localId), wait);
    },
    [clearTimer, flushInput, sendPlaintext, setView, viewOf],
  );

  const sendResize = useCallback(
    (localId: string, cols: number, rows: number) => {
      const clampedCols = clampTerminalAxis(cols);
      const clampedRows = clampTerminalAxis(rows);
      if (clampedCols === null || clampedRows === null) return;
      const own = { cols: clampedCols, rows: clampedRows };
      ownSizeRef.current.set(localId, own);
      setTabs((current) => patchTab(current, localId, own));
      // A follower only records its size. It sends it when it takes over.
      if (!canSendResize(viewOf(localId))) return;
      clearTimer(resizeTimersRef.current, localId);
      resizeTimersRef.current.set(
        localId,
        setTimeout(() => flushResize(localId), TERMINAL_RESIZE_DEBOUNCE_MS),
      );
    },
    [clearTimer, flushResize, viewOf],
  );

  return {
    status: socket.status,
    identityReady: identity.ready,
    tabs,
    activeLocalId,
    selectTab,
    openCli,
    detachTab,
    endSession,
    subscribeOutput,
    sendInput,
    sendResize,
  };
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

function decodeMaybeResize(plaintext: Uint8Array): TerminalSize | null {
  if (plaintext[0] !== 0x02) return null;
  try {
    const decoded = decodeTerminalPlaintext(plaintext);
    return decoded.kind === "resize" ? { cols: decoded.cols, rows: decoded.rows } : null;
  } catch {
    return null;
  }
}
