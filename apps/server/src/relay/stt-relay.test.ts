import type { OpenAiCompatibleCapabilities } from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serverToNodeBinaryMetadataSchema } from "./frames.js";
import type { RelayFailure } from "./relay-failure.js";
import { STT_AUDIO_FRAME_MAX_BYTES, sttServerControlSchema } from "./stt-protocol.js";
import {
  realtimeTranscriptionCapability,
  STT_AUDIO_FLUSH_MS,
  STT_AUDIO_FRAME_MIN_BYTES,
  STT_AUDIO_FRAMES_IN_FLIGHT_MAX,
  STT_AUDIO_WINDOW_BYTES,
  STT_BACKLOG_STALL_MS,
  STT_CLOSE_GRACE_MS,
  STT_ITEM_DELTA_MAX_BYTES,
  STT_OPEN_TIMEOUT_MS,
  STT_PENDING_AUDIO_MAX_BYTES,
  STT_PENDING_CONTROLS_MAX,
  STT_PENDING_ITEMS_MAX,
  STT_SESSIONS_PER_CLI,
  STT_SESSIONS_SERVER_MAX,
  type SttAttachResult,
  type SttAttachTarget,
  type SttClientMessage,
  type SttLinkResolution,
  SttRelayHub,
  type SttRelayLink,
  type SttRelaySession,
  type SttSessionEnd,
  type SttSessionEvent,
} from "./stt-relay.js";

/** A server → node binary frame, as the node would read it. */
function parseRelayBinaryFrame(frame: ArrayBuffer) {
  const length = new DataView(frame).getUint32(0, false);
  const metadata = serverToNodeBinaryMetadataSchema.parse(
    JSON.parse(new TextDecoder().decode(new Uint8Array(frame, 4, length))),
  );
  return { metadata, body: new Uint8Array(frame, 4 + length) };
}

/** A node connection that records what the server sends. No network. */
class FakeLink implements SttRelayLink {
  open = true;
  buffered = 0;
  sends: (string | ArrayBuffer)[] = [];
  constructor(readonly nodeId: string) {}
  isOpen() {
    return this.open;
  }
  bufferedAmount() {
    return this.buffered;
  }
  send(data: string | ArrayBuffer) {
    if (!this.open) throw new Error("closed");
    this.sends.push(data);
  }
  controls(): Record<string, unknown>[] {
    return this.sends
      .filter((send): send is string => typeof send === "string")
      .map((send) => JSON.parse(send) as Record<string, unknown>);
  }
  control(type: string): Record<string, unknown> {
    const found = this.controls().find((message) => message.type === type);
    if (!found) throw new Error(`missing ${type}`);
    return found;
  }
  audio(): { sessionId: string; seq: number; body: Uint8Array }[] {
    return this.sends
      .filter((send): send is ArrayBuffer => typeof send !== "string")
      .map((send) => {
        const parsed = parseRelayBinaryFrame(send);
        if (parsed.metadata.type !== "stt.audio") throw new Error("not audio");
        return {
          sessionId: parsed.metadata.sessionId,
          seq: parsed.metadata.seq,
          body: parsed.body,
        };
      });
  }
  /** Everything sent, in order, as short labels. */
  timeline(): string[] {
    return this.sends.map((send) => {
      if (typeof send === "string") {
        const message = JSON.parse(send) as { type: string; itemSeq?: number };
        return message.itemSeq === undefined ? message.type : `${message.type}:${message.itemSeq}`;
      }
      return `audio:${parseRelayBinaryFrame(send).body.byteLength}`;
    });
  }
  audioBytes(): number {
    return this.audio().reduce((total, frame) => total + frame.body.byteLength, 0);
  }
}

function realtimeCaps(
  realtime: Record<string, unknown> | null,
  where: "transcriptions" | "translations" = "transcriptions",
): OpenAiCompatibleCapabilities {
  return {
    version: 2,
    protocol: "openai-compatible",
    audio: {
      [where]: { supported: true, ...(realtime ? { realtime } : {}) },
    },
  } as OpenAiCompatibleCapabilities;
}

const SEGMENTED = realtimeCaps({ supported: true, adapter: "segmented", maxItemSeconds: 10 });
const VLLM = realtimeCaps({ supported: true, adapter: "vllm" });

function target(nodeId: string, overrides: Partial<SttAttachTarget> = {}): SttAttachTarget {
  return {
    nodeId,
    handle: "inst-0123456789abcdef",
    upstreamModel: "whisper-large",
    capabilities: SEGMENTED,
    ...overrides,
  };
}

function pcm(bytes: number, fill = 1): Uint8Array {
  return new Uint8Array(bytes).fill(fill);
}

class Recorder {
  events: SttSessionEvent[] = [];
  ends: SttSessionEnd[] = [];
  drains = 0;
  onEvent(event: SttSessionEvent) {
    this.events.push(event);
  }
  onDrain() {
    this.drains += 1;
  }
  onEnd(end: SttSessionEnd) {
    this.ends.push(end);
  }
}

function setup() {
  const links = new Map<string, FakeLink>();
  const unavailable = new Set<string>();
  const idle: SttRelayLink[] = [];
  const hub = new SttRelayHub({
    onLinkIdle(link) {
      idle.push(link);
    },
    resolveLink(nodeId, handle): SttLinkResolution {
      const link = links.get(nodeId);
      if (!link?.open) return { ok: false, reason: "offline" };
      if (unavailable.has(handle)) return { ok: false, reason: "endpoint_unavailable" };
      return { ok: true, link };
    },
  });
  const link = (id: string) => {
    const created = new FakeLink(id);
    links.set(id, created);
    return created;
  };
  const create = (config = {}) => {
    const consumer = new Recorder();
    const created = hub.createSession({ consumer, config });
    if (!created.ok) throw new Error(created.reason);
    return { session: created.session, consumer };
  };
  return { hub, link, create, unavailable, idle };
}

function frame(link: SttRelayLink, hub: SttRelayHub, message: SttClientMessage) {
  hub.handleClientFrame(link, message);
}

async function openOn(
  hub: SttRelayHub,
  link: FakeLink,
  session: SttRelaySession,
  overrides: Partial<SttAttachTarget> = {},
): Promise<{ sessionId: string; result: SttAttachResult }> {
  const pending = session.attach(target(link.nodeId, overrides));
  const sessionId = session.relaySessionId;
  if (!sessionId) throw new Error(`not opening: ${JSON.stringify(await pending)}`);
  frame(link, hub, { type: "stt.opened", sessionId });
  return { sessionId, result: await pending };
}

function ack(link: FakeLink, hub: SttRelayHub, sessionId: string, bytes: number) {
  frame(link, hub, { type: "stt.audio.ack", sessionId, bytes });
}

function event(
  link: FakeLink,
  hub: SttRelayHub,
  sessionId: string,
  sttEvent: Extract<SttClientMessage, { type: "stt.event" }>["event"],
) {
  frame(link, hub, { type: "stt.event", sessionId, event: sttEvent });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("opening a live session on a CLI", () => {
  it("sends a valid stt.open, holds audio until stt.opened, then streams it", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session } = create({ prompt: "names", language: "en" });
    expect(session.appendAudio(pcm(8192)).ok).toBe(true);
    const pending = session.attach(target("cli-a"));
    const open = cli.control("stt.open");
    expect(sttServerControlSchema.safeParse(open).success).toBe(true);
    expect(open).toEqual({
      type: "stt.open",
      sessionId: session.relaySessionId,
      handle: "inst-0123456789abcdef",
      upstreamModel: "whisper-large",
      adapter: "segmented",
      config: { language: "en", prompt: "names" },
      maxItemSeconds: 10,
      maxSessionMs: 30 * 60 * 1000,
      audioWindowBytes: STT_AUDIO_WINDOW_BYTES,
    });
    // Key order follows the schema (golden byte equality).
    expect(Object.keys(JSON.parse(cli.sends[0] as string).config)).toEqual(["language", "prompt"]);
    expect(cli.audio()).toEqual([]);
    expect(session.status).toBe("opening");

    frame(cli, hub, { type: "stt.opened", sessionId: session.relaySessionId ?? "" });
    expect(await pending).toEqual({ status: "opened", adapter: "segmented", maxItemSeconds: 10 });
    expect(cli.audio().map((audio) => [audio.seq, audio.body.byteLength])).toEqual([[0, 8192]]);
    expect(session.sentAudioBytes).toBe(8192);
  });

  it("uses the adapter default turn length when the profile has none", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session } = create();
    const { result } = await openOn(hub, cli, session, { capabilities: VLLM });
    expect(result).toEqual({ status: "opened", adapter: "vllm", maxItemSeconds: 300 });
  });

  it("refuses targets that are not live transcription models", async () => {
    const { link, create } = setup();
    const cli = link("cli-a");
    const refusals: [Partial<SttAttachTarget>, Record<string, unknown>][] = [
      [{ capabilities: realtimeCaps(null) }, {}],
      [{ capabilities: realtimeCaps({ supported: false, adapter: "segmented" }) }, {}],
      // Only audio.transcriptions.realtime routes; a translations block never does.
      [
        {
          capabilities: realtimeCaps({ supported: true, adapter: "segmented" }, "translations"),
        },
        {},
      ],
      [{ capabilities: null }, {}],
      // The vLLM adapter has no language or prompt.
      [{ capabilities: VLLM }, { language: "en" }],
    ];
    for (const [overrides, config] of refusals) {
      const { session } = create(config);
      expect(await session.attach(target("cli-a", overrides))).toEqual({
        status: "failed",
        reason: "not_eligible",
        failure: "unsupported_capability",
      });
      expect(session.status).toBe("detached");
    }
    expect(cli.sends).toEqual([]);
    expect(realtimeTranscriptionCapability(SEGMENTED)?.adapter).toBe("segmented");
  });

  it("refuses a vLLM target when a queued update sets a language", async () => {
    const { link, create } = setup();
    link("cli-a");
    const { session } = create();
    expect(session.update({ language: "de" })).toEqual({ ok: true });
    expect((await session.attach(target("cli-a", { capabilities: VLLM }))).status).toBe("failed");
  });

  it("reports offline CLIs and endpoints that left the inventory", async () => {
    const { link, create, unavailable } = setup();
    const { session } = create();
    expect(await session.attach(target("nobody"))).toMatchObject({ reason: "offline" });
    link("cli-a");
    unavailable.add("inst-0123456789abcdef");
    expect(await session.attach(target("cli-a"))).toMatchObject({
      reason: "endpoint_unavailable",
      failure: "not_found",
    });
  });

  it("caps sessions per CLI, counting closing legs until stt.closed", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const sessions = [];
    for (let index = 0; index < STT_SESSIONS_PER_CLI; index += 1) {
      const { session } = create();
      await openOn(hub, cli, session);
      sessions.push(session);
    }
    const { session: extra } = create();
    expect(await extra.attach(target("cli-a"))).toMatchObject({
      status: "failed",
      reason: "cli_full",
      failure: "rate_limited",
    });
    const first = sessions[0];
    if (!first) throw new Error("no session");
    const firstId = first.relaySessionId ?? "";
    first.close();
    expect(await extra.attach(target("cli-a"))).toMatchObject({ reason: "cli_full" });
    frame(cli, hub, { type: "stt.closed", sessionId: firstId });
    const pending = extra.attach(target("cli-a"));
    expect(extra.status).toBe("opening");
    extra.close();
    expect(await pending).toEqual({ status: "ended" });
  });

  it("releases a closing leg after the grace period when stt.closed never comes", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session } = create();
    await openOn(hub, cli, session);
    session.close();
    expect(hub.stats()).toEqual({ sessions: 0, legs: 1 });
    vi.advanceTimersByTime(STT_CLOSE_GRACE_MS);
    expect(hub.stats()).toEqual({ sessions: 0, legs: 0 });
  });

  it("refuses a maxSessionMs the wire cannot carry", () => {
    const { hub } = setup();
    expect(() => hub.createSession({ consumer: new Recorder(), maxSessionMs: 999 })).toThrow(
      RangeError,
    );
  });

  it("caps sessions per server", () => {
    const { hub } = setup();
    for (let index = 0; index < STT_SESSIONS_SERVER_MAX; index += 1) {
      expect(hub.createSession({ consumer: new Recorder() }).ok).toBe(true);
    }
    expect(hub.createSession({ consumer: new Recorder() })).toEqual({
      ok: false,
      reason: "server_full",
    });
  });
});

describe("pre-open failover", () => {
  it("replays queued audio and commands, in order, on the next member after a refusal", async () => {
    const { hub, link, create } = setup();
    const first = link("cli-a");
    const second = link("cli-b");
    const { session, consumer } = create();
    session.appendAudio(pcm(6000, 1));
    expect(session.commit()).toEqual({ ok: true, itemSeq: 0 });
    session.appendAudio(pcm(4000, 2));
    expect(session.clear()).toEqual({ ok: true, itemSeq: 1 });
    session.appendAudio(pcm(5000, 3));
    expect(session.update({ language: "fr" })).toEqual({ ok: true });

    const attempt = session.attach(target("cli-a"));
    const firstId = session.relaySessionId ?? "";
    frame(first, hub, {
      type: "stt.error",
      sessionId: firstId,
      failure: "unsupported_capability",
      message: "no realtime route",
    });
    expect(await attempt).toEqual({
      status: "failed",
      reason: "refused",
      failure: "unsupported_capability",
      message: "no realtime route",
    });
    expect(first.timeline()).toEqual(["stt.open"]); // nothing but the open reached it
    expect(hub.stats().legs).toBe(0); // stt.error is terminal on the CLI

    const { sessionId, result } = await openOn(hub, second, session);
    expect(result.status).toBe("opened");
    expect(sessionId).not.toBe(firstId);
    // The cleared item's unsent audio never leaves the server.
    expect(second.timeline()).toEqual([
      "stt.open",
      "audio:6000",
      "stt.commit:0",
      "stt.clear:1",
      "audio:5000",
      "stt.update",
    ]);
    expect(second.audio().map((audio) => audio.seq)).toEqual([0, 1]);
    expect(consumer.ends).toEqual([]);
    // Late frames from the abandoned attempt are dropped.
    frame(first, hub, { type: "stt.opened", sessionId: firstId });
    expect(session.status).toBe("open");
  });

  it("times out an open, tells the CLI, and ignores its late answer", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session } = create();
    const attempt = session.attach(target("cli-a"));
    const legId = session.relaySessionId ?? "";
    vi.advanceTimersByTime(STT_OPEN_TIMEOUT_MS);
    expect(await attempt).toEqual({ status: "failed", reason: "timeout", failure: "timeout" });
    expect(cli.control("stt.close")).toEqual({
      type: "stt.close",
      sessionId: legId,
      reason: "timeout",
    });
    frame(cli, hub, { type: "stt.opened", sessionId: legId });
    expect(session.status).toBe("detached");
    expect(hub.stats().legs).toBe(1);
    frame(cli, hub, { type: "stt.closed", sessionId: legId });
    expect(hub.stats().legs).toBe(0);
  });

  it("cancelOpening withdraws an opening attempt (queue kept) and closes an open session", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session, consumer } = create();
    session.appendAudio(pcm(4096));
    const attempt = session.attach(target("cli-a"));
    const legId = session.relaySessionId;
    session.cancelOpening();
    expect(await attempt).toEqual({ status: "failed", reason: "aborted", failure: "cancelled" });
    expect(cli.controls().at(-1)).toEqual({
      type: "stt.close",
      sessionId: legId,
      reason: "cancelled",
    });
    expect(session.queuedAudioBytes).toBe(4096);
    const { sessionId } = await openOn(hub, cli, session);
    session.cancelOpening();
    expect(consumer.ends).toEqual([{ cause: "consumer", failure: "access_denied" }]);
    expect(cli.controls().at(-1)).toEqual({
      type: "stt.close",
      sessionId,
      reason: "access_denied",
    });
  });

  it("treats a non-finite open budget as the default, never an immediate timeout", async () => {
    const { link, create } = setup();
    link("cli-a");
    for (const openTimeoutMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const { session } = create();
      const attempt = session.attach(target("cli-a"), { openTimeoutMs });
      vi.advanceTimersByTime(STT_OPEN_TIMEOUT_MS - 1);
      expect(session.status).toBe("opening");
      vi.advanceTimersByTime(1);
      expect(await attempt).toMatchObject({ reason: "timeout" });
    }
  });

  it("honours a shorter per-attempt open budget and caps a longer one", async () => {
    const { link, create } = setup();
    link("cli-a");
    const { session } = create();
    const short = session.attach(target("cli-a"), { openTimeoutMs: 1_000 });
    vi.advanceTimersByTime(999);
    expect(session.status).toBe("opening");
    vi.advanceTimersByTime(1);
    expect(await short).toEqual({ status: "failed", reason: "timeout", failure: "timeout" });
    const long = session.attach(target("cli-a"), { openTimeoutMs: 60_000 });
    vi.advanceTimersByTime(STT_OPEN_TIMEOUT_MS);
    expect(await long).toMatchObject({ reason: "timeout" });
  });

  it("fails an opening attempt when the CLI disconnects, and the session can still open elsewhere", async () => {
    const { hub, link, create } = setup();
    const first = link("cli-a");
    const second = link("cli-b");
    const { session, consumer } = create();
    const attempt = session.attach(target("cli-a"));
    first.open = false;
    hub.linkLost(first);
    expect(await attempt).toEqual({
      status: "failed",
      reason: "disconnected",
      failure: "disconnected",
    });
    expect((await openOn(hub, second, session)).result.status).toBe("opened");
    expect(consumer.ends).toEqual([]);
  });

  it("treats an ack or event before stt.opened as a broken open", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session } = create();
    const attempt = session.attach(target("cli-a"));
    ack(cli, hub, session.relaySessionId ?? "", 2);
    expect(await attempt).toMatchObject({ reason: "protocol_error" });
    expect(cli.control("stt.close")).toMatchObject({ reason: "protocol_error" });
  });

  it("fails an attempt whose session id a malformed frame names", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session } = create();
    const attempt = session.attach(target("cli-a"));
    hub.malformed(cli, session.relaySessionId ?? "");
    expect(await attempt).toMatchObject({ status: "failed", reason: "protocol_error" });
  });
});

describe("audio flow control", () => {
  it("sends only within the byte credit, in frames of at most 32 KiB with seq +1", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session, consumer } = create();
    const { sessionId } = await openOn(hub, cli, session);
    const append = 300 * 1024;
    expect(session.appendAudio(pcm(append))).toEqual({ ok: true, backlogged: false });
    expect(cli.audioBytes()).toBe(STT_AUDIO_WINDOW_BYTES);
    for (const audio of cli.audio()) {
      expect(audio.body.byteLength).toBeLessThanOrEqual(STT_AUDIO_FRAME_MAX_BYTES);
      expect(audio.body.byteLength % 2).toBe(0);
    }
    expect(cli.audio().map((audio) => audio.seq)).toEqual([...cli.audio().keys()]);
    ack(cli, hub, sessionId, 32 * 1024);
    expect(cli.audioBytes()).toBe(STT_AUDIO_WINDOW_BYTES + 32 * 1024);
    ack(cli, hub, sessionId, STT_AUDIO_WINDOW_BYTES);
    expect(cli.audioBytes()).toBe(append);
    expect(cli.audio().map((audio) => audio.seq)).toEqual([...cli.audio().keys()]);
    expect(consumer.ends).toEqual([]);
  });

  it("pauses the consumer at the backlog limit and resumes it at half", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session, consumer } = create();
    const { sessionId } = await openOn(hub, cli, session);
    session.appendAudio(pcm(STT_AUDIO_WINDOW_BYTES)); // fills the credit
    expect(session.appendAudio(pcm(STT_PENDING_AUDIO_MAX_BYTES))).toEqual({
      ok: true,
      backlogged: true,
    });
    expect(session.appendAudio(pcm(2))).toEqual({ ok: false, reason: "backlog_full" });
    ack(cli, hub, sessionId, 64 * 1024);
    expect(consumer.drains).toBe(0);
    ack(cli, hub, sessionId, 96 * 1024);
    expect(consumer.drains).toBe(1);
    expect(session.appendAudio(pcm(2)).ok).toBe(true);
  });

  it("ends a session whose backlog stays full for 30 s", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session, consumer } = create();
    const { sessionId } = await openOn(hub, cli, session);
    session.appendAudio(pcm(STT_AUDIO_WINDOW_BYTES));
    expect(session.appendAudio(pcm(STT_PENDING_AUDIO_MAX_BYTES))).toMatchObject({
      backlogged: true,
    });
    vi.advanceTimersByTime(STT_BACKLOG_STALL_MS - 1);
    expect(consumer.ends).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(consumer.ends).toHaveLength(1);
    expect(consumer.ends).toEqual([{ cause: "audio_backlog", failure: "timeout" }]);
    expect(cli.controls().at(-1)).toEqual({ type: "stt.close", sessionId, reason: "timeout" });
  });

  it("coalesces small appends into frames of at least 4 KiB and flushes the rest", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session } = create();
    await openOn(hub, cli, session);
    for (let index = 0; index < 10; index += 1) session.appendAudio(pcm(960)); // 20 ms each
    expect(cli.audio().map((audio) => audio.body.byteLength)).toEqual([4800, 4800]);
    session.appendAudio(pcm(960));
    vi.advanceTimersByTime(STT_AUDIO_FLUSH_MS - 1);
    expect(cli.audio()).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(cli.audio().map((audio) => audio.body.byteLength)).toEqual([4800, 4800, 960]);
    for (const audio of cli.audio().slice(0, 2)) {
      expect(audio.body.byteLength).toBeGreaterThanOrEqual(STT_AUDIO_FRAME_MIN_BYTES);
    }
  });

  it("flushes the open item's audio before its commit", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session } = create();
    await openOn(hub, cli, session);
    session.appendAudio(pcm(1000));
    session.commit();
    expect(cli.timeline().slice(1)).toEqual(["audio:1000", "stt.commit:0"]);
  });

  it("keeps a commit behind audio that waits for credit", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session } = create();
    const { sessionId } = await openOn(hub, cli, session);
    session.appendAudio(pcm(STT_AUDIO_WINDOW_BYTES + 8192));
    session.commit();
    expect(cli.timeline()).not.toContain("stt.commit:0");
    ack(cli, hub, sessionId, 8192);
    expect(cli.timeline().slice(-2)).toEqual(["audio:8192", "stt.commit:0"]);
  });

  it("holds audio while the relay socket is congested", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session } = create();
    await openOn(hub, cli, session);
    cli.buffered = 2 * 1024 * 1024;
    session.appendAudio(pcm(8192));
    vi.advanceTimersByTime(100);
    expect(cli.audio()).toEqual([]);
    cli.buffered = 0;
    vi.advanceTimersByTime(25);
    expect(cli.audioBytes()).toBe(8192);
  });

  it("ends the session when an ack exceeds what is outstanding", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session, consumer } = create();
    const { sessionId } = await openOn(hub, cli, session);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    session.appendAudio(pcm(4096));
    ack(cli, hub, sessionId, 4098);
    expect(consumer.ends).toEqual([{ cause: "protocol_error", failure: "protocol_error" }]);
    expect(cli.controls().at(-1)).toEqual({
      type: "stt.close",
      sessionId,
      reason: "protocol_error",
    });
  });

  it("refuses odd, empty and oversized appends", () => {
    const { create } = setup();
    const { session } = create();
    expect(session.appendAudio(pcm(3))).toEqual({ ok: false, reason: "odd_length" });
    expect(session.appendAudio(pcm(0))).toEqual({ ok: false, reason: "empty" });
    expect(session.appendAudio(pcm(384 * 1024 + 2))).toEqual({ ok: false, reason: "too_large" });
  });
});

describe("item numbering", () => {
  it("numbers commits and clears alike and refuses empty commits", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session } = create();
    await openOn(hub, cli, session);
    expect(session.commit()).toEqual({ ok: false, reason: "empty" });
    session.appendAudio(pcm(100));
    expect(session.commit()).toEqual({ ok: true, itemSeq: 0 });
    expect(session.commit()).toEqual({ ok: false, reason: "empty" });
    expect(session.clear()).toEqual({ ok: true, itemSeq: 1 });
    session.appendAudio(pcm(100));
    expect(session.commit()).toEqual({ ok: true, itemSeq: 2 });
    expect(session.openItemSeq).toBe(3);
    expect(cli.timeline().filter((label) => label.startsWith("stt."))).toEqual([
      "stt.open",
      "stt.commit:0",
      "stt.clear:1",
      "stt.commit:2",
    ]);
  });

  it("maps the valve's auto_committed to one server commit and moves the next commit on", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session, consumer } = create();
    const { sessionId } = await openOn(hub, cli, session);
    // 12 s of audio against a 10 s turn.
    session.appendAudio(pcm(240_000));
    ack(cli, hub, sessionId, 240_000);
    session.appendAudio(pcm(336_000));
    ack(cli, hub, sessionId, 256 * 1024);
    event(cli, hub, sessionId, { kind: "auto_committed", itemSeq: 0 });
    expect(consumer.events).toEqual([{ kind: "auto_committed", itemSeq: 0 }]);
    expect(session.openItemSeq).toBe(1);
    expect(session.commit()).toEqual({ ok: true, itemSeq: 1 });
    event(cli, hub, sessionId, { kind: "delta", itemSeq: 0, text: "first" });
    event(cli, hub, sessionId, { kind: "completed", itemSeq: 0, text: "first" });
    // Item 0 is attributed the 10 s the CLI cut it at.
    expect(consumer.events.at(-1)).toEqual({
      kind: "completed",
      itemSeq: 0,
      text: "first",
      audioBytes: 480_000,
    });
  });

  it("never reports a second commit when the client's commit raced the valve", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session, consumer } = create();
    const { sessionId } = await openOn(hub, cli, session);
    session.appendAudio(pcm(4096));
    expect(session.commit()).toEqual({ ok: true, itemSeq: 0 });
    event(cli, hub, sessionId, { kind: "auto_committed", itemSeq: 0 });
    expect(consumer.events).toEqual([]);
    expect(session.openItemSeq).toBe(1);
    event(cli, hub, sessionId, {
      kind: "completed",
      itemSeq: 0,
      text: "t",
      engineUsage: { inputTokens: 3 },
    });
    expect(consumer.events).toEqual([
      {
        kind: "completed",
        itemSeq: 0,
        text: "t",
        audioBytes: 4096,
        engineUsage: { inputTokens: 3 },
      },
    ]);
  });

  it("forwards live deltas of the open item and drops results of cleared items", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session, consumer } = create();
    const { sessionId } = await openOn(hub, cli, session, { capabilities: VLLM });
    session.appendAudio(pcm(4096));
    event(cli, hub, sessionId, { kind: "delta", itemSeq: 0, text: "hel" });
    expect(session.clear()).toEqual({ ok: true, itemSeq: 0 });
    // A clear that raced the valve: the CLI still transcribes the item.
    event(cli, hub, sessionId, { kind: "auto_committed", itemSeq: 0 });
    event(cli, hub, sessionId, { kind: "delta", itemSeq: 0, text: "lo" });
    event(cli, hub, sessionId, { kind: "completed", itemSeq: 0, text: "hello" });
    expect(consumer.events).toEqual([{ kind: "delta", itemSeq: 0, text: "hel" }]);
    expect(consumer.ends).toEqual([]);
  });

  it("drops duplicate results and ends the session on results for items not ended or not started", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const cases: Extract<SttClientMessage, { type: "stt.event" }>["event"][] = [
      { kind: "completed", itemSeq: 1, text: "x" }, // the open item
      { kind: "delta", itemSeq: 2, text: "x" }, // a future item
      { kind: "auto_committed", itemSeq: 2 },
      { kind: "failed", itemSeq: 1, code: "engine_error", message: "m" },
    ];
    for (const bad of cases) {
      const { session, consumer } = create();
      const { sessionId } = await openOn(hub, cli, session);
      session.appendAudio(pcm(10));
      session.commit();
      event(cli, hub, sessionId, { kind: "failed", itemSeq: 0, code: "upstream_4xx", message: "" });
      event(cli, hub, sessionId, { kind: "completed", itemSeq: 0, text: "late" });
      expect(consumer.events).toEqual([
        { kind: "failed", itemSeq: 0, code: "upstream_4xx", message: "" },
      ]);
      event(cli, hub, sessionId, bad);
      expect(consumer.ends).toEqual([{ cause: "protocol_error", failure: "protocol_error" }]);
      frame(cli, hub, { type: "stt.closed", sessionId });
    }
  });

  it("bounds items awaiting results and queued commands", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session } = create();
    await openOn(hub, cli, session);
    for (let index = 0; index < STT_PENDING_ITEMS_MAX; index += 1) {
      session.appendAudio(pcm(2));
      expect(session.commit().ok).toBe(true);
    }
    session.appendAudio(pcm(2));
    expect(session.commit()).toEqual({ ok: false, reason: "too_many_items" });

    const { session: queued } = create();
    for (let index = 0; index < STT_PENDING_CONTROLS_MAX; index += 1) {
      expect(queued.clear().ok).toBe(true);
    }
    expect(queued.clear()).toEqual({ ok: false, reason: "control_backlog" });
    expect(queued.update({})).toEqual({ ok: false, reason: "control_backlog" });
  });

  it("refuses a language update on an open vLLM session", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session } = create();
    await openOn(hub, cli, session, { capabilities: VLLM });
    expect(session.update({ language: "en" })).toEqual({ ok: false, reason: "unsupported" });
    expect(session.update({})).toEqual({ ok: true });
  });
});

describe("closing on every hop", () => {
  it("client close: stt.close{cancelled}, one onEnd, and nothing after", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session, consumer } = create();
    const { sessionId } = await openOn(hub, cli, session);
    session.close();
    session.close();
    expect(consumer.ends).toEqual([{ cause: "consumer", failure: "cancelled" }]);
    expect(cli.controls().at(-1)).toEqual({ type: "stt.close", sessionId, reason: "cancelled" });
    event(cli, hub, sessionId, { kind: "delta", itemSeq: 0, text: "late" });
    expect(consumer.events).toEqual([]);
    expect(session.appendAudio(pcm(2))).toEqual({ ok: false, reason: "ended" });
    expect(session.commit()).toEqual({ ok: false, reason: "ended" });
    expect(await session.attach(target("cli-a"))).toEqual({ status: "ended" });
  });

  it.each([
    [
      { type: "stt.error", failure: "upstream_5xx", message: "engine" },
      { cause: "upstream_error", failure: "upstream_5xx", message: "engine" },
    ],
    [{ type: "stt.closed" }, { cause: "upstream_closed", failure: "unknown" }],
  ] as const)("a CLI end (%o) ends the session without a stt.close", async (message, end) => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session, consumer } = create();
    const { sessionId } = await openOn(hub, cli, session);
    frame(cli, hub, { ...message, sessionId } as SttClientMessage);
    expect(consumer.ends).toEqual([end]);
    expect(cli.timeline()).toEqual(["stt.open"]);
    expect(hub.stats()).toEqual({ sessions: 0, legs: 0 });
  });

  it("a CLI disconnect fails every session on it and only those", async () => {
    const { hub, link, create } = setup();
    const first = link("cli-a");
    const second = link("cli-b");
    const a = create();
    const b = create();
    const c = create();
    await openOn(hub, first, a.session);
    await openOn(hub, first, b.session);
    await openOn(hub, second, c.session);
    first.open = false;
    hub.linkLost(first);
    expect(a.consumer.ends).toEqual([{ cause: "disconnected", failure: "disconnected" }]);
    expect(b.consumer.ends).toEqual([{ cause: "disconnected", failure: "disconnected" }]);
    expect(c.consumer.ends).toEqual([]);
    expect(hub.stats()).toEqual({ sessions: 1, legs: 1 });
  });

  it("a malformed frame naming an open session ends it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session, consumer } = create();
    const { sessionId } = await openOn(hub, cli, session);
    hub.malformed(link("other"), sessionId); // another CLI cannot name it
    expect(consumer.ends).toEqual([]);
    hub.malformed(cli, sessionId);
    expect(consumer.ends).toEqual([{ cause: "protocol_error", failure: "protocol_error" }]);
  });

  it("frames from another CLI for this session are dropped", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const other = link("cli-b");
    const { session, consumer } = create();
    const { sessionId } = await openOn(hub, cli, session);
    frame(other, hub, { type: "stt.closed", sessionId });
    expect(consumer.ends).toEqual([]);
  });

  it("shutdown ends every session, tells the CLI and refuses new ones", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const open = create();
    const detached = create();
    const { sessionId } = await openOn(hub, cli, open.session);
    hub.closeAll();
    expect(open.consumer.ends).toEqual([{ cause: "shutdown", failure: "cancelled" }]);
    expect(detached.consumer.ends).toEqual([{ cause: "shutdown", failure: "cancelled" }]);
    expect(cli.controls().at(-1)).toEqual({ type: "stt.close", sessionId, reason: "cancelled" });
    expect(hub.createSession({ consumer: new Recorder() })).toEqual({
      ok: false,
      reason: "shutting_down",
    });
  });

  it("ends at maxSessionMs", async () => {
    const { hub, link } = setup();
    const cli = link("cli-a");
    const consumer = new Recorder();
    const created = hub.createSession({ consumer, maxSessionMs: 60_000 });
    if (!created.ok) throw new Error("full");
    const { sessionId } = await openOn(hub, cli, created.session);
    expect(cli.control("stt.open").maxSessionMs).toBe(60_000);
    vi.advanceTimersByTime(60_000);
    expect(consumer.ends).toEqual([{ cause: "expired", failure: "timeout" }]);
    expect(cli.controls().at(-1)).toEqual({ type: "stt.close", sessionId, reason: "timeout" });
  });

  it("an endpoint that leaves the inventory ends its sessions", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session, consumer } = create();
    const { sessionId } = await openOn(hub, cli, session);
    hub.endpointsChanged(cli, new Set(["inst-0123456789abcdef"]));
    expect(consumer.ends).toEqual([]);
    hub.endpointsChanged(cli, new Set());
    expect(consumer.ends).toEqual([{ cause: "endpoint_unavailable", failure: "not_found" }]);
    expect(cli.controls().at(-1)).toEqual({ type: "stt.close", sessionId, reason: "not_found" });
  });

  it("a failing send ends the session as a transport failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session, consumer } = create();
    await openOn(hub, cli, session);
    cli.open = false;
    session.appendAudio(pcm(8192));
    expect(consumer.ends).toEqual([{ cause: "disconnected", failure: "transport" }]);
  });

  it("a throwing consumer never breaks the relay", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { hub, link } = setup();
    const cli = link("cli-a");
    const created = hub.createSession({
      consumer: {
        onEvent() {
          throw new Error("consumer bug");
        },
        onDrain() {},
        onEnd() {
          throw new Error("consumer bug");
        },
      },
    });
    if (!created.ok) throw new Error("full");
    const { sessionId } = await openOn(hub, cli, created.session);
    created.session.appendAudio(pcm(2));
    created.session.commit();
    event(cli, hub, sessionId, { kind: "completed", itemSeq: 0, text: "secret words" });
    created.session.close();
    expect(errors).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("secret");
  });
});

describe("privacy", () => {
  it("never logs audio or transcript text", async () => {
    const logs = [
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
    ];
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session } = create({ prompt: "PRIVATE_PROMPT" });
    const { sessionId } = await openOn(hub, cli, session);
    session.appendAudio(new TextEncoder().encode("PRIVATE_AUDIO_"));
    session.commit();
    event(cli, hub, sessionId, { kind: "delta", itemSeq: 0, text: "PRIVATE_TEXT" });
    event(cli, hub, sessionId, { kind: "delta", itemSeq: 5, text: "PRIVATE_TEXT" });
    frame(cli, hub, {
      type: "stt.error",
      sessionId,
      failure: "upstream_5xx" as RelayFailure,
      message: "PRIVATE_MESSAGE",
    });
    const logged = JSON.stringify(logs.flatMap((log) => log.mock.calls));
    expect(logged).not.toContain("PRIVATE");
  });
});

describe("review fixes", () => {
  it("M1: refuses configs the wire would refuse, at update and at create, and queues nothing", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session } = create();
    expect(session.update({ prompt: "x".repeat(70_000) })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(session.update({ language: "not a language!!" })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(session.update({ prompt: "\uD800" })).toEqual({ ok: false, reason: "invalid" });
    const { result } = await openOn(hub, cli, session);
    expect(result.status).toBe("opened");
    session.appendAudio(pcm(4096));
    expect(cli.timeline()).toEqual(["stt.open", "audio:4096"]);
    expect(hub.createSession({ consumer: new Recorder(), config: { language: "en us" } })).toEqual({
      ok: false,
      reason: "invalid_config",
    });
  });

  it("M1: an invariant break inside the pump ends the session instead of throwing from a timer", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session, consumer } = create();
    const { sessionId } = await openOn(hub, cli, session);
    session.appendAudio(pcm(100)); // waits for the flush timer
    cli.bufferedAmount = () => {
      throw new Error("broken link");
    };
    expect(() => vi.advanceTimersByTime(STT_AUDIO_FLUSH_MS)).not.toThrow();
    expect(consumer.ends).toEqual([{ cause: "protocol_error", failure: "protocol_error" }]);
    expect(cli.controls().at(-1)).toEqual({
      type: "stt.close",
      sessionId,
      reason: "protocol_error",
    });
    expect(errors).toHaveBeenCalled();
  });

  it("M2: tiny appends are stored contiguously and reassemble byte for byte", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session } = create();
    const { sessionId } = await openOn(hub, cli, session);
    session.appendAudio(pcm(STT_AUDIO_WINDOW_BYTES)); // all credit used
    let appended = 0;
    let value = 0;
    while (true) {
      const sample = new Uint8Array([value & 0xff, (value >> 8) & 0xff]);
      value += 1;
      const result = session.appendAudio(sample);
      if (!result.ok) break;
      appended += 2;
    }
    expect(appended).toBe(STT_PENDING_AUDIO_MAX_BYTES);
    expect(session.queuedAudioBytes).toBe(STT_PENDING_AUDIO_MAX_BYTES);
    // Blocks, not one object per append: at most one partly filled block.
    expect(session.queuedAudioCapacityBytes).toBeLessThanOrEqual(
      STT_PENDING_AUDIO_MAX_BYTES + 32 * 1024,
    );
    const before = cli.audio().length;
    ack(cli, hub, sessionId, STT_AUDIO_WINDOW_BYTES);
    const sent = cli.audio().slice(before);
    const bytes = new Uint8Array(sent.reduce((total, frame) => total + frame.body.byteLength, 0));
    let offset = 0;
    for (const frame of sent) {
      bytes.set(frame.body, offset);
      offset += frame.body.byteLength;
    }
    expect(bytes.byteLength).toBe(STT_PENDING_AUDIO_MAX_BYTES);
    for (let index = 0; index < bytes.byteLength / 2; index += 1) {
      const sample = (bytes[index * 2] ?? 0) | ((bytes[index * 2 + 1] ?? 0) << 8);
      if (sample !== (index & 0xffff)) throw new Error(`sample ${index} is ${sample}`);
    }
    expect(session.queuedAudioCapacityBytes).toBe(0);
  });

  it("M2: the caller's buffer may be reused after an append", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session } = create();
    const buffer = pcm(1000, 7);
    session.appendAudio(buffer);
    buffer.fill(9);
    await openOn(hub, cli, session);
    session.commit();
    expect([...new Set(cli.audio()[0]?.body)]).toEqual([7]);
  });

  it("M3: reports a link idle once its last active leg ends, and closing legs are not work", async () => {
    const { hub, link, create, idle } = setup();
    const cli = link("cli-a");
    const a = create();
    const b = create();
    await openOn(hub, cli, a.session);
    await openOn(hub, cli, b.session);
    a.session.close();
    expect(idle).toEqual([]);
    expect(hub.hasActiveLegs(cli)).toBe(true);
    b.session.close();
    expect(idle).toEqual([cli]);
    expect(hub.hasActiveLegs(cli)).toBe(false);
    expect(hub.stats().legs).toBe(2); // still closing, counted against the CLI cap
  });

  it("L1: a commit that raced the valve leaves the post-cut audio committable", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session, consumer } = create();
    const { sessionId } = await openOn(hub, cli, session); // 10 s turns
    for (const bytes of [240_000, 240_000, 24_000]) {
      session.appendAudio(pcm(bytes)); // 10.5 s sent in all
      ack(cli, hub, sessionId, bytes);
    }
    expect(session.commit()).toEqual({ ok: true, itemSeq: 0 });
    event(cli, hub, sessionId, { kind: "auto_committed", itemSeq: 0 });
    expect(consumer.events).toEqual([]); // still no second commit
    expect(session.commit()).toEqual({ ok: true, itemSeq: 1 });
    event(cli, hub, sessionId, { kind: "completed", itemSeq: 0, text: "a" });
    event(cli, hub, sessionId, { kind: "completed", itemSeq: 1, text: "b" });
    expect(consumer.events).toEqual([
      { kind: "completed", itemSeq: 0, text: "a", audioBytes: 480_000 },
      { kind: "completed", itemSeq: 1, text: "b", audioBytes: 24_000 },
    ]);
  });

  it("L1: a raced commit with nothing past the cut still refuses an empty commit", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session } = create();
    const { sessionId } = await openOn(hub, cli, session);
    session.appendAudio(pcm(4096));
    ack(cli, hub, sessionId, 4096);
    session.commit();
    event(cli, hub, sessionId, { kind: "auto_committed", itemSeq: 0 });
    expect(session.commit()).toEqual({ ok: false, reason: "empty" });
  });

  it("L2: the caller sees opened before onEnd when the first send fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { hub, link } = setup();
    const cli = link("cli-a");
    const order: string[] = [];
    const created = hub.createSession({
      consumer: {
        onEvent() {},
        onDrain() {},
        onEnd: (end) => order.push(`end:${end.cause}`),
      },
    });
    if (!created.ok) throw new Error("full");
    const session = created.session;
    session.appendAudio(pcm(8192));
    const attempt = session.attach(target("cli-a"));
    const sessionId = session.relaySessionId ?? "";
    cli.send = () => {
      throw new Error("socket gone");
    };
    // A real caller is already awaiting when stt.opened arrives.
    const observed = (async () => {
      order.push(`attach:${(await attempt).status}`);
    })();
    frame(cli, hub, { type: "stt.opened", sessionId });
    expect(order).toEqual([]);
    await observed;
    await Promise.resolve();
    expect(order).toEqual(["attach:opened", "end:disconnected"]);
  });

  it("L3: the session clock starts at the first stt.open and failover sends the time left", async () => {
    const { hub, link } = setup();
    const first = link("cli-a");
    const second = link("cli-b");
    const consumer = new Recorder();
    const created = hub.createSession({ consumer, maxSessionMs: 60_000 });
    if (!created.ok) throw new Error("full");
    const session = created.session;
    const attempt = session.attach(target("cli-a"));
    vi.advanceTimersByTime(STT_OPEN_TIMEOUT_MS); // a slow handshake, then failover
    expect((await attempt).status).toBe("failed");
    const { result } = await openOn(hub, second, session);
    expect(result.status).toBe("opened");
    expect(second.control("stt.open").maxSessionMs).toBe(60_000 - STT_OPEN_TIMEOUT_MS);
    vi.advanceTimersByTime(60_000 - STT_OPEN_TIMEOUT_MS - 1);
    expect(consumer.ends).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(consumer.ends).toEqual([{ cause: "expired", failure: "timeout" }]);
    expect(first.control("stt.open").maxSessionMs).toBe(60_000);
  });

  it("L3: no attempt starts with less than a second left", async () => {
    const { hub, link } = setup();
    link("cli-a");
    link("cli-b");
    const consumer = new Recorder();
    const created = hub.createSession({ consumer, maxSessionMs: 16_000 });
    if (!created.ok) throw new Error("full");
    const attempt = created.session.attach(target("cli-a"));
    vi.advanceTimersByTime(STT_OPEN_TIMEOUT_MS + 500);
    expect((await attempt).status).toBe("failed");
    expect(await created.session.attach(target("cli-b"))).toEqual({ status: "ended" });
    expect(consumer.ends).toEqual([{ cause: "expired", failure: "timeout" }]);
  });
});

describe("security review fixes", () => {
  it("L2: a held open sends nothing until released, and a cancel withdraws it with its queue", async () => {
    const { hub, link, create } = setup();
    const a = link("cli-a");
    const b = link("cli-b");
    const { session, consumer } = create();
    session.appendAudio(pcm(8192));
    expect(session.clear().ok).toBe(true);
    session.appendAudio(pcm(8192));
    const first = session.attach(target("cli-a"), { holdUntilReleased: true });
    const legA = String(session.relaySessionId);
    frame(a, hub, { type: "stt.opened", sessionId: legA });
    expect(await first).toMatchObject({ status: "opened" });
    expect(a.timeline()).toEqual(["stt.open"]);
    session.cancelOpening();
    expect(a.controls().at(-1)).toEqual({
      type: "stt.close",
      sessionId: legA,
      reason: "cancelled",
    });
    expect(session.status).toBe("detached");
    expect(consumer.ends).toEqual([]);
    expect(session.queuedAudioBytes).toBe(8192);

    const second = session.attach(target("cli-b"), { holdUntilReleased: true });
    const legB = String(session.relaySessionId);
    frame(b, hub, { type: "stt.opened", sessionId: legB });
    expect(await second).toMatchObject({ status: "opened" });
    session.appendAudio(pcm(8192));
    expect(b.timeline()).toEqual(["stt.open"]);
    session.releaseHold();
    // The clear dropped the first item's unsent audio, as it does unheld.
    expect(b.timeline()).toEqual(["stt.open", "stt.clear:0", "audio:16384"]);
    expect(b.audio().map((sent) => sent.seq)).toEqual([0]);
  });

  it("L2: once anything was sent, a cancel closes the session instead", async () => {
    const { hub, link, create } = setup();
    const a = link("cli-a");
    const { session, consumer } = create();
    session.appendAudio(pcm(8192));
    const pending = session.attach(target("cli-a"), { holdUntilReleased: true });
    frame(a, hub, { type: "stt.opened", sessionId: String(session.relaySessionId) });
    await pending;
    session.releaseHold();
    session.cancelOpening();
    expect(consumer.ends).toEqual([{ cause: "consumer", failure: "access_denied" }]);
  });

  it("L3: commands count until the CLI shows it took them, as the CLI counts them", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session } = create();
    const { sessionId } = await openOn(hub, cli, session);
    for (let index = 0; index < STT_PENDING_CONTROLS_MAX; index += 1) {
      expect(session.clear().ok).toBe(true);
    }
    // All sent, none taken yet: the CLI would refuse one more.
    expect(cli.controls().filter((sent) => sent.type === "stt.clear")).toHaveLength(
      STT_PENDING_CONTROLS_MAX,
    );
    expect(session.clear()).toEqual({ ok: false, reason: "control_backlog" });
    expect(session.update({})).toEqual({ ok: false, reason: "control_backlog" });
    session.appendAudio(pcm(4096));
    expect(session.commit()).toEqual({ ok: false, reason: "control_backlog" });
    // An ack for audio sent after them: the CLI's thread took them all.
    ack(cli, hub, sessionId, 4096);
    expect(session.commit().ok).toBe(true);
    for (let index = 1; index < STT_PENDING_CONTROLS_MAX; index += 1) {
      expect(session.clear().ok).toBe(true);
    }
    expect(session.clear()).toEqual({ ok: false, reason: "control_backlog" });
    // The committed item's result shows its commit (and what came before) was taken.
    const committed = STT_PENDING_CONTROLS_MAX;
    event(cli, hub, sessionId, { kind: "completed", itemSeq: committed, text: "x" });
    expect(session.clear().ok).toBe(true);
    expect(session.clear()).toEqual({ ok: false, reason: "control_backlog" });
  });

  it("L3: a result for a commit that raced the valve does not count the commit as taken", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session } = create();
    const { sessionId } = await openOn(hub, cli, session);
    session.appendAudio(pcm(4096));
    expect(session.commit()).toEqual({ ok: true, itemSeq: 0 });
    event(cli, hub, sessionId, { kind: "auto_committed", itemSeq: 0 });
    event(cli, hub, sessionId, { kind: "completed", itemSeq: 0, text: "x" });
    for (let index = 1; index < STT_PENDING_CONTROLS_MAX; index += 1) {
      expect(session.clear().ok).toBe(true);
    }
    expect(session.clear()).toEqual({ ok: false, reason: "control_backlog" });
  });

  it("L3: frames in flight are bounded by count, so tiny flushes wait for acks", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session } = create();
    const { sessionId } = await openOn(hub, cli, session);
    for (let index = 0; index <= STT_AUDIO_FRAMES_IN_FLIGHT_MAX; index += 1) {
      session.appendAudio(pcm(2));
      vi.advanceTimersByTime(STT_AUDIO_FLUSH_MS);
    }
    expect(cli.audio()).toHaveLength(STT_AUDIO_FRAMES_IN_FLIGHT_MAX);
    expect(session.queuedAudioBytes).toBe(2);
    ack(cli, hub, sessionId, 2);
    vi.advanceTimersByTime(STT_AUDIO_FLUSH_MS);
    expect(cli.audio()).toHaveLength(STT_AUDIO_FRAMES_IN_FLIGHT_MAX + 1);
  });

  it("L4: deltas past the per-item bound are dropped; the result still arrives", async () => {
    const { hub, link, create } = setup();
    const cli = link("cli-a");
    const { session, consumer } = create();
    const { sessionId } = await openOn(hub, cli, session, { capabilities: VLLM });
    session.appendAudio(pcm(4096));
    const piece = "é".repeat(4096); // 8 KiB of UTF-8
    const pieces = STT_ITEM_DELTA_MAX_BYTES / Buffer.byteLength(piece);
    for (let index = 0; index < pieces + 2; index += 1) {
      event(cli, hub, sessionId, { kind: "delta", itemSeq: 0, text: piece });
    }
    expect(consumer.events.filter((sent) => sent.kind === "delta")).toHaveLength(pieces);
    session.commit();
    event(cli, hub, sessionId, { kind: "completed", itemSeq: 0, text: "done" });
    expect(consumer.events.at(-1)).toMatchObject({ kind: "completed", itemSeq: 0 });
    // The next item has its own budget.
    session.appendAudio(pcm(4096));
    event(cli, hub, sessionId, { kind: "delta", itemSeq: 1, text: piece });
    expect(consumer.events.at(-1)).toMatchObject({ kind: "delta", itemSeq: 1 });
  });
});
