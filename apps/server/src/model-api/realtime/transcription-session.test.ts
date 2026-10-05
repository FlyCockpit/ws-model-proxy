import type { OpenAiCompatibleCapabilities } from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRelayBinaryFrame } from "../../relay/protocol.js";
import type { RelayFailure } from "../../relay/relay-failure.js";
import {
  STT_AUDIO_WINDOW_BYTES,
  STT_PENDING_AUDIO_MAX_BYTES,
  type SttClientMessage,
  SttRelayHub,
  type SttRelayLink,
} from "../../relay/stt-relay.js";
import { RealtimeSessionCounters } from "./limits.js";
import {
  openFailureMarksMember,
  REALTIME_EVENT_RATE_MAX,
  REALTIME_EVENT_RATE_WINDOW_MS,
  REALTIME_IDLE_TIMEOUT_MS,
  REALTIME_OPEN_ATTEMPT_MS,
  REALTIME_ROUTING_DEADLINE_MS,
  type RealtimeCandidate,
  type RealtimeRouteResult,
  type RealtimeRouter,
  type RealtimeSessionHooks,
  RealtimeTranscriptionSession,
} from "./transcription-session.js";

/** A CLI relay connection (no network). */
class FakeLink implements SttRelayLink {
  open = true;
  buffered = 0;
  sends: (string | ArrayBuffer)[] = [];
  constructor(readonly cliDeviceId: string) {}
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
  opens(): Record<string, unknown>[] {
    return this.controls().filter((message) => message.type === "stt.open");
  }
  audioBytes(): number {
    return this.sends
      .filter((send): send is ArrayBuffer => typeof send !== "string")
      .reduce((total, send) => total + parseRelayBinaryFrame(send).body.byteLength, 0);
  }
}

/** The client WebSocket. */
class FakeClient {
  events: Record<string, unknown>[] = [];
  closes: { code: number; reason: string }[] = [];
  paused = 0;
  resumed = 0;
  buffered = 0;
  send(text: string) {
    this.events.push(JSON.parse(text) as Record<string, unknown>);
  }
  close(code: number, reason: string) {
    this.closes.push({ code, reason });
  }
  pause() {
    this.paused += 1;
  }
  resume() {
    this.resumed += 1;
  }
  bufferedAmount() {
    return this.buffered;
  }
  types(): string[] {
    return this.events.map((event) => String(event.type));
  }
  last(type: string): Record<string, unknown> {
    const found = this.events.filter((event) => event.type === type).at(-1);
    if (!found) throw new Error(`no ${type}`);
    return found;
  }
  errorCodes(): unknown[] {
    return this.events
      .filter((event) => event.type === "error")
      .map((event) => (event.error as { code: unknown }).code);
  }
}

class FakeRouter implements RealtimeRouter {
  result: Promise<RealtimeRouteResult> | RealtimeRouteResult = { ok: true, candidates: [] };
  calls: unknown[] = [];
  failures: [string, RelayFailure][] = [];
  async candidates(input: { model: string }) {
    this.calls.push(input.model);
    return this.result;
  }
  memberOpenFailed(candidate: RealtimeCandidate, failure: RelayFailure) {
    this.failures.push([candidate.cliDeviceId, failure]);
  }
}

function caps(adapter: "segmented" | "vllm"): OpenAiCompatibleCapabilities {
  return {
    version: 2,
    protocol: "openai-compatible",
    audio: { transcriptions: { supported: true, realtime: { supported: true, adapter } } },
  } as OpenAiCompatibleCapabilities;
}

function candidate(
  cliDeviceId: string,
  adapter: "segmented" | "vllm" = "segmented",
): RealtimeCandidate {
  return {
    cliDeviceId,
    endpointSlug: "inst-0123456789abcdef",
    upstreamModel: "whisper-large",
    capabilities: caps(adapter),
    deploymentManaged: true,
    memberId: `member-${cliDeviceId}`,
  };
}

function b64(bytes: number, fill = 1): string {
  return Buffer.alloc(bytes, fill).toString("base64");
}

function setup({
  initialModel = null,
  hooks,
}: {
  initialModel?: string | null;
  hooks?: RealtimeSessionHooks;
} = {}) {
  const links = new Map<string, FakeLink>();
  const hub = new SttRelayHub({
    resolveLink(cliDeviceId) {
      const link = links.get(cliDeviceId);
      return link?.open ? { ok: true, link } : { ok: false, reason: "offline" };
    },
  });
  const link = (id: string) => {
    const created = new FakeLink(id);
    links.set(id, created);
    return created;
  };
  const client = new FakeClient();
  const router = new FakeRouter();
  const counters = new RealtimeSessionCounters();
  const admitted = counters.acquire({ tokenId: "token", userId: "user" });
  if (!admitted.ok) throw new Error("admission");
  const session = new RealtimeTranscriptionSession({
    client,
    router,
    relay: { createSttSession: (input) => hub.createSession(input) },
    admission: admitted.admission,
    initialModel,
    ...(hooks ? { hooks } : {}),
  });
  const text = (event: unknown) => session.handleText(JSON.stringify(event));
  const cliFrame = (cli: FakeLink, message: SttClientMessage) =>
    hub.handleClientFrame(cli, message);
  /** Answers the latest open on `cli` with `stt.opened`. */
  const openOn = async (cli: FakeLink) => {
    await vi.advanceTimersByTimeAsync(0);
    const open = cli.opens().at(-1);
    if (!open) throw new Error("no stt.open");
    const sessionId = String(open.sessionId);
    cliFrame(cli, { type: "stt.opened", sessionId });
    await vi.advanceTimersByTimeAsync(0);
    return sessionId;
  };
  return { hub, link, client, router, counters, session, text, cliFrame, openOn };
}

const MODEL_UPDATE = {
  type: "session.update",
  session: { type: "transcription", audio: { input: { transcription: { model: "whisper" } } } },
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("realtime transcription session: setup and routing", () => {
  it("announces the session, routes on the model, and opens on a member", async () => {
    const t = setup();
    const cli = t.link("cli-a");
    t.router.result = { ok: true, candidates: [candidate("cli-a")] };
    t.session.start();
    expect(t.client.last("session.created")).toMatchObject({
      session: { audio: { input: { transcription: { model: null }, turn_detection: null } } },
    });
    t.text(MODEL_UPDATE);
    expect(t.client.last("session.updated")).toMatchObject({
      session: { audio: { input: { transcription: { model: "whisper" } } } },
    });
    expect(t.session.status).toBe("routing");
    await t.openOn(cli);
    expect(t.router.calls).toEqual(["whisper"]);
    expect(cli.opens()[0]).toMatchObject({ adapter: "segmented", upstreamModel: "whisper-large" });
    expect(t.session.status).toBe("open");
    expect(t.client.closes).toEqual([]);
  });

  it("routes at once with ?model= and refuses audio before a model is known", async () => {
    const t = setup();
    t.session.start();
    t.text({ type: "input_audio_buffer.append", audio: b64(100) });
    expect(t.client.errorCodes()).toEqual(["model_required"]);
    const q = setup({ initialModel: "whisper" });
    q.link("cli-a");
    q.router.result = { ok: true, candidates: [candidate("cli-a")] };
    q.session.start();
    expect(q.session.status).toBe("routing");
  });

  it("buffers audio while routing and sends it once the member opens", async () => {
    const t = setup({ initialModel: "whisper" });
    const cli = t.link("cli-a");
    t.router.result = { ok: true, candidates: [candidate("cli-a")] };
    t.session.start();
    t.text({ type: "input_audio_buffer.append", audio: b64(8192) });
    t.text({ type: "input_audio_buffer.commit" });
    expect(cli.audioBytes()).toBe(0);
    await t.openOn(cli);
    expect(cli.audioBytes()).toBe(8192);
    expect(cli.controls().map((message) => message.type)).toEqual(["stt.open", "stt.commit"]);
  });

  it("fails over past a broken member and reports only health failures (L4)", async () => {
    const t = setup({ initialModel: "whisper" });
    const busy = t.link("cli-busy");
    const broken = t.link("cli-broken");
    const good = t.link("cli-good");
    t.router.result = {
      ok: true,
      candidates: [candidate("cli-busy"), candidate("cli-broken"), candidate("cli-good")],
    };
    t.session.start();
    await vi.advanceTimersByTimeAsync(0);
    const refuse = (cli: FakeLink, failure: RelayFailure) =>
      t.cliFrame(cli, {
        type: "stt.error",
        sessionId: String(cli.opens().at(-1)?.sessionId),
        failure,
      });
    refuse(busy, "rate_limited");
    await vi.advanceTimersByTimeAsync(0);
    refuse(broken, "upstream_5xx");
    await t.openOn(good);
    expect(t.session.status).toBe("open");
    expect(t.router.failures).toEqual([["cli-broken", "upstream_5xx"]]);
  });

  it("tries at most three opens, then closes 1011", async () => {
    const t = setup({ initialModel: "whisper" });
    const ids = ["a", "b", "c", "d"];
    const clis = ids.map((id) => t.link(id));
    t.router.result = { ok: true, candidates: ids.map((id) => candidate(id)) };
    t.session.start();
    for (const cli of clis.slice(0, 3)) {
      await vi.advanceTimersByTimeAsync(0);
      t.cliFrame(cli, {
        type: "stt.error",
        sessionId: String(cli.opens().at(-1)?.sessionId),
        failure: "transport",
      });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(clis[3]?.opens()).toEqual([]);
    expect(t.client.errorCodes()).toEqual(["upstream_unavailable"]);
    expect(t.client.closes).toEqual([{ code: 1011, reason: "upstream_unavailable" }]);
    expect(t.counters.count("server")).toBe(0);
  });

  it("closes 1013 server_busy when every member is at capacity", async () => {
    const t = setup({ initialModel: "whisper" });
    const cli = t.link("a");
    t.router.result = { ok: true, candidates: [candidate("a")] };
    t.session.start();
    await vi.advanceTimersByTimeAsync(0);
    t.cliFrame(cli, {
      type: "stt.error",
      sessionId: String(cli.opens()[0]?.sessionId),
      failure: "rate_limited",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.client.closes).toEqual([{ code: 1013, reason: "server_busy" }]);
    expect(t.router.failures).toEqual([]);
  });

  it.each([
    ["model_not_found", 1008],
    ["external_variant_unsupported", 1008],
    ["no_live_member", 1013],
  ] as const)("maps the routing refusal %s to close %d", async (code, close) => {
    const t = setup({ initialModel: "whisper" });
    t.router.result = { ok: false, code };
    t.session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.client.closes[0]?.code).toBe(close);
    expect(t.client.events.at(-1)?.type).toBe("error");
    expect(t.counters.count("server")).toBe(0);
  });

  it("M1 probe: a member that never answers is skipped and marked, and the next one opens", async () => {
    const t = setup({ initialModel: "whisper" });
    const hung = t.link("hung");
    const healthy = t.link("healthy");
    t.router.result = { ok: true, candidates: [candidate("hung"), candidate("healthy")] };
    t.session.start();
    await vi.advanceTimersByTimeAsync(REALTIME_OPEN_ATTEMPT_MS);
    expect(hung.controls().at(-1)).toMatchObject({ type: "stt.close", reason: "timeout" });
    expect(t.router.failures).toEqual([["hung", "timeout"]]);
    await t.openOn(healthy);
    expect(t.session.status).toBe("open");
    expect(t.client.closes).toEqual([]);
  });

  it("enforces the 10 s routing deadline and marks the member whose open it cut", async () => {
    const t = setup({ initialModel: "whisper" });
    const clis = ["a", "b", "c"].map((id) => t.link(id));
    t.router.result = { ok: true, candidates: ["a", "b", "c"].map((id) => candidate(id)) };
    t.session.start();
    await vi.advanceTimersByTimeAsync(REALTIME_ROUTING_DEADLINE_MS - 1);
    expect(t.client.closes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.client.closes).toEqual([{ code: 1013, reason: "server_busy" }]);
    // a and b timed out on their own budgets; the deadline cut c.
    expect(t.router.failures).toEqual([
      ["a", "timeout"],
      ["b", "timeout"],
      ["c", "timeout"],
    ]);
    expect(clis[2]?.controls().at(-1)).toMatchObject({ type: "stt.close", reason: "cancelled" });
    expect(clis[2]?.opens()[0]).toBeTruthy();
    expect(t.hub.stats().sessions).toBe(0);
    expect(t.counters.count("server")).toBe(0);
  });

  it("enforces the deadline while the router itself hangs", async () => {
    const t = setup({ initialModel: "whisper" });
    t.router.result = new Promise(() => {});
    t.session.start();
    await vi.advanceTimersByTimeAsync(REALTIME_ROUTING_DEADLINE_MS);
    expect(t.client.closes).toEqual([{ code: 1013, reason: "server_busy" }]);
  });

  it("refuses a model change once routing started, and keeps the session", async () => {
    const t = setup({ initialModel: "whisper" });
    t.link("a");
    t.router.result = { ok: true, candidates: [candidate("a")] };
    t.session.start();
    t.text({
      type: "session.update",
      event_id: "u2",
      session: { type: "transcription", audio: { input: { transcription: { model: "other" } } } },
    });
    expect(t.client.last("error")).toMatchObject({
      error: { code: "invalid_value", event_id: "u2" },
    });
    expect(t.session.status).toBe("routing");
  });

  it("refuses a language on an open vLLM session", async () => {
    const t = setup({ initialModel: "whisper" });
    const cli = t.link("a");
    t.router.result = { ok: true, candidates: [candidate("a", "vllm")] };
    t.session.start();
    await t.openOn(cli);
    t.text({
      type: "session.update",
      session: { type: "transcription", audio: { input: { transcription: { language: "en" } } } },
    });
    expect(t.client.last("error")).toMatchObject({
      error: { code: "unsupported_parameter", param: "session.audio.input.transcription.language" },
    });
  });

  it("relays a language change on a segmented session as stt.update", async () => {
    const t = setup({ initialModel: "whisper" });
    const cli = t.link("a");
    t.router.result = { ok: true, candidates: [candidate("a")] };
    t.session.start();
    await t.openOn(cli);
    t.text({
      type: "session.update",
      session: { type: "transcription", audio: { input: { transcription: { language: "de" } } } },
    });
    expect(cli.controls().at(-1)).toMatchObject({ type: "stt.update", config: { language: "de" } });
    expect(t.client.last("session.updated")).toMatchObject({
      session: { audio: { input: { transcription: { language: "de" } } } },
    });
  });
});

describe("realtime transcription session: items", () => {
  async function opened(adapter: "segmented" | "vllm" = "segmented") {
    const t = setup({ initialModel: "whisper" });
    const cli = t.link("a");
    t.router.result = { ok: true, candidates: [candidate("a", adapter)] };
    t.session.start();
    const sessionId = await t.openOn(cli);
    const event = (sttEvent: Extract<SttClientMessage, { type: "stt.event" }>["event"]) =>
      t.cliFrame(cli, { type: "stt.event", sessionId, event: sttEvent });
    return { ...t, cli, sessionId, event };
  }

  it("commits items with chained ids and reports results with duration usage", async () => {
    const t = await opened();
    t.text({ type: "input_audio_buffer.append", audio: b64(48_000) });
    t.text({ type: "input_audio_buffer.commit" });
    t.text({ type: "input_audio_buffer.append", audio: b64(24_000) });
    t.text({ type: "input_audio_buffer.commit" });
    const committed = t.client.events.filter(
      (event) => event.type === "input_audio_buffer.committed",
    );
    expect(committed).toHaveLength(2);
    const [first, second] = committed;
    expect(first?.previous_item_id).toBeNull();
    expect(second?.previous_item_id).toBe(first?.item_id);
    t.event({ kind: "completed", itemSeq: 0, text: "one" });
    t.event({ kind: "failed", itemSeq: 1, code: "upstream_4xx", message: "bad audio" });
    expect(t.client.last("conversation.item.input_audio_transcription.completed")).toMatchObject({
      item_id: first?.item_id,
      transcript: "one",
      usage: { type: "duration", seconds: 1 },
    });
    expect(t.client.last("conversation.item.done")).toMatchObject({
      item: { id: first?.item_id, content: [{ transcript: "one" }] },
    });
    expect(t.client.last("conversation.item.input_audio_transcription.failed")).toMatchObject({
      item_id: second?.item_id,
      error: { type: "transcription_error", code: "upstream_4xx" },
    });
  });

  it("gives live vLLM deltas the item id the later commit announces", async () => {
    const t = await opened("vllm");
    t.text({ type: "input_audio_buffer.append", audio: b64(8192) });
    t.event({ kind: "delta", itemSeq: 0, text: "hel" });
    t.text({ type: "input_audio_buffer.commit" });
    const delta = t.client.last("conversation.item.input_audio_transcription.delta");
    expect(t.client.last("input_audio_buffer.committed").item_id).toBe(delta.item_id);
    expect(delta).toMatchObject({ delta: "hel", content_index: 0 });
  });

  it("announces the valve's auto commit as a server-originated commit", async () => {
    const t = await opened();
    t.text({ type: "input_audio_buffer.append", audio: b64(8192) });
    t.event({ kind: "auto_committed", itemSeq: 0 });
    expect(t.client.types()).toContain("input_audio_buffer.committed");
    expect(t.client.types()).toContain("conversation.item.added");
  });

  it("refuses an empty commit and clears with input_audio_buffer.cleared", async () => {
    const t = await opened();
    t.text({ type: "input_audio_buffer.commit", event_id: "c1" });
    expect(t.client.last("error")).toMatchObject({
      error: { code: "input_audio_buffer_commit_empty", event_id: "c1" },
    });
    t.text({ type: "input_audio_buffer.append", audio: b64(100) });
    t.text({ type: "input_audio_buffer.clear" });
    expect(t.client.types().at(-1)).toBe("input_audio_buffer.cleared");
    expect(t.cli.controls().at(-1)).toMatchObject({ type: "stt.clear", itemSeq: 0 });
  });

  it("fails pending items, then closes 1011 when the CLI disconnects", async () => {
    const t = await opened();
    t.text({ type: "input_audio_buffer.append", audio: b64(8192) });
    t.text({ type: "input_audio_buffer.commit" });
    t.text({ type: "input_audio_buffer.append", audio: b64(8192) });
    t.cli.open = false;
    t.hub.linkLost(t.cli);
    const failed = t.client.events.filter(
      (event) => event.type === "conversation.item.input_audio_transcription.failed",
    );
    // L2: only the committed item is failed; the open item's id was never announced.
    expect(failed).toHaveLength(1);
    expect(failed[0]?.item_id).toBe(t.client.last("input_audio_buffer.committed").item_id);
    expect(t.client.types().at(-1)).toBe("error");
    expect(t.client.errorCodes()).toEqual(["upstream_disconnected"]);
    expect(t.client.closes).toEqual([{ code: 1011, reason: "upstream_disconnected" }]);
    expect(t.counters.count("server")).toBe(0);
  });
});

describe("realtime transcription session: backpressure and limits", () => {
  async function opened() {
    const t = setup({ initialModel: "whisper" });
    const cli = t.link("a");
    t.router.result = { ok: true, candidates: [candidate("a")] };
    t.session.start();
    const sessionId = await t.openOn(cli);
    return { ...t, cli, sessionId };
  }

  it("pauses the client when the backlog fills and resumes after replaying in order", async () => {
    const t = await opened();
    const chunk = 128 * 1024;
    const appends = (STT_AUDIO_WINDOW_BYTES + STT_PENDING_AUDIO_MAX_BYTES) / chunk;
    for (let index = 0; index < appends; index += 1) {
      t.text({ type: "input_audio_buffer.append", audio: b64(chunk) });
    }
    expect(t.client.paused).toBe(1);
    // Read before the pause took hold: kept in order behind the backlog.
    t.text({ type: "input_audio_buffer.append", audio: b64(chunk) });
    t.text({ type: "input_audio_buffer.commit" });
    expect(t.cli.controls().some((message) => message.type === "stt.commit")).toBe(false);
    // The CLI acknowledges every frame it got, until nothing is outstanding.
    for (let acked = 0; acked < t.cli.audioBytes(); acked += 32 * 1024) {
      t.cliFrame(t.cli, { type: "stt.audio.ack", sessionId: t.sessionId, bytes: 32 * 1024 });
    }
    expect(t.client.resumed).toBe(1);
    expect(t.cli.audioBytes()).toBe((appends + 1) * chunk);
    expect(t.cli.controls().at(-1)).toMatchObject({ type: "stt.commit", itemSeq: 0 });
    expect(t.client.last("input_audio_buffer.committed")).toBeTruthy();
  });

  it("closes 1013 audio_backlog when the client keeps sending while paused", async () => {
    const t = await opened();
    const chunk = 128 * 1024;
    for (let index = 0; index < 4; index += 1) {
      t.text({ type: "input_audio_buffer.append", audio: b64(chunk) });
    }
    for (let index = 0; index < 4; index += 1) {
      t.text({ type: "input_audio_buffer.append", audio: b64(chunk) });
    }
    expect(t.client.closes).toEqual([{ code: 1013, reason: "audio_backlog" }]);
  });

  it("drops events over 400 per 10 s and closes after three such windows", async () => {
    const t = await opened();
    const burst = () => {
      for (let index = 0; index <= REALTIME_EVENT_RATE_MAX; index += 1) {
        t.text({ type: "input_audio_buffer.clear" });
      }
    };
    burst();
    expect(t.client.errorCodes()).toEqual(["rate_limited"]);
    expect(t.client.closes).toEqual([]);
    vi.advanceTimersByTime(REALTIME_EVENT_RATE_WINDOW_MS);
    burst();
    vi.advanceTimersByTime(REALTIME_EVENT_RATE_WINDOW_MS);
    burst();
    expect(t.client.closes).toEqual([{ code: 1008, reason: "rate_limited" }]);
  });

  it("closes 1000 idle_timeout after 120 s without audio", async () => {
    const t = await opened();
    vi.advanceTimersByTime(REALTIME_IDLE_TIMEOUT_MS);
    expect(t.client.errorCodes()).toEqual(["idle_timeout"]);
    expect(t.client.closes).toEqual([{ code: 1000, reason: "idle_timeout" }]);
    expect(t.cli.controls().at(-1)).toMatchObject({ type: "stt.close", reason: "timeout" });
  });

  it("closes 1013 slow_consumer when the client stops reading", async () => {
    const t = await opened();
    t.client.buffered = 2 * 1024 * 1024;
    t.text({ type: "input_audio_buffer.commit" });
    expect(t.client.closes).toEqual([{ code: 1013, reason: "slow_consumer" }]);
  });

  it("client close tells the CLI and releases the admission once", async () => {
    const t = await opened();
    t.session.clientClosed();
    t.session.clientClosed();
    expect(t.cli.controls().at(-1)).toMatchObject({ type: "stt.close", reason: "cancelled" });
    expect(t.client.closes).toEqual([]);
    expect(t.counters.count({ tokenId: "token" })).toBe(0);
  });

  it("terminate (access lost) sends an error, closes 1008 and stt.close{access_denied}", async () => {
    const t = await opened();
    t.session.terminate(1008, {
      type: "invalid_request_error",
      code: "invalid_api_key",
      message: "The API key was revoked.",
    });
    expect(t.client.errorCodes()).toEqual(["invalid_api_key"]);
    expect(t.client.closes).toEqual([{ code: 1008, reason: "invalid_api_key" }]);
    expect(t.cli.controls().at(-1)).toMatchObject({ type: "stt.close", reason: "access_denied" });
  });

  it("maps a server shutdown to 1001", async () => {
    const t = await opened();
    t.hub.closeAll();
    expect(t.client.closes).toEqual([{ code: 1001, reason: "server_shutting_down" }]);
  });

  it("answers binary frames with an error and never logs audio or text", async () => {
    const logs = ["error", "warn", "info", "log"].map((name) =>
      vi.spyOn(console, name as "error").mockImplementation(() => undefined),
    );
    const t = await opened();
    t.session.handleBinary();
    expect(t.client.errorCodes()).toEqual(["invalid_event"]);
    t.text({
      type: "input_audio_buffer.append",
      audio: Buffer.from("PRIVATE_AUDIO_").toString("base64"),
    });
    t.text({ type: "nope", secret: "PRIVATE_FIELD" });
    t.text({ type: "input_audio_buffer.commit" });
    t.cliFrame(t.cli, {
      type: "stt.event",
      sessionId: t.sessionId,
      event: { kind: "completed", itemSeq: 0, text: "PRIVATE_TEXT" },
    });
    expect(JSON.stringify(logs.flatMap((log) => log.mock.calls))).not.toContain("PRIVATE");
  });
});

describe("open failure classification (L4)", () => {
  it("marks members only for health failures of real opens", () => {
    const failed = (
      reason: "refused" | "timeout" | "cli_full" | "offline",
      failure: RelayFailure,
    ) => openFailureMarksMember({ status: "failed", reason, failure });
    expect(failed("refused", "upstream_5xx")).toBe(true);
    expect(failed("refused", "unsupported_capability")).toBe(true);
    expect(failed("timeout", "timeout")).toBe(true);
    expect(failed("refused", "rate_limited")).toBe(false);
    expect(failed("refused", "not_found")).toBe(false);
    expect(failed("cli_full", "rate_limited")).toBe(false);
    expect(failed("offline", "disconnected")).toBe(false);
  });
});

describe("review fixes (6a)", () => {
  it("M2: admits each candidate, binds the lease on open, releases it on failure and at the end", async () => {
    const log: string[] = [];
    const hooks: RealtimeSessionHooks = {
      async admit(target) {
        log.push(`admit:${target.cliDeviceId}`);
        if (target.cliDeviceId === "full") return { ok: false };
        return { ok: true, lease: { release: () => log.push(`release:${target.cliDeviceId}`) } };
      },
      opened(target, info) {
        log.push(`opened:${target.cliDeviceId}:${info.adapter}:${info.lease ? "lease" : "none"}`);
      },
      itemFinished(outcome) {
        log.push(
          `item:${outcome.status}:${outcome.audioSeconds}:${outcome.engineUsage?.outputTokens}`,
        );
      },
      ended(outcome) {
        log.push(
          `ended:${outcome.candidate?.cliDeviceId}:${outcome.closeCode}:${outcome.sentAudioBytes}`,
        );
      },
    };
    const t = setup({ initialModel: "whisper", hooks });
    t.link("full");
    const bad = t.link("bad");
    const good = t.link("good");
    t.router.result = {
      ok: true,
      candidates: [candidate("full"), candidate("bad"), candidate("good")],
    };
    t.session.start();
    await vi.advanceTimersByTimeAsync(0);
    t.cliFrame(bad, {
      type: "stt.error",
      sessionId: String(bad.opens()[0]?.sessionId),
      failure: "upstream_5xx",
    });
    const sessionId = await t.openOn(good);
    t.text({ type: "input_audio_buffer.append", audio: b64(48_000) });
    t.text({ type: "input_audio_buffer.commit" });
    t.cliFrame(good, {
      type: "stt.event",
      sessionId,
      event: { kind: "completed", itemSeq: 0, text: "x", engineUsage: { outputTokens: 7 } },
    });
    t.session.clientClosed();
    expect(log).toEqual([
      "admit:full",
      "admit:bad",
      "release:bad",
      "admit:good",
      "opened:good:segmented:lease",
      "item:completed:1:7",
      "release:good",
      "ended:good:null:48000",
    ]);
  });

  it("M2: a lease granted after the deadline is released at once", async () => {
    let grant: ((value: { ok: true; lease: { release(): void } }) => void) | undefined;
    const released = vi.fn();
    const t = setup({
      initialModel: "whisper",
      hooks: {
        admit: () =>
          new Promise((resolve) => {
            grant = resolve;
          }),
      },
    });
    t.link("a");
    t.router.result = { ok: true, candidates: [candidate("a")] };
    t.session.start();
    await vi.advanceTimersByTimeAsync(REALTIME_ROUTING_DEADLINE_MS);
    expect(t.client.closes).toEqual([{ code: 1013, reason: "server_busy" }]);
    grant?.({ ok: true, lease: { release: released } });
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("M2: a throwing hook never breaks the session", async () => {
    const t = setup({
      initialModel: "whisper",
      hooks: {
        opened() {
          throw new Error("hook bug");
        },
        ended() {
          throw new Error("hook bug");
        },
      },
    });
    const cli = t.link("a");
    t.router.result = { ok: true, candidates: [candidate("a")] };
    t.session.start();
    await t.openOn(cli);
    expect(t.session.status).toBe("open");
    expect(() => t.session.clientClosed()).not.toThrow();
  });

  it("L1: a language update while routing is answered only once open (vLLM: refused, still open)", async () => {
    const t = setup({ initialModel: "whisper" });
    const cli = t.link("a");
    t.router.result = { ok: true, candidates: [candidate("a", "vllm")] };
    t.session.start();
    t.text({
      type: "session.update",
      event_id: "lang",
      session: { type: "transcription", audio: { input: { transcription: { language: "en" } } } },
    });
    expect(t.client.types()).toEqual(["session.created"]);
    await t.openOn(cli);
    expect(cli.opens()[0]?.config).toEqual({});
    expect(t.client.last("error")).toMatchObject({
      error: { code: "unsupported_parameter", event_id: "lang" },
    });
    expect(t.client.types()).not.toContain("session.updated");
    expect(t.session.status).toBe("open");
  });

  it("L1: a held update on a segmented member is applied once open", async () => {
    const t = setup({ initialModel: "whisper" });
    const cli = t.link("a");
    t.router.result = { ok: true, candidates: [candidate("a")] };
    t.session.start();
    t.text({
      type: "session.update",
      session: { type: "transcription", audio: { input: { transcription: { prompt: "names" } } } },
    });
    await t.openOn(cli);
    expect(cli.controls().at(-1)).toMatchObject({
      type: "stt.update",
      config: { prompt: "names" },
    });
    expect(t.client.last("session.updated")).toMatchObject({
      session: { audio: { input: { transcription: { prompt: "names" } } } },
    });
  });

  it("L1: a language set with the model on a vLLM-only model closes 1008 unsupported_parameter, not 1011", async () => {
    const t = setup();
    t.link("a");
    t.router.result = { ok: true, candidates: [candidate("a", "vllm")] };
    t.session.start();
    t.text({
      type: "session.update",
      session: {
        type: "transcription",
        audio: { input: { transcription: { model: "whisper", language: "en" } } },
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.client.closes).toEqual([{ code: 1008, reason: "unsupported_parameter" }]);
  });

  it("L2: a relay end fails items named by a delta, not silent open audio", async () => {
    const t = setup({ initialModel: "whisper" });
    const cli = t.link("a");
    t.router.result = { ok: true, candidates: [candidate("a", "vllm")] };
    t.session.start();
    const sessionId = await t.openOn(cli);
    t.text({ type: "input_audio_buffer.append", audio: b64(8192) });
    t.cliFrame(cli, {
      type: "stt.event",
      sessionId,
      event: { kind: "delta", itemSeq: 0, text: "h" },
    });
    t.cliFrame(cli, { type: "stt.error", sessionId, failure: "upstream_5xx" });
    const failed = t.client.events.filter(
      (event) => event.type === "conversation.item.input_audio_transcription.failed",
    );
    expect(failed.map((event) => event.item_id)).toEqual([
      t.client.last("conversation.item.input_audio_transcription.delta").item_id,
    ]);
  });
});
