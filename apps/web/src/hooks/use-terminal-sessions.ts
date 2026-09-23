import { useCallback, useRef, useState } from "react";
import {
  assertIncreasingTerminalSeq,
  base64UrlToBytes,
  bytesToBase64Url,
  DIRECTION_BROWSER_TO_CLI,
  DIRECTION_CLI_TO_BROWSER,
  decodeTerminalPlaintext,
  deriveTerminalSessionKeys,
  encodeTerminalData,
  encodeTerminalResize,
  generateEphemeralHandshake,
  importEcdhPublicRaw,
  openTerminalBytes,
  sealTerminalBytes,
  useTerminalIdentity,
} from "@/hooks/use-terminal-crypto";
import { type TerminalSocketStatus, useTerminalSocket } from "@/hooks/use-terminal-socket";
import { takePendingByTerminalId } from "@/lib/terminal-pending";
import {
  clampTerminalAxis,
  encodeSealedFrame,
  type TerminalClientMessage,
  type TerminalServerMessage,
} from "@/lib/terminal-protocol";

const textEncoder = new TextEncoder();
/**
 * Leading-edge input throttle per tab. The first keystroke goes out at once;
 * later ones in the same window share one frame. This keeps key repeat under
 * the server's 30 frames per second per tab.
 */
const INPUT_FLUSH_INTERVAL_MS = 50;
const INPUT_BATCH_MAX_CHARS = 16 * 1024;
const INPUT_DROPPED_NOTICE_MS = 5_000;

type InputBatch = {
  pending: string;
  lastSentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
};

export type TerminalTab = {
  localId: string;
  terminalId: string | null;
  cliDeviceId: string;
  cols: number;
  rows: number;
  phase: "opening" | "live" | "rejected" | "exited";
  approvalCode: string | null;
  rejectionReason: string | null;
  error: string | null;
};

type PendingHandshake = {
  localId: string;
  terminalId: string;
  privateKey: CryptoKey;
  browserPublicRaw: Uint8Array;
  browserNonce: Uint8Array;
};

type LiveSession = {
  localId: string;
  terminalId: string;
  browserToCli: CryptoKey;
  cliToBrowser: CryptoKey;
  sendSeq: bigint;
  recvSeq: bigint;
};

function newId(prefix: string): string {
  return `${prefix}_${bytesToBase64Url(crypto.getRandomValues(new Uint8Array(12)))}`;
}

function patchTab(
  tabs: TerminalTab[],
  localId: string,
  patch: Partial<TerminalTab>,
): TerminalTab[] {
  return tabs.map((tab) => (tab.localId === localId ? { ...tab, ...patch } : tab));
}

export function useTerminalSessions(): {
  status: TerminalSocketStatus;
  identityReady: boolean;
  tabs: TerminalTab[];
  activeLocalId: string | null;
  selectTab: (localId: string) => void;
  openCli: (cliDeviceId: string) => void;
  closeTab: (localId: string) => void;
  subscribeOutput: (
    localId: string,
    listener: (data: Uint8Array) => void,
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
  const pendingRef = useRef(new Map<string, PendingHandshake>());
  const sessionsRef = useRef(new Map<string, LiveSession>());
  const attachingRef = useRef(new Set<string>());
  const listenersRef = useRef(new Map<string, (data: Uint8Array) => void>());
  const resettersRef = useRef(new Map<string, () => void>());
  const buffersRef = useRef(new Map<string, Uint8Array[]>());
  const pendingResizeRef = useRef(new Map<string, { cols: number; rows: number }>());
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
  const earlySealedRef = useRef(
    new Map<string, { terminalId: string; seq: number; body: Uint8Array }[]>(),
  );
  const sendChainRef = useRef(new Map<string, Promise<void>>());
  const recvChainRef = useRef(new Map<string, Promise<void>>());
  const acceptSealedRef = useRef<
    (frame: { terminalId: string; seq: number; body: Uint8Array }) => void
  >(() => undefined);
  const inputRef = useRef(new Map<string, InputBatch>());
  const droppedNoticeRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const emitOutput = useCallback((localId: string, data: Uint8Array) => {
    const listener = listenersRef.current.get(localId);
    if (listener) {
      if (resetBeforeOutputRef.current.delete(localId)) resettersRef.current.get(localId)?.();
      listener(data);
      return;
    }
    const queued = buffersRef.current.get(localId) ?? [];
    queued.push(data);
    if (queued.length > 256) queued.shift();
    buffersRef.current.set(localId, queued);
  }, []);

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
        const body = await sealTerminalBytes({
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
      });
    sendChainRef.current.set(terminalId, run);
  }, []);

  const establish = useCallback(
    async (
      pending: PendingHandshake,
      message: { terminalId: string; cliPublicKey: string; cliNonce: string },
    ) => {
      const cliPublicRaw = base64UrlToBytes(message.cliPublicKey);
      const keys = await deriveTerminalSessionKeys({
        browserPrivateKey: pending.privateKey,
        cliPublicKey: await importEcdhPublicRaw(cliPublicRaw),
        browserNonce: pending.browserNonce,
        cliNonce: base64UrlToBytes(message.cliNonce),
        terminalId: message.terminalId,
        cliPublicRaw,
        browserPublicRaw: pending.browserPublicRaw,
      });
      sessionsRef.current.set(message.terminalId, {
        localId: pending.localId,
        terminalId: message.terminalId,
        browserToCli: keys.browserToCli,
        cliToBrowser: keys.cliToBrowser,
        sendSeq: 0n,
        recvSeq: 0n,
      });
      const early = earlySealedRef.current.get(message.terminalId) ?? [];
      earlySealedRef.current.delete(message.terminalId);
      for (const frame of early) acceptSealedRef.current(frame);
      pendingRef.current.delete(pending.localId);
      if (pending.terminalId) pendingRef.current.delete(pending.terminalId);
      attachingRef.current.delete(message.terminalId);
      setTabs((current) =>
        patchTab(current, pending.localId, {
          terminalId: message.terminalId,
          phase: "live",
          approvalCode: null,
          rejectionReason: null,
          error: null,
        }),
      );
      const resize = pendingResizeRef.current.get(pending.localId);
      if (resize) {
        pendingResizeRef.current.delete(pending.localId);
        sendPlaintext(pending.localId, encodeTerminalResize(resize.cols, resize.rows));
      }
    },
    [sendPlaintext],
  );

  const beginHandshake = useCallback(
    async (input: {
      localId: string;
      cliDeviceId: string;
      terminalId: string;
      cols: number;
      rows: number;
      mode: "open" | "attach";
    }) => {
      const handshake = await generateEphemeralHandshake();
      if (!tabsRef.current.some((tab) => tab.localId === input.localId)) return;
      const publicKey = publicKeyRef.current();
      const identity = publicKey ? { publicKey } : undefined;
      pendingRef.current.set(input.mode === "open" ? input.localId : input.terminalId, {
        localId: input.localId,
        terminalId: input.mode === "open" ? "" : input.terminalId,
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

  const onMessage = useCallback(
    (message: TerminalServerMessage) => {
      if (message.type === "terminals") {
        for (const cli of message.clis) cliKeysRef.current.set(cli.cliDeviceId, cli.publicKey);
        const additions: TerminalTab[] = [];
        for (const remote of message.terminals) {
          const known = tabsRef.current.find((tab) => tab.terminalId === remote.terminalId);
          if (known) {
            const pending = pendingFor(pendingRef.current, known.localId, known.terminalId);
            if (
              !sessionsRef.current.has(remote.terminalId) &&
              !pending &&
              known.phase !== "exited" &&
              known.phase !== "rejected"
            ) {
              attachingRef.current.add(remote.terminalId);
              void beginHandshake({
                mode: "attach",
                localId: known.localId,
                cliDeviceId: known.cliDeviceId,
                terminalId: remote.terminalId,
                cols: remote.cols,
                rows: remote.rows,
              });
            }
            continue;
          }
          if (additions.some((tab) => tab.terminalId === remote.terminalId)) continue;
          additions.push({
            localId: newId("local"),
            terminalId: remote.terminalId,
            cliDeviceId: remote.cliDeviceId,
            cols: remote.cols,
            rows: remote.rows,
            phase: "opening",
            approvalCode: null,
            rejectionReason: null,
            error: null,
          });
        }
        if (additions.length > 0) {
          setTabs((current) => [
            ...current,
            ...additions.filter(
              (tab) => !current.some((existing) => existing.terminalId === tab.terminalId),
            ),
          ]);
          if (!activeRef.current) setActiveLocalId(additions[0]?.localId ?? null);
        }
        for (const tab of additions) {
          if (!tab.terminalId || sessionsRef.current.has(tab.terminalId)) continue;
          attachingRef.current.add(tab.terminalId);
          void beginHandshake({
            mode: "attach",
            localId: tab.localId,
            cliDeviceId: tab.cliDeviceId,
            terminalId: tab.terminalId,
            cols: tab.cols,
            rows: tab.rows,
          });
        }
        return;
      }
      if (message.type === "opening") {
        const localId = inflightOpensRef.current.shift();
        if (!localId) return;
        const pending = pendingRef.current.get(localId);
        if (!pending) return;
        pending.terminalId = message.terminalId;
        pendingRef.current.delete(localId);
        pendingRef.current.set(message.terminalId, pending);
        setTabs((current) =>
          patchTab(current, localId, { terminalId: message.terminalId, error: null }),
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
        void signRef
          .current({
            terminalId: message.terminalId,
            browserPublicKey: pending.browserPublicRaw,
            browserNonce: pending.browserNonce,
            cliPublicKey: base64UrlToBytes(message.cliPublicKey),
            cliNonce: base64UrlToBytes(message.cliNonce),
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
        void establish(pending, message);
        return;
      }
      if (message.type === "rejected") {
        if (!message.terminalId) return;
        const pending = takePendingByTerminalId(pendingRef.current, message.terminalId);
        const localId =
          pending?.localId ??
          tabsRef.current.find((tab) => tab.terminalId === message.terminalId)?.localId;
        if (!localId) return;
        if (message.terminalId) attachingRef.current.delete(message.terminalId);
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
        const localId = tabsRef.current.find(
          (tab) => tab.terminalId === message.terminalId,
        )?.localId;
        if (!localId) return;
        setTabs((current) => patchTab(current, localId, { phase: "exited" }));
        return;
      }
      if (message.type === "detached") {
        sessionsRef.current.delete(message.terminalId);
        attachingRef.current.delete(message.terminalId);
        const localId = tabsRef.current.find(
          (tab) => tab.terminalId === message.terminalId,
        )?.localId;
        if (!localId) return;
        setTabs((current) => patchTab(current, localId, { phase: "opening", error: "detached" }));
        return;
      }
      if (!message.terminalId) return;
      const errorTerminalId = message.terminalId;
      const tab = tabsRef.current.find((item) => item.terminalId === errorTerminalId);
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
        current.map((tab) =>
          tab.localId === localId
            ? {
                ...tab,
                error: reason,
                phase: tab.phase === "opening" ? "rejected" : tab.phase,
                rejectionReason: tab.phase === "opening" ? reason : tab.rejectionReason,
              }
            : tab,
        ),
      );
    },
    [beginHandshake, establish],
  );

  const onDisconnect = useCallback(() => {
    for (const batch of inputRef.current.values()) {
      if (batch.timer) clearTimeout(batch.timer);
    }
    inputRef.current.clear();
    sessionsRef.current.clear();
    pendingRef.current.clear();
    attachingRef.current.clear();
    inflightOpensRef.current = [];
    earlySealedRef.current.clear();
    sendChainRef.current.clear();
    recvChainRef.current.clear();
    setTabs((current) =>
      current.flatMap((tab) => {
        if (!tab.terminalId && tab.phase === "opening") return [];
        if (tab.phase === "live" || tab.phase === "opening") {
          return [{ ...tab, phase: "opening" as const, error: null }];
        }
        return [tab];
      }),
    );
  }, []);

  const onSealed = useCallback(
    (frame: { terminalId: string; seq: number; body: Uint8Array }) => {
      const session = sessionsRef.current.get(frame.terminalId);
      if (!session) {
        const queued = earlySealedRef.current.get(frame.terminalId) ?? [];
        queued.push(frame);
        if (queued.length > 64) queued.shift();
        earlySealedRef.current.set(frame.terminalId, queued);
        return;
      }
      const seq = BigInt(frame.seq);
      const previous = recvChainRef.current.get(frame.terminalId) ?? Promise.resolve();
      const run = previous
        .catch(() => undefined)
        .then(async () => {
          const current = sessionsRef.current.get(frame.terminalId);
          if (!current) return;
          try {
            assertIncreasingTerminalSeq(current.recvSeq, seq);
          } catch {
            return;
          }
          const plaintext = await openTerminalBytes({
            key: current.cliToBrowser,
            terminalId: frame.terminalId,
            direction: DIRECTION_CLI_TO_BROWSER,
            seq,
            ciphertext: frame.body,
          });
          if (current.recvSeq >= seq) return;
          current.recvSeq = seq;
          const decoded = decodeTerminalPlaintext(plaintext);
          if (decoded.kind === "data") emitOutput(current.localId, decoded.data);
        });
      recvChainRef.current.set(frame.terminalId, run);
    },
    [emitOutput],
  );
  acceptSealedRef.current = onSealed;

  const socket = useTerminalSocket(true, { onMessage, onSealed, onDisconnect });
  sendRef.current = socket.send;
  frameRef.current = socket.sendFrame;

  const selectTab = useCallback(
    (localId: string) => {
      setActiveLocalId(localId);
      const tab = tabsRef.current.find((item) => item.localId === localId);
      if (!tab?.terminalId || tab.phase === "exited" || tab.phase === "rejected") return;
      if (
        sessionsRef.current.has(tab.terminalId) ||
        pendingFor(pendingRef.current, tab.localId, tab.terminalId)
      ) {
        return;
      }
      attachingRef.current.add(tab.terminalId);
      void beginHandshake({
        mode: "attach",
        localId: tab.localId,
        cliDeviceId: tab.cliDeviceId,
        terminalId: tab.terminalId,
        cols: tab.cols,
        rows: tab.rows,
      });
    },
    [beginHandshake],
  );

  const openCli = useCallback(
    (cliDeviceId: string) => {
      if (!readyRef.current) return;
      const localId = newId("local");
      const tab: TerminalTab = {
        localId,
        terminalId: null,
        cliDeviceId,
        cols: 80,
        rows: 24,
        phase: "opening",
        approvalCode: null,
        rejectionReason: null,
        error: null,
      };
      setTabs((current) => [...current, tab]);
      setActiveLocalId(localId);
      void beginHandshake({
        mode: "open",
        localId,
        cliDeviceId,
        terminalId: "",
        cols: tab.cols,
        rows: tab.rows,
      });
    },
    [beginHandshake],
  );

  const closeTab = useCallback((localId: string) => {
    const tab = tabsRef.current.find((item) => item.localId === localId);
    if (!tab) return;
    if (tab.terminalId && tab.phase !== "exited" && tab.phase !== "rejected") {
      sendRef.current({ type: "close", terminalId: tab.terminalId });
    }
    pendingRef.current.delete(localId);
    if (tab.terminalId) {
      sessionsRef.current.delete(tab.terminalId);
      pendingRef.current.delete(tab.terminalId);
      attachingRef.current.delete(tab.terminalId);
    }
    buffersRef.current.delete(localId);
    listenersRef.current.delete(localId);
    const batch = inputRef.current.get(localId);
    if (batch?.timer) clearTimeout(batch.timer);
    inputRef.current.delete(localId);
    const notice = droppedNoticeRef.current.get(localId);
    if (notice) clearTimeout(notice);
    droppedNoticeRef.current.delete(localId);
    const remaining = tabsRef.current.filter((item) => item.localId !== localId);
    setTabs(remaining);
    if (activeRef.current === localId) {
      setActiveLocalId(remaining[remaining.length - 1]?.localId ?? null);
    }
  }, []);

  const subscribeOutput = useCallback(
    (localId: string, listener: (data: Uint8Array) => void, reset?: () => void) => {
      listenersRef.current.set(localId, listener);
      if (reset) resettersRef.current.set(localId, reset);
      if (resetBeforeOutputRef.current.delete(localId)) reset?.();
      const queued = buffersRef.current.get(localId) ?? [];
      buffersRef.current.delete(localId);
      for (const chunk of queued) listener(chunk);
      return () => {
        if (listenersRef.current.get(localId) === listener) listenersRef.current.delete(localId);
      };
    },
    [],
  );

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

  const sendInput = useCallback(
    (localId: string, data: string) => {
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
    [flushInput],
  );

  const sendResize = useCallback(
    (localId: string, cols: number, rows: number) => {
      const clampedCols = clampTerminalAxis(cols);
      const clampedRows = clampTerminalAxis(rows);
      if (clampedCols === null || clampedRows === null) return;
      cols = clampedCols;
      rows = clampedRows;
      setTabs((current) => patchTab(current, localId, { cols, rows }));
      // Keep typed input ahead of the resize, in the order the user made them.
      flushInput(localId);
      sendPlaintext(localId, encodeTerminalResize(cols, rows));
    },
    [flushInput, sendPlaintext],
  );

  return {
    status: socket.status,
    identityReady: identity.ready,
    tabs,
    activeLocalId,
    selectTab,
    openCli,
    closeTab,
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

function decodeMaybeResize(plaintext: Uint8Array): { cols: number; rows: number } | null {
  if (plaintext[0] !== 0x02) return null;
  try {
    const decoded = decodeTerminalPlaintext(plaintext);
    return decoded.kind === "resize" ? { cols: decoded.cols, rows: decoded.rows } : null;
  } catch {
    return null;
  }
}
