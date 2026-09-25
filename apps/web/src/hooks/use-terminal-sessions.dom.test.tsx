// @vitest-environment jsdom

import { webcrypto } from "node:crypto";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { TERMINAL_BROWSER_JSON_WINDOW_MS } from "@ws-model-proxy/config/terminal-socket-policy";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  base64UrlToBytes,
  buildCliIdentityStatement,
  bytesToBase64Url,
  cliIdentityFingerprint,
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
import type { TerminalSendResult, TerminalSocketHandlers } from "@/hooks/use-terminal-socket";
import { createMemoryCliPinStore } from "@/lib/terminal-cli-identity";
import {
  decodeSealedFrame,
  type ListedCli,
  type SealedTerminalFrame,
  type TerminalClientMessage,
} from "@/lib/terminal-protocol";

import {
  agentInputAllowed,
  TERMINAL_GONE,
  type TerminalOutputEvent,
  type TerminalTab,
  useTerminalSessions,
} from "./use-terminal-sessions";

const socket = vi.hoisted(() => ({
  handlers: null as TerminalSocketHandlers | null,
  /** What the socket did with the message; `sent` unless a test says otherwise. */
  send: vi.fn<(message: TerminalClientMessage) => TerminalSendResult>(() => "sent"),
  sendFrame: vi.fn<(frame: ArrayBuffer) => void>(),
}));

const identity = vi.hoisted(() => ({
  ready: true,
  publicKey: () => null,
  sign: async () => null,
}));

vi.mock("@/hooks/use-terminal-socket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-terminal-socket")>()),
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
const CLI_SLUG = "desk-01";
const decoder = new TextDecoder();

beforeAll(() => {
  // jsdom has no SubtleCrypto; the hook and the fake CLI both use Node's.
  vi.stubGlobal("crypto", webcrypto);
});

afterEach(() => {
  cleanup();
  currentCli = null;
  socket.handlers = null;
  identity.ready = true;
  socket.send.mockReset();
  socket.send.mockImplementation(() => "sent");
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

/** `openCli` first asks for a fresh CLI list; answer it as the relay would. */
async function openAfterList(open: () => void, clis: ListedCli[]) {
  const before = sentOfType("list").length;
  act(open);
  await waitFor(() => expect(sentOfType("list")).toHaveLength(before + 1));
  message({ type: "terminals", clis, terminals: [] });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Cli = {
  keys: TerminalSessionKeys;
  unicastSeq: bigint;
  viewerId: string | null;
};

type CliKey = Awaited<ReturnType<typeof generateEphemeralHandshake>>;

/** The fake CLI's daemon-lifetime ECDH key, and its identity signing key. */
type FakeCli = {
  ecdh: CliKey;
  identityPublicKey: string;
  sign: (ecdhPublicRaw: Uint8Array, slug?: string) => Promise<string>;
};

async function fakeCli(): Promise<FakeCli> {
  const ecdh = await generateEphemeralHandshake();
  const identity = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const identityRaw = new Uint8Array(await crypto.subtle.exportKey("raw", identity.publicKey));
  return {
    ecdh,
    identityPublicKey: bytesToBase64Url(identityRaw),
    sign: async (ecdhPublicRaw, slug = CLI_SLUG) =>
      bytesToBase64Url(
        new Uint8Array(
          await crypto.subtle.sign(
            { name: "ECDSA", hash: "SHA-256" },
            identity.privateKey,
            Uint8Array.from(buildCliIdentityStatement(slug, ecdhPublicRaw)),
          ),
        ),
      ),
  };
}

let currentCli: FakeCli | null = null;

function requireCli(): FakeCli {
  if (!currentCli) throw new Error("no fake CLI");
  return currentCli;
}

/** The relay's `clis` entry for the fake CLI: signed on 2.5, bare on 2.4. */
async function listedCli(cli: FakeCli, multiViewer: boolean): Promise<ListedCli> {
  const publicKey = bytesToBase64Url(cli.ecdh.publicKeyRaw);
  return {
    cliDeviceId: CLI_ID,
    slug: CLI_SLUG,
    publicKey,
    terminalViewers: multiViewer,
    identityPublicKey: multiViewer ? cli.identityPublicKey : null,
    identitySignature: multiViewer ? await cli.sign(cli.ecdh.publicKeyRaw) : null,
  };
}

function listedTerminal(viewerAttached: boolean) {
  return {
    origin: "user" as const,
    supervised: null,
    terminalId: TERMINAL_ID,
    cliDeviceId: CLI_ID,
    cols: 80,
    rows: 24,
    viewerCount: 1,
    attachedHere: false,
    writerHere: false,
    viewerAttached,
  };
}

/** Plays the CLI side of an attach: derive keys, then `attaching` / `attached`. */
async function attachAsCli(
  viewerId: string | null,
  attachIndex = 0,
  answerWith?: CliKey,
  /** Runs in the same act as `attached`, before the browser derives keys. */
  afterAttached?: (cli: Cli) => void,
  /** Frames sealed ahead, delivered right after `attached` (before `afterAttached`). */
  sealEarly?: (cli: Cli) => Promise<SealedTerminalFrame[]>,
): Promise<Cli> {
  const attach = await waitFor(() => {
    const entry = sentOfType("attach")[attachIndex];
    expect(entry).toBeTruthy();
    if (!entry) throw new Error("no attach");
    return entry;
  });
  const cli = answerWith ?? requireCli().ecdh;
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
  const state: Cli = { keys, unicastSeq: 0n, viewerId };
  const early = sealEarly ? await sealEarly(state) : [];
  // The 2.5 server names the viewer for 2.4 terminals too; v1 crypto ignores it.
  message({ type: "attaching", terminalId: TERMINAL_ID, viewerId: viewerId ?? VIEWER_ID });
  act(() => {
    handlers().onMessage({
      type: "attached",
      terminalId: TERMINAL_ID,
      cliPublicKey: bytesToBase64Url(cli.publicKeyRaw),
      cliNonce: bytesToBase64Url(cliNonce),
    });
    for (const frame of early) handlers().onSealed(frame);
    afterAttached?.(state);
  });
  return state;
}

async function sealUnicast(cli: Cli, plaintext: Uint8Array): Promise<SealedTerminalFrame> {
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
  return { terminalId: TERMINAL_ID, seq: Number(seq), body };
}

async function unicast(cli: Cli, plaintext: Uint8Array) {
  const frame = await sealUnicast(cli, plaintext);
  act(() => handlers().onSealed(frame));
}

async function sealBroadcast(
  outKey: Uint8Array,
  epoch: number,
  seq: number,
  text: string,
): Promise<SealedTerminalFrame> {
  const body = await sealTerminalBroadcast({
    key: await importTerminalOutputKey(outKey),
    terminalId: TERMINAL_ID,
    epoch,
    seq: BigInt(seq),
    plaintext: encodeTerminalData(new TextEncoder().encode(text)),
  });
  return { terminalId: TERMINAL_ID, seq, epoch, body };
}

async function broadcast(outKey: Uint8Array, epoch: number, seq: number, text: string) {
  const frame = await sealBroadcast(outKey, epoch, seq, text);
  act(() => handlers().onSealed(frame));
}

function text(value: string): Uint8Array {
  return encodeTerminalData(new TextEncoder().encode(value));
}

/** A tab for the listed terminal, with output collected from the start. */
async function listAndSubscribe() {
  currentCli = await fakeCli();
  const view = renderHook(() => useTerminalSessions({ pinStore: createMemoryCliPinStore() }));
  message({
    type: "terminals",
    clis: [await listedCli(currentCli, true)],
    terminals: [listedTerminal(true)],
  });
  const localId = view.result.current.tabs[0]?.localId;
  if (!localId) throw new Error("no tab");
  const events: TerminalOutputEvent[] = [];
  act(() => {
    view.result.current.subscribeOutput(localId, (event) => events.push(event));
  });
  return { view, localId, events };
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

async function setup(multiViewer: boolean, pinStore = createMemoryCliPinStore()) {
  currentCli = await fakeCli();
  const view = renderHook(() => useTerminalSessions({ pinStore }));
  message({
    type: "terminals",
    clis: [await listedCli(currentCli, multiViewer)],
    terminals: [listedTerminal(multiViewer)],
  });
  const cli = await attachAsCli(multiViewer ? VIEWER_ID : null);
  await waitFor(() => expect(view.result.current.tabs[0]?.phase).toBe("live"));
  const tab = view.result.current.tabs[0];
  if (!tab) throw new Error("no tab");
  const events: TerminalOutputEvent[] = [];
  act(() => {
    view.result.current.subscribeOutput(tab.localId, (event) => events.push(event));
  });
  return { view, cli, localId: tab.localId, events, pinStore };
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
    expect(sentOfType("close")).toEqual([
      { type: "close", terminalId: TERMINAL_ID, requestId: expect.any(String) },
    ]);
    expect(sentOfType("detach")).toEqual([]);
  });
});

describe("useTerminalSessions End session until the relay confirms", () => {
  beforeEach(async () => {
    // Handshakes of the previous test may still finish on the shared socket mock.
    await sleep(150);
    socket.send.mockReset();
    socket.send.mockImplementation(() => "sent");
    socket.sendFrame.mockReset();
  });

  function closes() {
    return sentOfType("close");
  }

  it("keeps the tab ending (and deaf to keys) until `closed`, then removes it", async () => {
    const { view, localId } = await setupV2();
    act(() => view.result.current.endSession(localId));
    expect(view.result.current.tabs).toEqual([
      expect.objectContaining({ localId, ending: "pending" }),
    ]);
    act(() => view.result.current.sendInput(localId, "ls\r"));
    await sleep(80);
    expect(socket.sendFrame).not.toHaveBeenCalled();
    // Pressing it again does not send a second close while one is out.
    act(() => view.result.current.endSession(localId));
    expect(closes()).toHaveLength(1);
    message({ type: "closed", terminalId: TERMINAL_ID, requestId: closes()[0]?.requestId ?? null });
    expect(view.result.current.tabs).toEqual([]);
  });

  it("sends a close lost with its socket again when the next list still has the terminal", async () => {
    const { view, localId } = await setupV2();
    const listed = await listedCli(requireCli(), true);
    // The socket takes the close into its queue, then closes before it left.
    socket.send.mockImplementation((entry) => (entry.type === "close" ? "queued" : "sent"));
    act(() => view.result.current.endSession(localId));
    const attaches = sentOfType("attach").length;
    act(() => handlers().onDisconnect?.());
    expect(view.result.current.tabs[0]).toMatchObject({ localId, ending: "pending" });
    act(() => handlers().onOpen?.());
    message({ type: "terminals", clis: [listed], terminals: [listedTerminal(true)] });
    expect(closes()).toHaveLength(2);
    expect(closes()[1]?.requestId).not.toBe(closes()[0]?.requestId);
    // No viewer slot is taken again for a terminal being ended.
    await sleep(50);
    expect(sentOfType("attach")).toHaveLength(attaches);
    expect(view.result.current.tabs[0]).toMatchObject({ localId, ending: "pending" });
    // An answer to the lost close changes nothing; the exit does.
    message({ type: "exit", terminalId: TERMINAL_ID, exitCode: 0, signal: null });
    expect(view.result.current.tabs).toEqual([]);
  });

  it("removes the tab when the list after a reconnect no longer has the terminal", async () => {
    const { view, localId } = await setupV2();
    const listed = await listedCli(requireCli(), true);
    act(() => view.result.current.endSession(localId));
    act(() => handlers().onDisconnect?.());
    act(() => handlers().onOpen?.());
    message({ type: "terminals", clis: [listed], terminals: [] });
    expect(view.result.current.tabs).toEqual([]);
    expect(closes()).toHaveLength(1);
  });

  it("sends it on the next socket when no socket took it", async () => {
    const { view, localId } = await setupV2();
    const listed = await listedCli(requireCli(), true);
    socket.send.mockImplementation(() => "closed");
    act(() => view.result.current.endSession(localId));
    expect(view.result.current.tabs[0]).toMatchObject({ localId, ending: "pending" });
    socket.send.mockImplementation(() => "sent");
    act(() => handlers().onDisconnect?.());
    act(() => handlers().onOpen?.());
    message({ type: "terminals", clis: [listed], terminals: [listedTerminal(true)] });
    expect(closes()).toHaveLength(2);
    message({ type: "closed", terminalId: TERMINAL_ID, requestId: closes()[1]?.requestId ?? null });
    expect(view.result.current.tabs).toEqual([]);
  });

  it("answers the relay: not_found ends the tab, rate_limited and a full queue retry, others show", async () => {
    const { view, localId } = await setupV2();
    vi.useFakeTimers();
    try {
      act(() => view.result.current.endSession(localId));
      // Refused unread for rate: sent again after one window, with a fresh id.
      message({
        type: "error",
        terminalId: TERMINAL_ID,
        requestId: closes()[0]?.requestId,
        code: "rate_limited",
        message: "",
      });
      expect(closes()).toHaveLength(1);
      act(() => vi.advanceTimersByTime(TERMINAL_BROWSER_JSON_WINDOW_MS));
      expect(closes()).toHaveLength(2);
      // Refused for another reason: the tab says so and End session works again.
      message({
        type: "error",
        terminalId: TERMINAL_ID,
        requestId: closes()[1]?.requestId,
        code: "invalid",
        message: "",
      });
      expect(view.result.current.tabs[0]).toMatchObject({ localId, ending: "failed" });
      // The socket's queue is full: kept, and sent once a window has passed.
      socket.send.mockImplementation(() => "full");
      act(() => view.result.current.endSession(localId));
      expect(view.result.current.tabs[0]).toMatchObject({ localId, ending: "pending" });
      socket.send.mockImplementation(() => "sent");
      act(() => vi.advanceTimersByTime(TERMINAL_BROWSER_JSON_WINDOW_MS));
      expect(closes()).toHaveLength(4);
      // Gone already: nothing left to end.
      message({
        type: "error",
        terminalId: TERMINAL_ID,
        requestId: closes()[3]?.requestId,
        code: "not_found",
        message: "",
      });
      expect(view.result.current.tabs).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps closing an unopened shell closed with X across a reconnect, without showing it again", async () => {
    currentCli = await fakeCli();
    const view = renderHook(() => useTerminalSessions({ pinStore: createMemoryCliPinStore() }));
    const listed = await listedCli(currentCli, true);
    message({ type: "terminals", clis: [listed], terminals: [] });
    await openAfterList(() => view.result.current.openCli(CLI_ID), [listed]);
    await waitFor(() => expect(sentOfType("open")).toHaveLength(1));
    const open = sentOfType("open")[0];
    message({
      type: "opening",
      terminalId: TERMINAL_ID,
      viewerId: VIEWER_ID,
      requestId: open?.requestId,
    });
    const localId = view.result.current.tabs[0]?.localId ?? "";
    // X before it went live cancels the shell; the tab goes at once.
    act(() => view.result.current.detachTab(localId));
    expect(view.result.current.tabs).toEqual([]);
    expect(closes()).toHaveLength(1);
    act(() => handlers().onDisconnect?.());
    act(() => handlers().onOpen?.());
    message({ type: "terminals", clis: [listed], terminals: [listedTerminal(false)] });
    expect(closes()).toHaveLength(2);
    expect(view.result.current.tabs).toEqual([]);
    expect(sentOfType("attach")).toEqual([]);
    message({ type: "closed", terminalId: TERMINAL_ID, requestId: closes()[1]?.requestId ?? null });
    message({ type: "terminals", clis: [listed], terminals: [] });
    expect(closes()).toHaveLength(2);
  });

  it("brings a shell no tab shows back as a tab when the relay refuses its close", async () => {
    currentCli = await fakeCli();
    const view = renderHook(() => useTerminalSessions({ pinStore: createMemoryCliPinStore() }));
    const listed = await listedCli(currentCli, true);
    message({ type: "terminals", clis: [listed], terminals: [] });
    await openAfterList(() => view.result.current.openCli(CLI_ID), [listed]);
    await waitFor(() => expect(sentOfType("open")).toHaveLength(1));
    message({
      type: "opening",
      terminalId: TERMINAL_ID,
      viewerId: VIEWER_ID,
      requestId: sentOfType("open")[0]?.requestId,
    });
    act(() => view.result.current.detachTab(view.result.current.tabs[0]?.localId ?? ""));
    const lists = sentOfType("list").length;
    message({
      type: "error",
      terminalId: TERMINAL_ID,
      requestId: closes()[0]?.requestId,
      code: "invalid",
      message: "",
    });
    expect(sentOfType("list")).toHaveLength(lists + 1);
    message({ type: "terminals", clis: [listed], terminals: [listedTerminal(false)] });
    expect(view.result.current.tabs).toEqual([
      expect.objectContaining({ terminalId: TERMINAL_ID }),
    ]);
  });

  it("keeps closing an opened shell refused for a substituted key until the relay confirms", async () => {
    currentCli = await fakeCli();
    const view = renderHook(() => useTerminalSessions({ pinStore: createMemoryCliPinStore() }));
    const listed = await listedCli(currentCli, true);
    message({ type: "terminals", clis: [listed], terminals: [] });
    await openAfterList(() => view.result.current.openCli(CLI_ID), [listed]);
    await waitFor(() => expect(sentOfType("open")).toHaveLength(1));
    message({
      type: "opening",
      terminalId: TERMINAL_ID,
      viewerId: VIEWER_ID,
      requestId: sentOfType("open")[0]?.requestId,
    });
    const substituted = await generateEphemeralHandshake();
    message({
      type: "opened",
      terminalId: TERMINAL_ID,
      cliPublicKey: bytesToBase64Url(substituted.publicKeyRaw),
      cliNonce: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    });
    await waitFor(() =>
      expect(view.result.current.tabs[0]).toMatchObject({
        phase: "rejected",
        rejectionReason: "identity_mismatch",
      }),
    );
    expect(closes()).toHaveLength(1);
    act(() => handlers().onDisconnect?.());
    act(() => handlers().onOpen?.());
    message({ type: "terminals", clis: [listed], terminals: [listedTerminal(false)] });
    expect(closes()).toHaveLength(2);
    expect(view.result.current.tabs).toHaveLength(1);
    expect(sentOfType("attach")).toEqual([]);
  });
});

describe("useTerminalSessions open refused before the relay read it", () => {
  it("matches acks by request id and opens a rate-limited tab again", async () => {
    currentCli = await fakeCli();
    const view = renderHook(() => useTerminalSessions({ pinStore: createMemoryCliPinStore() }));
    const listed = await listedCli(currentCli, true);
    message({ type: "terminals", clis: [listed], terminals: [] });
    await openAfterList(() => view.result.current.openCli(CLI_ID), [listed]);
    await waitFor(() => expect(sentOfType("open")).toHaveLength(1));
    await openAfterList(() => view.result.current.openCli(CLI_ID), [listed]);
    await waitFor(() => expect(sentOfType("open")).toHaveLength(2));
    const [refused, kept] = view.result.current.tabs;
    if (!refused || !kept) throw new Error("no tabs");
    const [first, second] = sentOfType("open");
    expect(first?.requestId).toBeTruthy();
    expect(second?.requestId).not.toBe(first?.requestId);
    // The first open was refused unread: no `opening` will come for it.
    message({
      type: "error",
      terminalId: null,
      requestId: first?.requestId,
      code: "rate_limited",
      message: "",
    });
    message({
      type: "opening",
      terminalId: TERMINAL_ID,
      viewerId: VIEWER_ID,
      requestId: second?.requestId,
    });
    expect(view.result.current.tabs).toEqual([
      expect.objectContaining({ localId: refused.localId, terminalId: null, phase: "opening" }),
      expect.objectContaining({ localId: kept.localId, terminalId: TERMINAL_ID }),
    ]);
    // After a backoff, the refused tab sends its open again.
    await waitFor(() => expect(sentOfType("open")).toHaveLength(3), { timeout: 3000 });
    const third = sentOfType("open")[2];
    expect(third?.requestId).not.toBe(first?.requestId);
    // An open refused as invalid rejects its tab instead.
    message({
      type: "error",
      terminalId: null,
      requestId: third?.requestId,
      code: "invalid",
      message: "",
    });
    expect(view.result.current.tabs[0]).toMatchObject({
      localId: refused.localId,
      phase: "rejected",
      rejectionReason: "invalid",
    });
  });
});

describe("useTerminalSessions frames a full socket queue refused", () => {
  it("opens and attaches again with backoff instead of waiting on a frame never sent", async () => {
    currentCli = await fakeCli();
    const view = renderHook(() => useTerminalSessions({ pinStore: createMemoryCliPinStore() }));
    const listed = await listedCli(currentCli, true);
    message({ type: "terminals", clis: [listed], terminals: [] });
    let refuse = true;
    socket.send.mockImplementation((entry) => {
      if (refuse && (entry.type === "open" || entry.type === "attach")) return "full";
      return "sent";
    });
    await openAfterList(() => view.result.current.openCli(CLI_ID), [listed]);
    await waitFor(() => expect(sentOfType("open")).toHaveLength(1));
    expect(view.result.current.tabs[0]).toMatchObject({ phase: "opening", terminalId: null });
    refuse = false;
    await waitFor(() => expect(sentOfType("open")).toHaveLength(2), { timeout: 3000 });
    // The refused open is not waiting for an `opening`: the next one goes to the retry.
    const [, retried] = sentOfType("open");
    const localId = view.result.current.tabs[0]?.localId;
    message({
      type: "opening",
      terminalId: TERMINAL_ID,
      viewerId: VIEWER_ID,
      requestId: retried?.requestId,
    });
    expect(view.result.current.tabs[0]).toMatchObject({ localId, terminalId: TERMINAL_ID });

    // An attach a full queue refused is started again too.
    refuse = true;
    const other = renderHook(() => useTerminalSessions({ pinStore: createMemoryCliPinStore() }));
    const attaches = sentOfType("attach").length;
    act(() =>
      handlers().onMessage({
        type: "terminals",
        clis: [listed],
        terminals: [{ ...listedTerminal(true), terminalId: "b3RoZXItdGVybWluYWwtMDI" }],
      }),
    );
    await waitFor(() => expect(sentOfType("attach").length).toBe(attaches + 1));
    refuse = false;
    await waitFor(() => expect(sentOfType("attach").length).toBe(attaches + 2), {
      timeout: 3000,
    });
    expect(other.result.current.tabs[0]).toMatchObject({ phase: "opening" });
  });
});

describe("useTerminalSessions open closed before its acknowledgement", () => {
  it("closes the shell when `opening` arrives for a tab already closed", async () => {
    currentCli = await fakeCli();
    const view = renderHook(() => useTerminalSessions({ pinStore: createMemoryCliPinStore() }));
    const listed = await listedCli(currentCli, true);
    message({ type: "terminals", clis: [listed], terminals: [] });
    // Acks match opens in send order, and key generation can finish in either
    // order, so send the first open before starting the second.
    await openAfterList(() => view.result.current.openCli(CLI_ID), [listed]);
    await waitFor(() => expect(sentOfType("open")).toHaveLength(1));
    await openAfterList(() => view.result.current.openCli(CLI_ID), [listed]);
    await waitFor(() => expect(sentOfType("open")).toHaveLength(2));
    const [closed, kept] = view.result.current.tabs;
    if (!closed || !kept) throw new Error("no tabs");
    act(() => view.result.current.detachTab(closed.localId));
    // No terminal id yet: nothing to close until the relay names it.
    expect(sentOfType("close")).toEqual([]);

    message({ type: "opening", terminalId: TERMINAL_ID, viewerId: VIEWER_ID });
    expect(sentOfType("close")).toEqual([
      { type: "close", terminalId: TERMINAL_ID, requestId: expect.any(String) },
    ]);
    // The next ack still belongs to the tab that stayed open.
    message({ type: "opening", terminalId: "b3RoZXItdGVybWluYWwtMDI", viewerId: VIEWER_ID });
    expect(view.result.current.tabs).toEqual([
      expect.objectContaining({ localId: kept.localId, terminalId: "b3RoZXItdGVybWluYWwtMDI" }),
    ]);

    const cli = requireCli().ecdh;
    message({
      type: "opened",
      terminalId: TERMINAL_ID,
      cliPublicKey: bytesToBase64Url(cli.publicKeyRaw),
      cliNonce: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    });
    await sleep(20);
    expect(view.result.current.tabs).toEqual([
      expect.objectContaining({ localId: kept.localId, phase: "opening" }),
    ]);
    expect(sentOfType("close")).toHaveLength(1);
    expect(sentOfType("detach")).toEqual([]);
  });
});

describe("useTerminalSessions shell exit", () => {
  it("delivers every frame received before exit, in order, then ends the session", async () => {
    const { view, cli, localId, events, outKey } = await setupV2();
    const nextKey = crypto.getRandomValues(new Uint8Array(32));
    const frames = [
      await sealBroadcast(outKey, 1, 1, "a"),
      await sealUnicast(cli, text("b")),
      // Epoch 2 output arrives before its key; the key comes next.
      await sealBroadcast(nextKey, 2, 1, "d"),
      await sealUnicast(cli, encodeTerminalOutputKey(2, nextKey)),
      await sealUnicast(cli, text("c")),
      await sealBroadcast(nextKey, 2, 2, "e"),
    ];
    const late = await sealUnicast(cli, text("late"));
    // All of it lands in one tick, still queued behind decryption, then exit.
    act(() => {
      for (const frame of frames) handlers().onSealed(frame);
      handlers().onMessage({ type: "exit", terminalId: TERMINAL_ID, exitCode: 0, signal: null });
      handlers().onSealed(late);
    });
    expect(view.result.current.tabs[0]?.phase).toBe("exited");
    // The queued epoch-2 frame opens once the key that follows it is read.
    await waitFor(() => expect(outputText(events)).toBe("hello abdce"));
    await sleep(30);
    expect(outputText(events)).toBe("hello abdce");
    expect(view.result.current.tabs[0]?.phase).toBe("exited");
    // The session is gone: input goes nowhere and later output is dropped.
    act(() => view.result.current.sendInput(localId, "x"));
    await unicast(cli, text("after"));
    await sleep(30);
    expect(socket.sendFrame).not.toHaveBeenCalled();
    expect(outputText(events)).toBe("hello abdce");
  });

  it("delivers early frames when the shell exits while keys are derived", async () => {
    const { view, events } = await listAndSubscribe();
    await attachAsCli(
      VIEWER_ID,
      0,
      undefined,
      () =>
        handlers().onMessage({ type: "exit", terminalId: TERMINAL_ID, exitCode: 0, signal: null }),
      async (cli) => [await sealUnicast(cli, text("last ")), await sealUnicast(cli, text("words"))],
    );
    await waitFor(() => expect(outputText(events)).toBe("last words"));
    await sleep(30);
    expect(view.result.current.tabs[0]?.phase).toBe("exited");
  });
});

describe("useTerminalSessions handshake after the tab ended", () => {
  it("does not revive a tab whose shell exited during key derivation", async () => {
    const { view } = await listAndSubscribe();
    const cli = await attachAsCli(VIEWER_ID, 0, undefined, () =>
      handlers().onMessage({ type: "exit", terminalId: TERMINAL_ID, exitCode: 0, signal: null }),
    );
    await sleep(50);
    expect(view.result.current.tabs[0]?.phase).toBe("exited");
    const localId = view.result.current.tabs[0]?.localId ?? "";
    act(() => view.result.current.sendInput(localId, "x"));
    await unicast(cli, text("ghost"));
    await sleep(30);
    expect(socket.sendFrame).not.toHaveBeenCalled();
    expect(view.result.current.tabs[0]?.phase).toBe("exited");
  });

  it("does not revive a tab refused during key derivation", async () => {
    const { view, events } = await listAndSubscribe();
    const cli = await attachAsCli(VIEWER_ID, 0, undefined, () =>
      handlers().onMessage({
        type: "rejected",
        terminalId: TERMINAL_ID,
        reason: "denied",
        approvalCode: null,
      }),
    );
    await sleep(50);
    expect(view.result.current.tabs[0]).toMatchObject({
      phase: "rejected",
      rejectionReason: "denied",
    });
    await unicast(cli, text("ghost"));
    await sleep(30);
    expect(events).toEqual([]);
  });

  it("does not recreate a session for a tab closed during key derivation", async () => {
    const { view, localId, events } = await listAndSubscribe();
    const cli = await attachAsCli(VIEWER_ID, 0, undefined, () =>
      view.result.current.detachTab(localId),
    );
    await sleep(50);
    expect(view.result.current.tabs).toEqual([]);
    expect(sentOfType("detach")).toEqual([{ type: "detach", terminalId: TERMINAL_ID }]);
    act(() => view.result.current.sendInput(localId, "x"));
    await unicast(cli, text("ghost"));
    await sleep(30);
    expect(socket.sendFrame).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("does not revive a tab the relay detached during key derivation", async () => {
    const { view } = await listAndSubscribe();
    await attachAsCli(VIEWER_ID, 0, undefined, () =>
      handlers().onMessage({ type: "detached", terminalId: TERMINAL_ID, reason: null }),
    );
    await sleep(50);
    expect(view.result.current.tabs[0]).toMatchObject({ phase: "opening", error: "detached" });
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
    currentCli = await fakeCli();
    const view = renderHook(() => useTerminalSessions({ pinStore: createMemoryCliPinStore() }));
    message({
      type: "terminals",
      clis: [await listedCli(currentCli, false)],
      terminals: [listedTerminal(true)],
    });
    await sleep(50);
    expect(sentOfType("attach")).toEqual([]);
    const tab = view.result.current.tabs[0];
    expect(tab?.error).toBe("detached");
    act(() => view.result.current.selectTab(tab?.localId ?? ""));
    await waitFor(() => expect(sentOfType("attach")).toHaveLength(1));
  });
});

describe("useTerminalSessions CLI identity pinning", () => {
  it("allows a 2.4 CLI as unverified, without pinning anything", async () => {
    const { view, pinStore } = await setup(false);
    expect(view.result.current.cliTrust[CLI_ID]).toEqual({ status: "unverified" });
    expect(pinStore.pins.size).toBe(0);
  });

  it("verifies and pins a 2.5 CLI identity on first use", async () => {
    const { view, pinStore } = await setup(true);
    const cli = requireCli();
    expect(pinStore.pins.get(CLI_ID)).toBe(cli.identityPublicKey);
    const fingerprint = await cliIdentityFingerprint(base64UrlToBytes(cli.identityPublicKey));
    expect(fingerprint).toMatch(/^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/);
    await waitFor(() =>
      expect(view.result.current.cliTrust[CLI_ID]).toMatchObject({
        status: "trusted",
        fingerprint,
        firstUse: true,
      }),
    );
  });

  it("refuses a changed identity, then attaches after Trust new key", async () => {
    const previous = await fakeCli();
    const pinStore = createMemoryCliPinStore({ [CLI_ID]: previous.identityPublicKey });
    currentCli = await fakeCli();
    const view = renderHook(() => useTerminalSessions({ pinStore }));
    message({
      type: "terminals",
      clis: [await listedCli(currentCli, true)],
      terminals: [listedTerminal(true)],
    });
    await waitFor(() =>
      expect(view.result.current.tabs[0]).toMatchObject({
        phase: "rejected",
        rejectionReason: "identity_changed",
      }),
    );
    expect(sentOfType("attach")).toEqual([]);
    const trust = view.result.current.cliTrust[CLI_ID];
    expect(trust).toMatchObject({
      status: "changed",
      pinnedFingerprint: await cliIdentityFingerprint(base64UrlToBytes(previous.identityPublicKey)),
      fingerprint: await cliIdentityFingerprint(base64UrlToBytes(currentCli.identityPublicKey)),
    });
    expect(pinStore.pins.get(CLI_ID)).toBe(previous.identityPublicKey);

    if (trust?.status !== "changed") throw new Error("expected a changed identity");
    let applied = false;
    await act(async () => {
      applied = await view.result.current.trustNewKey(CLI_ID, trust);
    });
    expect(applied).toBe(true);
    expect(pinStore.pins.get(CLI_ID)).toBe(currentCli.identityPublicKey);
    expect(view.result.current.cliTrust[CLI_ID]).toMatchObject({ status: "trusted" });
    await attachAsCli(VIEWER_ID);
    await waitFor(() => expect(view.result.current.tabs[0]?.phase).toBe("live"));
  });

  it("pins nothing when the key changes again while the dialog is open", async () => {
    const previous = await fakeCli();
    const pinStore = createMemoryCliPinStore({ [CLI_ID]: previous.identityPublicKey });
    currentCli = await fakeCli();
    const view = renderHook(() => useTerminalSessions({ pinStore }));
    message({
      type: "terminals",
      clis: [await listedCli(currentCli, true)],
      terminals: [listedTerminal(true)],
    });
    await waitFor(() =>
      expect(view.result.current.cliTrust[CLI_ID]).toMatchObject({ status: "changed" }),
    );
    // The dialog opens on this state.
    const shown = view.result.current.cliTrust[CLI_ID];
    if (shown?.status !== "changed") throw new Error("expected a changed identity");

    // Another signed identity arrives before the user confirms.
    const swapped = await fakeCli();
    currentCli = swapped;
    message({
      type: "terminals",
      clis: [await listedCli(swapped, true)],
      terminals: [listedTerminal(true)],
    });
    const swappedFingerprint = await cliIdentityFingerprint(
      base64UrlToBytes(swapped.identityPublicKey),
    );
    await waitFor(() =>
      expect(view.result.current.cliTrust[CLI_ID]).toMatchObject({
        status: "changed",
        fingerprint: swappedFingerprint,
      }),
    );

    let applied = true;
    await act(async () => {
      applied = await view.result.current.trustNewKey(CLI_ID, shown);
    });
    expect(applied).toBe(false);
    expect(pinStore.pins.get(CLI_ID)).toBe(previous.identityPublicKey);
    expect(view.result.current.cliTrust[CLI_ID]).toMatchObject({
      status: "changed",
      fingerprint: swappedFingerprint,
      identityPublicKey: swapped.identityPublicKey,
    });
    expect(view.result.current.tabs[0]).toMatchObject({
      phase: "rejected",
      rejectionReason: "identity_changed",
    });
    await sleep(20);
    expect(sentOfType("attach")).toEqual([]);
  });

  it("refuses a 2.5 CLI whose signature does not cover its terminal key", async () => {
    currentCli = await fakeCli();
    const pinStore = createMemoryCliPinStore();
    const view = renderHook(() => useTerminalSessions({ pinStore }));
    const listed = await listedCli(currentCli, true);
    message({
      type: "terminals",
      // Signed for another slug: the relay cannot re-bind a statement.
      clis: [
        {
          ...listed,
          identitySignature: await currentCli.sign(currentCli.ecdh.publicKeyRaw, "other"),
        },
      ],
      terminals: [listedTerminal(true)],
    });
    await waitFor(() =>
      expect(view.result.current.tabs[0]).toMatchObject({
        phase: "rejected",
        rejectionReason: "identity_invalid",
      }),
    );
    expect(view.result.current.cliTrust[CLI_ID]).toEqual({ status: "invalid" });
    expect(sentOfType("attach")).toEqual([]);
    expect(pinStore.pins.size).toBe(0);
  });

  it("refuses a 2.5 CLI that lists no identity", async () => {
    currentCli = await fakeCli();
    const view = renderHook(() => useTerminalSessions({ pinStore: createMemoryCliPinStore() }));
    const listed = await listedCli(currentCli, true);
    message({
      type: "terminals",
      clis: [{ ...listed, identityPublicKey: null, identitySignature: null }],
      terminals: [listedTerminal(true)],
    });
    await waitFor(() =>
      expect(view.result.current.cliTrust[CLI_ID]).toEqual({ status: "invalid" }),
    );
    expect(sentOfType("attach")).toEqual([]);
  });

  it("drops a handshake answered with an ECDH key the identity did not sign", async () => {
    currentCli = await fakeCli();
    const view = renderHook(() => useTerminalSessions({ pinStore: createMemoryCliPinStore() }));
    message({
      type: "terminals",
      clis: [await listedCli(currentCli, true)],
      terminals: [listedTerminal(true)],
    });
    await attachAsCli(VIEWER_ID, 0, await generateEphemeralHandshake());
    await waitFor(() =>
      expect(view.result.current.tabs[0]).toMatchObject({
        phase: "rejected",
        rejectionReason: "identity_mismatch",
      }),
    );
    expect(sentOfType("detach")).toEqual([{ type: "detach", terminalId: TERMINAL_ID }]);
    expect(sentOfType("list")).toHaveLength(1);
  });
});

describe("useTerminalSessions browser identity readiness", () => {
  it("holds automatic attaches until the browser identity loads", async () => {
    identity.ready = false;
    currentCli = await fakeCli();
    const view = renderHook(() => useTerminalSessions({ pinStore: createMemoryCliPinStore() }));
    message({
      type: "terminals",
      clis: [await listedCli(currentCli, true)],
      terminals: [listedTerminal(true)],
    });
    // The identity check finishes, but no handshake goes out without an identity.
    await waitFor(() =>
      expect(view.result.current.cliTrust[CLI_ID]).toMatchObject({ status: "trusted" }),
    );
    await sleep(50);
    expect(sentOfType("attach")).toEqual([]);
    expect(view.result.current.tabs[0]).toMatchObject({ phase: "opening", rejectionReason: null });

    identity.ready = true;
    view.rerender();
    await attachAsCli(VIEWER_ID);
    await waitFor(() => expect(view.result.current.tabs[0]?.phase).toBe("live"));
    expect(sentOfType("attach")).toHaveLength(1);
  });

  it("retries a tab refused for a missing browser identity once it loads", async () => {
    currentCli = await fakeCli();
    const view = renderHook(() => useTerminalSessions({ pinStore: createMemoryCliPinStore() }));
    message({
      type: "terminals",
      clis: [await listedCli(currentCli, true)],
      terminals: [listedTerminal(true)],
    });
    // The mocked identity has no public key, so this attach carries none.
    const first = await waitFor(() => {
      const entry = sentOfType("attach")[0];
      if (!entry) throw new Error("no attach");
      return entry;
    });
    expect(first).not.toHaveProperty("identity");
    message({
      type: "rejected",
      terminalId: TERMINAL_ID,
      reason: "approval_required",
      approvalCode: null,
    });
    expect(view.result.current.tabs[0]).toMatchObject({
      phase: "rejected",
      rejectionReason: "approval_required",
    });
    // The identity finishes loading.
    identity.ready = false;
    view.rerender();
    identity.ready = true;
    view.rerender();
    await attachAsCli(VIEWER_ID, 1);
    await waitFor(() => expect(view.result.current.tabs[0]?.phase).toBe("live"));
  });

  it("does not retry other refusals when the identity loads", async () => {
    currentCli = await fakeCli();
    const view = renderHook(() => useTerminalSessions({ pinStore: createMemoryCliPinStore() }));
    message({
      type: "terminals",
      clis: [await listedCli(currentCli, true)],
      terminals: [listedTerminal(true)],
    });
    await waitFor(() => expect(sentOfType("attach")).toHaveLength(1));
    message({ type: "rejected", terminalId: TERMINAL_ID, reason: "denied", approvalCode: null });
    identity.ready = false;
    view.rerender();
    identity.ready = true;
    view.rerender();
    await sleep(50);
    expect(sentOfType("attach")).toHaveLength(1);
    expect(view.result.current.tabs[0]).toMatchObject({ phase: "rejected" });
  });
});

describe("useTerminalSessions reconnection", () => {
  it("discards a handshake that finishes after the socket dropped", async () => {
    currentCli = await fakeCli();
    const listed = await listedCli(currentCli, true);
    const view = renderHook(() => useTerminalSessions({ pinStore: createMemoryCliPinStore() }));
    message({ type: "terminals", clis: [listed], terminals: [listedTerminal(true)] });
    // The socket drops while the browser is still deriving the session keys.
    await attachAsCli(VIEWER_ID, 0, undefined, () => handlers().onDisconnect?.());
    await sleep(50);
    expect(view.result.current.tabs[0]).toMatchObject({ phase: "opening" });

    // The next socket lists the terminal again, and the tab reattaches.
    act(() => handlers().onOpen?.());
    message({ type: "terminals", clis: [listed], terminals: [listedTerminal(true)] });
    await attachAsCli(VIEWER_ID, 1);
    await waitFor(() => expect(view.result.current.tabs[0]?.phase).toBe("live"));
  });

  it("drops an identity check that finishes on an earlier socket", async () => {
    currentCli = await fakeCli();
    const listed = await listedCli(currentCli, true);
    renderHook(() => useTerminalSessions({ pinStore: createMemoryCliPinStore() }));
    act(() => {
      handlers().onMessage({
        type: "terminals",
        clis: [listed],
        terminals: [listedTerminal(true)],
      });
      // Disconnect before the trust check lets the attach go out.
      handlers().onDisconnect?.();
    });
    await sleep(50);
    expect(sentOfType("attach")).toEqual([]);
    act(() => handlers().onOpen?.());
    message({ type: "terminals", clis: [listed], terminals: [listedTerminal(true)] });
    await waitFor(() => expect(sentOfType("attach")).toHaveLength(1));
  });
});

describe("useTerminalSessions terminals gone while disconnected", () => {
  it("marks a tab exited when the next list no longer has its terminal", async () => {
    const { view, localId } = await setup(true);
    expect(sentOfType("attach")).toHaveLength(1);
    act(() => handlers().onDisconnect?.());
    expect(view.result.current.tabs[0]).toMatchObject({ phase: "opening" });

    act(() => handlers().onOpen?.());
    message({
      type: "terminals",
      clis: [await listedCli(requireCli(), true)],
      terminals: [],
    });
    expect(view.result.current.tabs[0]).toMatchObject({
      localId,
      phase: "exited",
      error: TERMINAL_GONE,
    });
    await sleep(20);
    expect(sentOfType("attach")).toHaveLength(1);
    // Input to the ended tab goes nowhere.
    act(() => view.result.current.sendInput(localId, "ls\r"));
    await sleep(20);
    expect(socket.sendFrame).not.toHaveBeenCalled();
  });

  it("reattaches a terminal the next list still has", async () => {
    const { view } = await setup(true);
    act(() => handlers().onDisconnect?.());
    act(() => handlers().onOpen?.());
    message({
      type: "terminals",
      clis: [await listedCli(requireCli(), true)],
      terminals: [listedTerminal(true)],
    });
    expect(view.result.current.tabs[0]).toMatchObject({ phase: "opening", error: null });
    await attachAsCli(VIEWER_ID, 1);
    await waitFor(() => expect(view.result.current.tabs[0]?.phase).toBe("live"));
  });

  it("does not end a terminal the relay named after the list was requested", async () => {
    currentCli = await fakeCli();
    const listed = await listedCli(currentCli, true);
    const view = renderHook(() => useTerminalSessions({ pinStore: createMemoryCliPinStore() }));
    act(() => handlers().onOpen?.());
    message({ type: "terminals", clis: [listed], terminals: [] });
    await openAfterList(() => view.result.current.openCli(CLI_ID), [listed]);
    await waitFor(() => expect(sentOfType("open")).toHaveLength(1));

    // A new socket asks for the list, then the relay acknowledges the open.
    act(() => handlers().onOpen?.());
    await waitFor(() => expect(sentOfType("open")).toHaveLength(2));
    message({ type: "opening", terminalId: TERMINAL_ID, viewerId: VIEWER_ID });
    // That list was built before the relay registered the terminal.
    message({ type: "terminals", clis: [listed], terminals: [] });
    expect(view.result.current.tabs[0]).toMatchObject({
      terminalId: TERMINAL_ID,
      phase: "opening",
      error: null,
    });
  });
});

describe("useTerminalSessions CLI list refresh", () => {
  it("opens a CLI that came online after the last list", async () => {
    currentCli = await fakeCli();
    const view = renderHook(() => useTerminalSessions({ pinStore: createMemoryCliPinStore() }));
    // Connected before the CLI came online: the relay listed no CLIs.
    message({ type: "terminals", clis: [], terminals: [] });

    act(() => view.result.current.openCli(CLI_ID));
    await waitFor(() => expect(sentOfType("list")).toHaveLength(1));
    // Nothing opens until the fresh list arrives.
    expect(sentOfType("open")).toEqual([]);
    expect(view.result.current.tabs).toEqual([]);

    message({ type: "terminals", clis: [await listedCli(currentCli, true)], terminals: [] });
    await waitFor(() => expect(sentOfType("open")).toHaveLength(1));
    expect(view.result.current.tabs).toEqual([
      expect.objectContaining({ cliDeviceId: CLI_ID, phase: "opening", rejectionReason: null }),
    ]);
  });

  it("keeps a terminal closed with X out of later lists", async () => {
    const { view, localId } = await setupV2();
    const listed = await listedCli(requireCli(), true);
    act(() => view.result.current.detachTab(localId));
    expect(sentOfType("detach")).toEqual([{ type: "detach", terminalId: TERMINAL_ID }]);
    expect(view.result.current.tabs).toEqual([]);

    // Opening the picker refreshes the list. The shell still runs, so the
    // relay names it; it must not come back as a tab or take a viewer slot.
    const attaches = sentOfType("attach").length;
    await act(async () => {
      const refreshed = view.result.current.refreshClis();
      handlers().onMessage({
        type: "terminals",
        clis: [listed],
        terminals: [listedTerminal(true)],
      });
      await refreshed;
    });
    expect(view.result.current.tabs).toEqual([]);
    expect(sentOfType("attach")).toHaveLength(attaches);

    // Once it ends (no longer listed), a new terminal with that id is shown.
    message({ type: "terminals", clis: [listed], terminals: [] });
    message({ type: "terminals", clis: [listed], terminals: [listedTerminal(true)] });
    expect(view.result.current.tabs).toEqual([
      expect.objectContaining({ terminalId: TERMINAL_ID }),
    ]);
  });
});

describe("useTerminalSessions (agent requests)", () => {
  beforeEach(async () => {
    // Handshakes of the previous test may still finish on the shared socket mock.
    await sleep(150);
    socket.send.mockReset();
    socket.sendFrame.mockReset();
  });

  function agentTerminal(status = "awaiting_user", shareOutput = true) {
    return {
      ...listedTerminal(false),
      origin: "agent" as const,
      supervised: {
        commandId: "Y29tbWFuZC1pZC0wMDAwMQ",
        status: status as "awaiting_user",
        requester: "laptop agent",
        reason: "needs sudo",
        command: "sudo true",
        cwd: "/home/me",
        shareOutput,
        createdAt: null,
        expiresAt: null,
        exitCode: null,
        signal: null,
      },
    };
  }

  async function listAgent(status = "awaiting_user", shareOutput = true) {
    currentCli = await fakeCli();
    const listed = await listedCli(currentCli, true);
    const view = renderHook(() => useTerminalSessions({ pinStore: createMemoryCliPinStore() }));
    message({ type: "terminals", clis: [listed], terminals: [agentTerminal(status, shareOutput)] });
    return { view, listed };
  }

  async function attachAgent() {
    const context = await listAgent();
    const localId = context.view.result.current.tabs[0]?.localId ?? "";
    act(() => context.view.result.current.selectTab(localId));
    const cli = await attachAsCli(VIEWER_ID);
    await waitFor(() => expect(context.view.result.current.tabs[0]?.phase).toBe("live"));
    const events: TerminalOutputEvent[] = [];
    act(() => {
      context.view.result.current.subscribeOutput(localId, (event) => events.push(event));
    });
    return { ...context, cli, localId, events };
  }

  async function rawBrowserPlaintexts(cli: Cli): Promise<Uint8Array[]> {
    const out: Uint8Array[] = [];
    for (const [frame] of socket.sendFrame.mock.calls) {
      const decoded = decodeSealedFrame(frame);
      out.push(
        await openTerminalBytesV2({
          key: cli.keys.browserToCli,
          terminalId: TERMINAL_ID,
          viewerId: cli.viewerId ?? "",
          direction: DIRECTION_BROWSER_TO_CLI,
          seq: BigInt(decoded.seq),
          ciphertext: decoded.body,
        }),
      );
    }
    return out;
  }

  it("lists an agent request without attaching, and attaches when it is selected", async () => {
    const { view } = await listAgent();
    await sleep(50);
    expect(sentOfType("attach")).toEqual([]);
    const tab = view.result.current.tabs[0];
    expect(tab).toMatchObject({ origin: "agent", phase: "waiting" });
    expect(tab?.supervised?.requester).toBe("laptop agent");
    // A later list does not attach it either.
    message({
      type: "terminals",
      clis: [await listedCli(requireCli(), true)],
      terminals: [agentTerminal()],
    });
    await sleep(50);
    expect(sentOfType("attach")).toEqual([]);
    act(() => view.result.current.selectTab(tab?.localId ?? ""));
    await waitFor(() => expect(sentOfType("attach")).toHaveLength(1));
  });

  it("drops keystrokes until the confirm screen has been shown", async () => {
    const { view, cli, localId, events } = await attachAgent();
    act(() => view.result.current.sendInput(localId, "\r"));
    await sleep(100);
    expect(socket.sendFrame).not.toHaveBeenCalled();
    const outKey = crypto.getRandomValues(new Uint8Array(32));
    await unicast(cli, encodeTerminalOutputKey(1, outKey));
    await unicast(cli, text("Press Enter to run"));
    await waitFor(() => expect(outputText(events)).toBe("Press Enter to run"));
    act(() => view.result.current.sendInput(localId, "\r"));
    // The first keystroke takes over the writer: its size, then the data.
    await waitFor(() => expect(socket.sendFrame).toHaveBeenCalledTimes(2));
    const frames = await browserFrames(cli);
    expect(frames.filter((frame) => "data" in frame)).toEqual([{ seq: 2, data: "\r" }]);
  });

  it("sends no keystrokes once the command is past running", async () => {
    const { view, cli, localId, events, listed } = await attachAgent();
    await unicast(cli, text("screen"));
    await waitFor(() => expect(outputText(events)).toBe("screen"));
    message({
      type: "terminals",
      pushed: true,
      clis: [listed],
      terminals: [agentTerminal("awaiting_output_review")],
    });
    act(() => view.result.current.sendInput(localId, "y\r"));
    await sleep(100);
    expect(socket.sendFrame).not.toHaveBeenCalled();
  });

  it("shows the CLI-reported review flag and sends the toggle over the viewer's keys", async () => {
    const { view, cli, localId } = await attachAgent();
    expect(view.result.current.tabs[0]?.reviewOutput).toBeNull();
    await unicast(cli, Uint8Array.of(0x06, 1));
    await waitFor(() => expect(view.result.current.tabs[0]?.reviewOutput).toBe(true));
    act(() => view.result.current.setReviewOutput(localId, false));
    await waitFor(() => expect(socket.sendFrame).toHaveBeenCalledTimes(1));
    const [toggle] = await rawBrowserPlaintexts(cli);
    expect(Array.from(toggle ?? [])).toEqual([0x04, 0]);
    // Nothing is set locally: the checkbox follows the CLI.
    expect(view.result.current.tabs[0]?.reviewOutput).toBe(true);
  });

  it("does not send a review toggle when output is not shared", async () => {
    const { view, localId } = await (async () => {
      const context = await listAgent("awaiting_user", false);
      const id = context.view.result.current.tabs[0]?.localId ?? "";
      act(() => context.view.result.current.selectTab(id));
      await attachAsCli(VIEWER_ID);
      await waitFor(() => expect(context.view.result.current.tabs[0]?.phase).toBe("live"));
      return { ...context, localId: id };
    })();
    act(() => view.result.current.setReviewOutput(localId, true));
    await sleep(50);
    expect(socket.sendFrame).not.toHaveBeenCalled();
  });

  it("keeps a unicast review capture and clears it on request", async () => {
    const { view, cli, localId } = await attachAgent();
    const capture = Uint8Array.from([
      0x05,
      ...[0, 0, 0, 0, 0, 0, 0, 5],
      ...[0, 0, 0, 5],
      ...new TextEncoder().encode("hello"),
    ]);
    await unicast(cli, capture);
    await waitFor(() => expect(view.result.current.tabs[0]?.reviewCapture).not.toBeNull());
    const kept = view.result.current.tabs[0]?.reviewCapture;
    expect(kept?.totalBytes).toBe(5);
    expect(decoder.decode(kept?.head)).toBe("hello");
    act(() => view.result.current.clearReviewCapture(localId));
    expect(view.result.current.tabs[0]?.reviewCapture).toBeNull();
  });

  it("ends an agent tab a pushed snapshot no longer lists, without touching list accounting", async () => {
    const { view, listed } = await listAgent();
    message({ type: "terminals", pushed: true, clis: [listed], terminals: [] });
    expect(view.result.current.tabs[0]).toMatchObject({ phase: "exited", error: TERMINAL_GONE });
  });

  it("does not end a user terminal that is still attaching when a push omits it", async () => {
    currentCli = await fakeCli();
    const listed = await listedCli(currentCli, true);
    const view = renderHook(() => useTerminalSessions({ pinStore: createMemoryCliPinStore() }));
    message({ type: "terminals", clis: [listed], terminals: [listedTerminal(true)] });
    expect(view.result.current.tabs[0]?.phase).toBe("opening");
    message({ type: "terminals", pushed: true, clis: [listed], terminals: [] });
    expect(view.result.current.tabs[0]?.phase).toBe("opening");
  });

  it("sends Decline as a decline (never a close), keeps the tab, and stops its keystrokes", async () => {
    const { view, cli, localId, events } = await attachAgent();
    await unicast(cli, text("Press Enter to run"));
    await waitFor(() => expect(outputText(events)).toBe("Press Enter to run"));
    act(() => view.result.current.declineRequest(localId));
    expect(sentOfType("decline")).toEqual([
      { type: "decline", terminalId: TERMINAL_ID, requestId: expect.any(String) },
    ]);
    expect(sentOfType("close")).toEqual([]);
    expect(view.result.current.tabs[0]).toMatchObject({ localId, phase: "live", decline: "sent" });
    // This tab cannot press Enter after declining.
    act(() => view.result.current.sendInput(localId, "\r"));
    await sleep(100);
    expect(socket.sendFrame).not.toHaveBeenCalled();
    // A second Decline is not sent again.
    act(() => view.result.current.declineRequest(localId));
    expect(sentOfType("decline")).toHaveLength(1);
  });

  it("shows that an Enter beat this tab's Decline, and lets it type into the running command", async () => {
    const { view, cli, localId, events } = await attachAgent();
    await unicast(cli, text("screen"));
    await waitFor(() => expect(outputText(events)).toBe("screen"));
    act(() => view.result.current.declineRequest(localId));
    message({ type: "decline", terminalId: TERMINAL_ID, outcome: "started" });
    await waitFor(() =>
      expect(view.result.current.tabs[0]).toMatchObject({
        decline: "started",
        phase: "live",
        supervised: expect.objectContaining({ status: "running" }),
      }),
    );
    act(() => view.result.current.sendInput(localId, "y"));
    await waitFor(() => expect(socket.sendFrame).toHaveBeenCalled());
  });

  it("ends a declined tab with the CLI's answer", async () => {
    // A listed request this tab never viewed: Decline still works, and the
    // relay sends the exit to the declining socket.
    const { view } = await listAgent();
    const waiting = view.result.current.tabs[0];
    expect(waiting?.phase).toBe("waiting");
    act(() => view.result.current.declineRequest(waiting?.localId ?? ""));
    expect(sentOfType("decline")).toHaveLength(1);
    message({
      type: "exit",
      terminalId: TERMINAL_ID,
      exitCode: null,
      signal: null,
      supervisedStatus: "declined",
    });
    await waitFor(() =>
      expect(view.result.current.tabs[0]).toMatchObject({
        phase: "exited",
        supervised: expect.objectContaining({ status: "declined" }),
        // The exit answered it: no Decline is left out.
        decline: null,
      }),
    );
  });

  it("never claims a Decline was sent while no socket took it, and lets the person retry", async () => {
    const { view } = await listAgent();
    const localId = view.result.current.tabs[0]?.localId ?? "";
    socket.send.mockImplementation(() => "closed");
    act(() => view.result.current.declineRequest(localId));
    expect(view.result.current.tabs[0]).toMatchObject({ phase: "waiting", decline: "unsent" });
    // Retrying while still offline stays unsent; once a socket takes it, it is sent.
    act(() => view.result.current.declineRequest(localId));
    expect(view.result.current.tabs[0]?.decline).toBe("unsent");
    socket.send.mockImplementation(() => "sent");
    act(() => view.result.current.declineRequest(localId));
    expect(view.result.current.tabs[0]?.decline).toBe("sent");
    expect(sentOfType("decline")).toHaveLength(3);
  });

  it("sends a Decline lost with its socket again when the new socket still lists the request waiting", async () => {
    const { view, cli, localId, events, listed } = await attachAgent();
    await unicast(cli, text("screen"));
    await waitFor(() => expect(outputText(events)).toBe("screen"));
    act(() => view.result.current.declineRequest(localId));
    expect(sentOfType("decline")).toHaveLength(1);
    // The socket drops before the relay answered: the relay forgot this Decline.
    act(() => handlers().onDisconnect?.());
    expect(view.result.current.tabs[0]?.decline).toBe("unsent");
    act(() => handlers().onOpen?.());
    message({ type: "terminals", clis: [listed], terminals: [agentTerminal()] });
    expect(sentOfType("decline")).toHaveLength(2);
    expect(view.result.current.tabs[0]?.decline).toBe("sent");
    // The new socket is a decliner, so it hears the outcome.
    message({
      type: "exit",
      terminalId: TERMINAL_ID,
      exitCode: null,
      signal: null,
      supervisedStatus: "declined",
    });
    await waitFor(() =>
      expect(view.result.current.tabs[0]).toMatchObject({
        phase: "exited",
        supervised: expect.objectContaining({ status: "declined" }),
      }),
    );
  });

  it("learns after a reconnect that an Enter came first, and types again", async () => {
    const { view, cli, localId, events, listed } = await attachAgent();
    await unicast(cli, text("screen"));
    await waitFor(() => expect(outputText(events)).toBe("screen"));
    act(() => view.result.current.declineRequest(localId));
    act(() => handlers().onDisconnect?.());
    act(() => handlers().onOpen?.());
    message({ type: "terminals", clis: [listed], terminals: [agentTerminal("running")] });
    // Started: nothing to decline, so nothing is sent again.
    expect(sentOfType("decline")).toHaveLength(1);
    expect(view.result.current.tabs[0]).toMatchObject({
      decline: "started",
      supervised: expect.objectContaining({ status: "running" }),
    });
    expect(
      agentInputAllowed(
        { ...(view.result.current.tabs[0] as TerminalTab), phase: "live" },
        new Set([localId]),
      ),
    ).toBe(true);
  });

  it("ends the tab when the request ended while its Decline's socket was down", async () => {
    const { view, listed } = await listAgent();
    const localId = view.result.current.tabs[0]?.localId ?? "";
    act(() => view.result.current.declineRequest(localId));
    act(() => handlers().onDisconnect?.());
    act(() => handlers().onOpen?.());
    message({ type: "terminals", clis: [listed], terminals: [] });
    expect(sentOfType("decline")).toHaveLength(1);
    expect(view.result.current.tabs[0]).toMatchObject({ phase: "exited", error: TERMINAL_GONE });
  });

  it("frees a Decline the relay answered with an error, and asks for a list on not_found", async () => {
    const { view } = await listAgent();
    const localId = view.result.current.tabs[0]?.localId ?? "";
    act(() => view.result.current.declineRequest(localId));
    const first = sentOfType("decline")[0]?.requestId;
    message({
      type: "error",
      terminalId: TERMINAL_ID,
      requestId: first,
      code: "offline",
      message: "offline",
    });
    expect(view.result.current.tabs[0]?.decline).toBe("failed");
    act(() => view.result.current.declineRequest(localId));
    expect(sentOfType("decline")).toHaveLength(2);
    const second = sentOfType("decline")[1]?.requestId;
    expect(second).not.toBe(first);
    expect(view.result.current.tabs[0]?.decline).toBe("sent");
    const lists = sentOfType("list").length;
    message({
      type: "error",
      terminalId: TERMINAL_ID,
      requestId: second,
      code: "not_found",
      message: "gone",
    });
    expect(view.result.current.tabs[0]?.decline).toBe("failed");
    expect(sentOfType("list")).toHaveLength(lists + 1);
  });

  it("lets the person retry a Decline the relay refused for rate, with no terminal id", async () => {
    const { view } = await listAgent();
    const localId = view.result.current.tabs[0]?.localId ?? "";
    act(() => view.result.current.declineRequest(localId));
    const requestId = sentOfType("decline")[0]?.requestId;
    // The relay's rate-limit refusal is sent before the frame is read for
    // its terminal; it names the frame by request id only.
    message({
      type: "error",
      terminalId: null,
      requestId,
      code: "rate_limited",
      message: "slow down",
    });
    expect(view.result.current.tabs[0]).toMatchObject({ decline: "failed", phase: "waiting" });
    act(() => view.result.current.declineRequest(localId));
    expect(sentOfType("decline")).toHaveLength(2);
    expect(view.result.current.tabs[0]?.decline).toBe("sent");
  });

  it("keeps a Decline out when an error answers another frame of the same terminal", async () => {
    const { view } = await listAgent();
    const localId = view.result.current.tabs[0]?.localId ?? "";
    act(() => view.result.current.declineRequest(localId));
    const first = sentOfType("decline")[0]?.requestId;
    message({
      type: "error",
      terminalId: TERMINAL_ID,
      requestId: first,
      code: "offline",
      message: "",
    });
    act(() => view.result.current.declineRequest(localId));
    // Errors without this Decline's id: an older Decline's, and another frame's.
    message({
      type: "error",
      terminalId: TERMINAL_ID,
      requestId: first,
      code: "offline",
      message: "",
    });
    message({ type: "error", terminalId: TERMINAL_ID, code: "not_found", message: "" });
    message({
      type: "error",
      terminalId: TERMINAL_ID,
      requestId: "other",
      code: "invalid",
      message: "",
    });
    expect(view.result.current.tabs[0]?.decline).toBe("sent");
    // The exit still ends it.
    message({
      type: "exit",
      terminalId: TERMINAL_ID,
      exitCode: null,
      signal: null,
      supervisedStatus: "declined",
    });
    expect(view.result.current.tabs[0]).toMatchObject({ phase: "exited" });
  });

  it("keeps an agent request listed when its tab stops viewing it", async () => {
    const { view, localId } = await attachAgent();
    act(() => view.result.current.detachTab(localId));
    expect(sentOfType("detach")).toHaveLength(1);
    expect(view.result.current.tabs[0]).toMatchObject({ localId, phase: "waiting" });
  });
});
