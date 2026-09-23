// @vitest-environment jsdom

import { webcrypto } from "node:crypto";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  base64UrlToBytes,
  bytesToBase64Url,
  DIRECTION_BROWSER_TO_CLI,
  DIRECTION_CLI_TO_BROWSER,
  decodeTerminalPlaintext,
  deriveTerminalSessionKeys,
  deriveTerminalSessionKeysV2,
  encodeTerminalData,
  encodeTerminalOutputKey,
  encodeTerminalResize,
  generateEphemeralHandshake,
  importEcdhPublicRaw,
  importTerminalOutputKey,
  openTerminalBytes,
  openTerminalBytesV2,
  sealTerminalBroadcast,
  sealTerminalBytes,
  sealTerminalBytesV2,
  type TerminalSessionKeys,
} from "@/hooks/use-terminal-crypto";
import type { TerminalSocketHandlers } from "@/hooks/use-terminal-socket";
import { decodeSealedFrame, type TerminalClientMessage } from "@/lib/terminal-protocol";

import { type TerminalOutputEvent, useTerminalSessions } from "./use-terminal-sessions";

const socket = vi.hoisted(() => ({
  handlers: null as TerminalSocketHandlers | null,
  send: vi.fn<(message: TerminalClientMessage) => void>(),
  sendFrame: vi.fn<(frame: ArrayBuffer) => void>(),
}));

const identity = vi.hoisted(() => ({
  ready: true,
  publicKey: () => null,
  sign: async () => null,
}));

vi.mock("@/hooks/use-terminal-socket", () => ({
  useTerminalSocket: (_enabled: boolean, handlers: TerminalSocketHandlers) => {
    socket.handlers = handlers;
    return { status: "open", send: socket.send, sendFrame: socket.sendFrame };
  },
}));

vi.mock("@/hooks/use-terminal-crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-terminal-crypto")>();
  return { ...actual, useTerminalIdentity: () => identity };
});

const TERMINAL_ID = "dGVybWluYWwtaWQtMDAwMQ";
const VIEWER_ID = "dmlld2VyLWlkLTAwMDAwMQ";
const CLI_ID = "cli-1";
const decoder = new TextDecoder();

beforeAll(() => {
  // jsdom has no SubtleCrypto; the hook and the fake CLI both use Node's.
  vi.stubGlobal("crypto", webcrypto);
});

afterEach(() => {
  cleanup();
  socket.handlers = null;
  socket.send.mockReset();
  socket.sendFrame.mockReset();
});

function handlers(): TerminalSocketHandlers {
  if (!socket.handlers) throw new Error("socket handlers are not registered");
  return socket.handlers;
}

function message(value: Parameters<TerminalSocketHandlers["onMessage"]>[0]) {
  act(() => handlers().onMessage(value));
}

function sentOfType<T extends TerminalClientMessage["type"]>(type: T) {
  return socket.send.mock.calls
    .map(([entry]) => entry)
    .filter((entry): entry is Extract<TerminalClientMessage, { type: T }> => entry.type === type);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Cli = {
  keys: TerminalSessionKeys;
  unicastSeq: bigint;
  viewerId: string | null;
};

/** Plays the CLI side of an attach: derive keys, then `attaching` / `attached`. */
async function attachAsCli(viewerId: string | null, attachIndex = 0): Promise<Cli> {
  const attach = await waitFor(() => {
    const entry = sentOfType("attach")[attachIndex];
    expect(entry).toBeTruthy();
    if (!entry) throw new Error("no attach");
    return entry;
  });
  const cli = await generateEphemeralHandshake();
  const cliNonce = crypto.getRandomValues(new Uint8Array(16));
  const browserPublicRaw = base64UrlToBytes(attach.publicKey);
  const args = {
    browserPrivateKey: cli.privateKey,
    cliPublicKey: await importEcdhPublicRaw(browserPublicRaw),
    browserNonce: base64UrlToBytes(attach.nonce),
    cliNonce,
    terminalId: TERMINAL_ID,
    cliPublicRaw: cli.publicKeyRaw,
    browserPublicRaw,
  };
  const keys = viewerId
    ? await deriveTerminalSessionKeysV2({ ...args, viewerId })
    : await deriveTerminalSessionKeys(args);
  // The 2.5 server names the viewer for 2.4 terminals too; v1 crypto ignores it.
  message({ type: "attaching", terminalId: TERMINAL_ID, viewerId: viewerId ?? VIEWER_ID });
  message({
    type: "attached",
    terminalId: TERMINAL_ID,
    cliPublicKey: bytesToBase64Url(cli.publicKeyRaw),
    cliNonce: bytesToBase64Url(cliNonce),
  });
  return { keys, unicastSeq: 0n, viewerId };
}

async function unicast(cli: Cli, plaintext: Uint8Array) {
  cli.unicastSeq += 1n;
  const seq = cli.unicastSeq;
  const body = cli.viewerId
    ? await sealTerminalBytesV2({
        key: cli.keys.cliToBrowser,
        terminalId: TERMINAL_ID,
        viewerId: cli.viewerId,
        direction: DIRECTION_CLI_TO_BROWSER,
        seq,
        plaintext,
      })
    : await sealTerminalBytes({
        key: cli.keys.cliToBrowser,
        terminalId: TERMINAL_ID,
        direction: DIRECTION_CLI_TO_BROWSER,
        seq,
        plaintext,
      });
  act(() => handlers().onSealed({ terminalId: TERMINAL_ID, seq: Number(seq), body }));
}

async function broadcast(outKey: Uint8Array, epoch: number, seq: number, text: string) {
  const body = await sealTerminalBroadcast({
    key: await importTerminalOutputKey(outKey),
    terminalId: TERMINAL_ID,
    epoch,
    seq: BigInt(seq),
    plaintext: encodeTerminalData(new TextEncoder().encode(text)),
  });
  act(() => handlers().onSealed({ terminalId: TERMINAL_ID, seq, epoch, body }));
}

/** Browser frames as the CLI would open them. */
async function browserFrames(cli: Cli) {
  const frames = [];
  for (const [frame] of socket.sendFrame.mock.calls) {
    const decoded = decodeSealedFrame(frame);
    const seq = BigInt(decoded.seq);
    const plaintext = cli.viewerId
      ? await openTerminalBytesV2({
          key: cli.keys.browserToCli,
          terminalId: TERMINAL_ID,
          viewerId: cli.viewerId,
          direction: DIRECTION_BROWSER_TO_CLI,
          seq,
          ciphertext: decoded.body,
        })
      : await openTerminalBytes({
          key: cli.keys.browserToCli,
          terminalId: TERMINAL_ID,
          direction: DIRECTION_BROWSER_TO_CLI,
          seq,
          ciphertext: decoded.body,
        });
    const message = decodeTerminalPlaintext(plaintext);
    // Compare text, not Uint8Array: jsdom and Node each have their own.
    frames.push(
      message.kind === "data"
        ? { seq: decoded.seq, data: decoder.decode(message.data) }
        : { seq: decoded.seq, resize: [message.cols, message.rows] },
    );
  }
  return frames;
}

function outputText(events: TerminalOutputEvent[]): string {
  return events
    .flatMap((event) => (event.kind === "data" ? [decoder.decode(event.data)] : []))
    .join("");
}

async function setup(multiViewer: boolean) {
  const view = renderHook(() => useTerminalSessions());
  message({
    type: "terminals",
    clis: [{ cliDeviceId: CLI_ID, publicKey: null, terminalViewers: multiViewer }],
    terminals: [
      {
        terminalId: TERMINAL_ID,
        cliDeviceId: CLI_ID,
        cols: 80,
        rows: 24,
        viewerCount: 1,
        attachedHere: false,
        writerHere: false,
        viewerAttached: multiViewer,
      },
    ],
  });
  const cli = await attachAsCli(multiViewer ? VIEWER_ID : null);
  await waitFor(() => expect(view.result.current.tabs[0]?.phase).toBe("live"));
  const tab = view.result.current.tabs[0];
  if (!tab) throw new Error("no tab");
  const events: TerminalOutputEvent[] = [];
  act(() => {
    view.result.current.subscribeOutput(tab.localId, (event) => events.push(event));
  });
  return { view, cli, localId: tab.localId, events };
}

async function setupV2() {
  const context = await setup(true);
  const outKey = crypto.getRandomValues(new Uint8Array(32));
  await unicast(context.cli, encodeTerminalOutputKey(1, outKey));
  await unicast(context.cli, encodeTerminalResize(120, 40));
  await unicast(context.cli, encodeTerminalData(new TextEncoder().encode("hello ")));
  return { ...context, outKey };
}

describe("useTerminalSessions (protocol 2.5)", () => {
  it("decrypts broadcast frames after the unicast output key and PTY size", async () => {
    const { view, events, outKey } = await setupV2();
    await broadcast(outKey, 1, 1, "world");
    await waitFor(() => expect(outputText(events)).toBe("hello world"));
    expect(events).toContainEqual({ kind: "size", cols: 120, rows: 40 });
    await waitFor(() => {
      expect(view.result.current.tabs[0]).toMatchObject({ ptyCols: 120, ptyRows: 40 });
    });
  });

  it("updates the writer and viewer count from a viewers message", async () => {
    const { view } = await setupV2();
    message({ type: "viewers", terminalId: TERMINAL_ID, count: 3, writer: "other" });
    expect(view.result.current.tabs[0]).toMatchObject({ writer: "other", viewerCount: 3 });
    message({ type: "viewers", terminalId: TERMINAL_ID, count: 2, writer: "you" });
    expect(view.result.current.tabs[0]).toMatchObject({ writer: "you", viewerCount: 2 });
  });

  it("sends nothing when a follower's box is fitted", async () => {
    const { view, localId } = await setupV2();
    message({ type: "viewers", terminalId: TERMINAL_ID, count: 2, writer: "other" });
    act(() => view.result.current.sendResize(localId, 100, 30));
    await sleep(200);
    expect(socket.sendFrame).not.toHaveBeenCalled();
    expect(view.result.current.tabs[0]).toMatchObject({ cols: 100, rows: 30 });
  });

  it("takes over on input: own-size resize first, then data, with increasing seq", async () => {
    const { view, cli, localId } = await setupV2();
    message({ type: "viewers", terminalId: TERMINAL_ID, count: 2, writer: "other" });
    act(() => view.result.current.sendResize(localId, 100, 30));
    act(() => view.result.current.sendInput(localId, "ls"));
    expect(view.result.current.tabs[0]?.writer).toBe("you");
    await waitFor(() => expect(socket.sendFrame).toHaveBeenCalledTimes(2));
    const frames = await browserFrames(cli);
    expect(frames).toEqual([
      { seq: 1, resize: [100, 30] },
      { seq: 2, data: "ls" },
    ]);
    // A second keystroke does not resize again.
    await sleep(60);
    act(() => view.result.current.sendInput(localId, "\r"));
    await waitFor(() => expect(socket.sendFrame).toHaveBeenCalledTimes(3));
    const [, , third] = await browserFrames(cli);
    expect(third).toEqual({ seq: 3, data: "\r" });
  });

  it("debounces the writer's resizes into one frame", async () => {
    const { view, cli, localId } = await setupV2();
    message({ type: "viewers", terminalId: TERMINAL_ID, count: 1, writer: "you" });
    act(() => view.result.current.sendResize(localId, 90, 30));
    act(() => view.result.current.sendResize(localId, 91, 31));
    act(() => view.result.current.sendResize(localId, 92, 32));
    await sleep(200);
    await waitFor(() => expect(socket.sendFrame).toHaveBeenCalledTimes(1));
    expect(await browserFrames(cli)).toEqual([{ seq: 1, resize: [92, 32] }]);
  });

  it("rotates the epoch: queues an unknown epoch and drops the old one", async () => {
    const { cli, events, outKey } = await setupV2();
    await broadcast(outKey, 1, 1, "a");
    const nextKey = crypto.getRandomValues(new Uint8Array(32));
    // Epoch 2 output arrives before its key: it waits in the queue.
    await broadcast(nextKey, 2, 1, "b");
    await sleep(20);
    expect(outputText(events)).toBe("hello a");
    await unicast(cli, encodeTerminalOutputKey(2, nextKey));
    await waitFor(() => expect(outputText(events)).toBe("hello ab"));
    // The old epoch is gone once the new key is held.
    await broadcast(outKey, 1, 2, "stale");
    await broadcast(nextKey, 2, 2, "c");
    await waitFor(() => expect(outputText(events)).toBe("hello abc"));
    // A replayed broadcast seq is ignored.
    await broadcast(nextKey, 2, 2, "again");
    await sleep(20);
    expect(outputText(events)).toBe("hello abc");
  });

  it("reattaches with backoff after a slow detach", async () => {
    const { view } = await setupV2();
    expect(sentOfType("attach")).toHaveLength(1);
    message({ type: "detached", terminalId: TERMINAL_ID, reason: "slow" });
    expect(view.result.current.tabs[0]).toMatchObject({ phase: "opening", error: "slow" });
    await waitFor(() => expect(sentOfType("attach")).toHaveLength(2), { timeout: 3_000 });
    await attachAsCli(VIEWER_ID, 1);
    await waitFor(() =>
      expect(view.result.current.tabs[0]).toMatchObject({ phase: "live", error: null }),
    );
  });

  it("sends detach for the X button and close for End session", async () => {
    const { view, localId } = await setupV2();
    act(() => view.result.current.detachTab(localId));
    expect(sentOfType("detach")).toEqual([{ type: "detach", terminalId: TERMINAL_ID }]);
    expect(sentOfType("close")).toEqual([]);
    expect(view.result.current.tabs).toEqual([]);
  });

  it("sends close for End session", async () => {
    const { view, localId } = await setupV2();
    act(() => view.result.current.endSession(localId));
    expect(sentOfType("close")).toEqual([{ type: "close", terminalId: TERMINAL_ID }]);
    expect(sentOfType("detach")).toEqual([]);
  });
});

describe("useTerminalSessions (protocol 2.4)", () => {
  it("keeps the v1 path: output decrypts and input goes out under v1 keys", async () => {
    const { view, cli, localId, events } = await setup(false);
    expect(view.result.current.tabs[0]).toMatchObject({ multiViewer: false, writer: "you" });
    await unicast(cli, encodeTerminalData(new TextEncoder().encode("legacy")));
    await waitFor(() => expect(outputText(events)).toBe("legacy"));
    act(() => view.result.current.sendInput(localId, "x"));
    await waitFor(() => expect(socket.sendFrame).toHaveBeenCalledTimes(1));
    act(() => view.result.current.sendResize(localId, 100, 30));
    await waitFor(() => expect(socket.sendFrame).toHaveBeenCalledTimes(2));
    expect(await browserFrames(cli)).toEqual([
      { seq: 1, data: "x" },
      { seq: 2, resize: [100, 30] },
    ]);
  });

  it("does not steal a 2.4 terminal another tab is viewing until selected", async () => {
    const view = renderHook(() => useTerminalSessions());
    message({
      type: "terminals",
      clis: [{ cliDeviceId: CLI_ID, publicKey: null, terminalViewers: false }],
      terminals: [
        {
          terminalId: TERMINAL_ID,
          cliDeviceId: CLI_ID,
          cols: 80,
          rows: 24,
          viewerCount: 1,
          attachedHere: false,
          writerHere: false,
          viewerAttached: true,
        },
      ],
    });
    await sleep(50);
    expect(sentOfType("attach")).toEqual([]);
    const tab = view.result.current.tabs[0];
    expect(tab?.error).toBe("detached");
    act(() => view.result.current.selectTab(tab?.localId ?? ""));
    await waitFor(() => expect(sentOfType("attach")).toHaveLength(1));
  });
});
