// @vitest-environment jsdom

import { webcrypto } from "node:crypto";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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
import type { TerminalSocketHandlers } from "@/hooks/use-terminal-socket";
import { createMemoryCliPinStore } from "@/lib/terminal-cli-identity";
import {
  decodeSealedFrame,
  type ListedCli,
  type SealedTerminalFrame,
  type TerminalClientMessage,
} from "@/lib/terminal-protocol";

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
    expect(sentOfType("close")).toEqual([{ type: "close", terminalId: TERMINAL_ID }]);
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

    await act(() => view.result.current.trustNewKey(CLI_ID));
    expect(pinStore.pins.get(CLI_ID)).toBe(currentCli.identityPublicKey);
    expect(view.result.current.cliTrust[CLI_ID]).toMatchObject({ status: "trusted" });
    await attachAsCli(VIEWER_ID);
    await waitFor(() => expect(view.result.current.tabs[0]?.phase).toBe("live"));
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
