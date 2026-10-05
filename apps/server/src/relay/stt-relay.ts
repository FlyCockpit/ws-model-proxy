import { randomBytes } from "node:crypto";
import type { OpenAiCompatibleCapabilities } from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import {
  type RealtimeTranscriptionAdapter,
  realtimeMaxItemSeconds,
} from "@ws-model-proxy/api/lib/transcription-profile";
import {
  encodeRelayBinaryFrame,
  encodeRelayServerControlMessage,
  type RelayClientControlMessage,
} from "./protocol.js";
import type { RelayFailure } from "./relay-failure.js";
import {
  STT_AUDIO_FRAME_MAX_BYTES,
  STT_ITEM_SEQ_MAX,
  STT_MAX_SESSION_MS_MAX,
  STT_MAX_SESSION_MS_MIN,
  type SttConfig,
  type SttEvent,
  type SttServerControlMessage,
  sttConfigSchema,
} from "./stt-protocol.js";

/**
 * Server side of live speech-to-text relay sessions (design §3-§5, §9).
 *
 * A {@link SttRelaySession} is one client session. It owns the audio queue,
 * the item numbering and the flow control, and survives failed open attempts:
 * each attempt is a *leg* on one CLI with its own relay `sessionId`, so a late
 * frame from an abandoned attempt can never be mistaken for the live one.
 * Nothing queued is sent before `stt.opened`, so a pre-open failover replays
 * the whole queue (audio, commits, clears, updates) to the next member.
 *
 * The consumer (chunk 6, the OpenAI Realtime protocol) sees normalized events
 * with item numbers; it maps them to `item_<id>`s. Item numbering follows the
 * CLI exactly (design, "Chunk 3 review fixes"):
 * - items are numbered from 0; a commit or a clear ends the open item and the
 *   next audio belongs to the next number (a clear uses up a number too);
 * - `auto_committed{N}` for the open item ends it on the server as well, and
 *   is reported once; the client's next commit then names N+1. An
 *   `auto_committed` for an item the server already ended (a commit or clear
 *   raced the valve) is ignored, so no second `committed` is ever reported;
 * - the server never sends a commit or clear for an item after the open one.
 *
 * Results of a cleared item are dropped: the client asked for that audio to
 * be discarded. Events for items the server no longer tracks are late and are
 * dropped; events for items that have not started are a protocol error.
 *
 * Bounded everywhere: queued audio ({@link STT_PENDING_AUDIO_MAX_BYTES} plus
 * one append), queued commands, items awaiting results, legs per CLI and
 * sessions per server. Audio and transcript text are never logged.
 */

/** Byte credit granted in `stt.open` (about 2.7 s of 24 kHz s16 mono). */
export const STT_AUDIO_WINDOW_BYTES = 256 * 1024;
/** Audio is coalesced into frames of at least this size, unless a flush is due. */
export const STT_AUDIO_FRAME_MIN_BYTES = 4 * 1024;
/** A smaller remainder waits at most this long for more audio. */
export const STT_AUDIO_FLUSH_MS = 100;
/** Audio queued on the server and not yet sent: the pre-open buffer and the backlog. */
export const STT_PENDING_AUDIO_MAX_BYTES = 256 * 1024;
/** One decoded client append (512 KiB of base64). */
export const STT_APPEND_MAX_BYTES = 384 * 1024;
/** Commands (commit, clear, update) queued behind audio. Matches the CLI's own cap. */
export const STT_PENDING_CONTROLS_MAX = 64;
/** Items ended and awaiting their result. */
export const STT_PENDING_ITEMS_MAX = 64;
/** No `stt.opened` within this: the attempt fails and the next member may be tried. */
export const STT_OPEN_TIMEOUT_MS = 15_000;
/** A closed leg still counts on its CLI until `stt.closed`, at most this long. */
export const STT_CLOSE_GRACE_MS = 5_000;
/** The backlog stayed full this long: the engine is slower than real time. */
export const STT_BACKLOG_STALL_MS = 30_000;
/** Server-side cap per CLI connection (the CLI enforces 8 too). */
export const STT_SESSIONS_PER_CLI = 8;
/** Server-wide cap on live sessions in this process. */
export const STT_SESSIONS_SERVER_MAX = 256;
/** Default `maxSessionMs` (design D6). */
export const STT_MAX_SESSION_MS = 30 * 60 * 1000;
/** Audio waits while the relay socket holds more than this (mirrors the sealed-frame limit). */
export const STT_RELAY_BUFFER_LIMIT = 1024 * 1024;
const STT_RELAY_BUSY_RETRY_MS = 25;
/** 24 kHz s16le mono. */
export const STT_PCM_BYTES_PER_SECOND = 48_000;

export type SttClientMessage = Extract<RelayClientControlMessage, { type: `stt.${string}` }>;

/** One CLI relay connection as the hub sees it. Identity is the key. */
export interface SttRelayLink {
  readonly cliDeviceId: string;
  isOpen(): boolean;
  bufferedAmount(): number;
  send(data: string | ArrayBuffer): void;
}

export type SttLinkResolution =
  | { ok: true; link: SttRelayLink }
  | { ok: false; reason: "offline" | "draining" | "endpoint_unavailable" };

export type SttHubDeps = {
  /** The live, registered connection of a CLI whose current inventory has the endpoint. */
  resolveLink(cliDeviceId: string, endpointSlug: string): SttLinkResolution;
  /**
   * The link has no opening or open legs left (closing ones may remain).
   * Called synchronously from inside the hub; defer any work that re-enters it.
   */
  onLinkIdle?(link: SttRelayLink): void;
};

/** A candidate member, as routing (chunk 6) found it. */
export type SttAttachTarget = {
  cliDeviceId: string;
  endpointSlug: string;
  upstreamModel: string;
  /** The endpoint's effective capabilities. Only `audio.transcriptions.realtime` is read. */
  capabilities: OpenAiCompatibleCapabilities | null | undefined;
  /** The server's deployment records own this endpoint (recipe-managed members only). */
  deploymentManaged: boolean;
};

export type SttOpenFailureReason =
  | "not_eligible"
  | "offline"
  | "draining"
  | "endpoint_unavailable"
  | "cli_full"
  | "send_failed"
  | "refused"
  | "timeout"
  | "disconnected"
  | "protocol_error";

export type SttAttachResult =
  | { status: "opened"; adapter: RealtimeTranscriptionAdapter; maxItemSeconds: number }
  /** Nothing was sent to an engine: the caller may try the next candidate. */
  | { status: "failed"; reason: SttOpenFailureReason; failure: RelayFailure; message?: string }
  /** The session ended while opening (closed by its consumer, or shutdown). */
  | { status: "ended" };

export type SttSessionEvent =
  | { kind: "delta"; itemSeq: number; text: string }
  /** The valve (or the engine) ended the open item: a server-originated commit. */
  | { kind: "auto_committed"; itemSeq: number }
  | {
      kind: "completed";
      itemSeq: number;
      text: string;
      /** PCM bytes the server sent for the item (approximate across a valve split). */
      audioBytes: number;
      engineUsage?: Extract<SttEvent, { kind: "completed" }>["engineUsage"];
    }
  | { kind: "failed"; itemSeq: number; code: string; message: string };

export type SttSessionEndCause =
  /** The consumer called `close` (client close, lease lost, access revoked, ...). */
  | "consumer"
  | "shutdown"
  | "expired"
  | "audio_backlog"
  /** `stt.error` after open: the engine or the CLI failed. */
  | "upstream_error"
  /** The CLI ended the session without being asked (`stt.closed`). */
  | "upstream_closed"
  /** The endpoint left the CLI's inventory (deployment stopped). */
  | "endpoint_unavailable"
  | "disconnected"
  | "protocol_error";

export type SttSessionEnd = {
  cause: SttSessionEndCause;
  failure: RelayFailure;
  /** The CLI's bounded message, if any. Never log it. */
  message?: string;
};

export interface SttSessionConsumer {
  onEvent(event: SttSessionEvent): void;
  /** Queued audio fell to half the limit after a backlogged append: resume reading. */
  onDrain(): void;
  /** Exactly once, for every end; nothing is called after it. */
  onEnd(end: SttSessionEnd): void;
}

export type SttAppendResult =
  | { ok: true; backlogged: boolean }
  | { ok: false; reason: "ended" | "empty" | "odd_length" | "too_large" | "backlog_full" };

export type SttItemResult =
  | { ok: true; itemSeq: number }
  | {
      ok: false;
      reason: "ended" | "empty" | "too_many_items" | "control_backlog" | "exhausted";
    };

export type SttUpdateResult =
  | { ok: true }
  | { ok: false; reason: "ended" | "control_backlog" | "unsupported" | "invalid" };

export type SttCreateResult =
  | { ok: true; session: SttRelaySession }
  | { ok: false; reason: "server_full" | "shutting_down" | "invalid_config" };

type Timer = ReturnType<typeof setTimeout>;

function startTimer(ms: number, run: () => void): Timer {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return timer;
}

function newSessionId(): string {
  return randomBytes(16).toString("base64url");
}

function configEmpty(config: SttConfig): boolean {
  return config.language === undefined && config.prompt === undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? (error.constructor?.name ?? "Error") : typeof error;
}

/** The realtime block of `audio.transcriptions` only (never translations), when supported. */
export function realtimeTranscriptionCapability(
  capabilities: OpenAiCompatibleCapabilities | null | undefined,
) {
  const transcriptions = capabilities?.audio?.transcriptions;
  if (!transcriptions || typeof transcriptions !== "object") return null;
  const realtime = transcriptions.realtime;
  return realtime?.supported === true ? realtime : null;
}

/**
 * Why a candidate can never take this session, or null. Recipe-managed
 * endpoints only (chunk 3 decision): the CLI refuses any other.
 */
export function sttTargetRefusal(
  target: SttAttachTarget,
  configs: readonly SttConfig[],
): string | null {
  if (!target.deploymentManaged || !target.endpointSlug.startsWith("inst-")) {
    return "not a recipe-managed endpoint";
  }
  const realtime = realtimeTranscriptionCapability(target.capabilities);
  if (!realtime) return "no live transcription capability";
  if (realtime.adapter === "vllm" && configs.some((config) => !configEmpty(config))) {
    return "the vllm adapter takes no language or prompt";
  }
  return null;
}

type Leg = {
  sessionId: string;
  link: SttRelayLink;
  endpointSlug: string;
  state: "opening" | "open" | "closing";
  owner: SttRelaySession | null;
  timer: Timer | null;
};

/** Legs by relay session id and by CLI connection. */
class LegRegistry {
  readonly bySessionId = new Map<string, Leg>();
  readonly byLink = new Map<SttRelayLink, Set<Leg>>();

  constructor(private readonly onLinkIdle: ((link: SttRelayLink) => void) | undefined) {}

  countOn(link: SttRelayLink): number {
    return this.byLink.get(link)?.size ?? 0;
  }

  /** Opening and open legs; closing ones only wait for `stt.closed`. */
  activeOn(link: SttRelayLink): number {
    let active = 0;
    for (const leg of this.byLink.get(link) ?? []) if (leg.state !== "closing") active += 1;
    return active;
  }

  private noteIdle(link: SttRelayLink) {
    if (!this.onLinkIdle || this.activeOn(link) > 0) return;
    try {
      this.onLinkIdle(link);
    } catch (error) {
      console.error("[stt] idle callback failed", describeError(error));
    }
  }

  add(leg: Leg) {
    this.bySessionId.set(leg.sessionId, leg);
    let set = this.byLink.get(leg.link);
    if (!set) {
      set = new Set();
      this.byLink.set(leg.link, set);
    }
    set.add(leg);
  }

  remove(leg: Leg) {
    if (leg.timer) clearTimeout(leg.timer);
    leg.timer = null;
    leg.owner = null;
    if (this.bySessionId.get(leg.sessionId) === leg) this.bySessionId.delete(leg.sessionId);
    const set = this.byLink.get(leg.link);
    if (set?.delete(leg)) {
      if (set.size === 0) this.byLink.delete(leg.link);
      this.noteIdle(leg.link);
    }
  }

  /**
   * The server is done with a leg. With a reason it tells the CLI
   * (`stt.close`) and keeps the leg counted until `stt.closed` or the grace
   * period; without one (the CLI already ended it, or the link is gone) it
   * forgets the leg now.
   */
  retire(leg: Leg, reason: RelayFailure | null) {
    if (leg.timer) clearTimeout(leg.timer);
    leg.timer = null;
    leg.owner = null;
    if (reason === null || !leg.link.isOpen()) {
      this.remove(leg);
      return;
    }
    try {
      leg.link.send(
        encodeRelayServerControlMessage({ type: "stt.close", sessionId: leg.sessionId, reason }),
      );
    } catch (error) {
      console.error("[stt] close could not be sent", describeError(error));
      this.remove(leg);
      return;
    }
    leg.state = "closing";
    leg.timer = startTimer(STT_CLOSE_GRACE_MS, () => this.remove(leg));
    this.noteIdle(leg.link);
  }
}

type QueueEntry =
  | AudioEntry
  | {
      kind: "control";
      message:
        | { type: "stt.update"; config: SttConfig }
        | { type: "stt.commit"; itemSeq: number }
        | { type: "stt.clear"; itemSeq: number };
    };

/**
 * Queued audio is copied into blocks it owns (4 KiB to 32 KiB), so memory
 * tracks the queued bytes however small the appends are. Data runs from
 * `readOffset` in the first block to `writeLen` in the last.
 */
type AudioEntry = {
  kind: "audio";
  itemSeq: number;
  blocks: Uint8Array[];
  readOffset: number;
  writeLen: number;
  bytes: number;
};

const AUDIO_BLOCK_MIN_BYTES = 4 * 1024;
const AUDIO_BLOCK_MAX_BYTES = 32 * 1024;

function writeAudio(entry: AudioEntry, pcm: Uint8Array) {
  let source = 0;
  while (source < pcm.byteLength) {
    const last = entry.blocks.at(-1);
    const space = last ? last.byteLength - entry.writeLen : 0;
    if (!last || space === 0) {
      const remaining = pcm.byteLength - source;
      let size = AUDIO_BLOCK_MIN_BYTES;
      while (size < remaining && size < AUDIO_BLOCK_MAX_BYTES) size *= 2;
      entry.blocks.push(new Uint8Array(size));
      entry.writeLen = 0;
      continue;
    }
    const take = Math.min(space, pcm.byteLength - source);
    last.set(pcm.subarray(source, source + take), entry.writeLen);
    entry.writeLen += take;
    source += take;
  }
  entry.bytes += pcm.byteLength;
}

type ItemRecord = { sentBytes: number; ended: boolean };

export class SttRelaySession {
  private state: "detached" | "opening" | "open" | "ended" = "detached";
  private leg: Leg | null = null;
  private attachResolve: ((result: SttAttachResult) => void) | null = null;
  private adapter: RealtimeTranscriptionAdapter | null = null;
  private maxItemSeconds = 0;

  private readonly queue: QueueEntry[] = [];
  private pendingAudio = 0;
  private pendingControls = 0;
  private backlogged = false;
  private stallTimer: Timer | null = null;
  private flushTimer: Timer | null = null;
  private flushDue = false;
  private busyTimer: Timer | null = null;
  private expiryTimer: Timer | null = null;
  private pumping = false;
  /** Set from `opened` until the awaiting caller has seen the `opened` result. */
  private openedUnobserved = false;
  /** Absolute end of the session; its clock starts with the first `stt.open` sent. */
  private deadlineMs: number | null = null;

  private seq = 0;
  private outstanding = 0;
  private sent = 0;

  private openSeq = 0;
  private openHasAudio = false;
  /** The open item and the ended items awaiting a result. */
  private readonly items = new Map<number, ItemRecord>([[0, { sentBytes: 0, ended: false }]]);
  /** The config `stt.open` carries; later changes travel as queued updates. */
  private readonly openConfig: SttConfig;

  constructor(
    private readonly hub: SttRelayHub,
    private readonly registry: LegRegistry,
    private readonly deps: SttHubDeps,
    private readonly consumer: SttSessionConsumer,
    config: SttConfig,
    private readonly maxSessionMs: number,
  ) {
    this.openConfig = wireConfig(config);
  }

  get status(): "detached" | "opening" | "open" | "ended" {
    return this.state;
  }
  /** The item new audio belongs to. */
  get openItemSeq(): number {
    return this.openSeq;
  }
  /** PCM bytes sent to the CLI (the metered amount). */
  get sentAudioBytes(): number {
    return this.sent;
  }
  get queuedAudioBytes(): number {
    return this.pendingAudio;
  }
  /** Memory held by queued audio (tests and diagnostics). */
  get queuedAudioCapacityBytes(): number {
    let total = 0;
    for (const entry of this.queue) {
      if (entry.kind === "audio") for (const block of entry.blocks) total += block.byteLength;
    }
    return total;
  }
  get relaySessionId(): string | null {
    return this.leg?.sessionId ?? null;
  }

  /**
   * One open attempt on one candidate. On `failed` the session is detached
   * again with its queue intact; the caller may try the next candidate.
   */
  attach(target: SttAttachTarget): Promise<SttAttachResult> {
    if (this.state === "ended") return Promise.resolve({ status: "ended" });
    if (this.state !== "detached") throw new Error("The session is already attached.");
    if (this.remainingSessionMs() < STT_MAX_SESSION_MS_MIN) {
      // A failover this late would open a session the CLI must end at once.
      this.finish({ cause: "expired", failure: "timeout" }, null);
      return Promise.resolve({ status: "ended" });
    }
    const configs = [this.openConfig];
    for (const entry of this.queue) {
      if (entry.kind === "control" && entry.message.type === "stt.update") {
        configs.push(entry.message.config);
      }
    }
    if (sttTargetRefusal(target, configs) !== null) {
      return Promise.resolve({
        status: "failed",
        reason: "not_eligible",
        failure: "unsupported_capability",
      });
    }
    const realtime = realtimeTranscriptionCapability(target.capabilities);
    if (!realtime) throw new Error("unreachable: eligibility checked the capability");
    const resolution = this.deps.resolveLink(target.cliDeviceId, target.endpointSlug);
    if (!resolution.ok) {
      return Promise.resolve({
        status: "failed",
        reason: resolution.reason,
        failure: resolution.reason === "endpoint_unavailable" ? "not_found" : "disconnected",
      });
    }
    const link = resolution.link;
    if (this.registry.countOn(link) >= STT_SESSIONS_PER_CLI) {
      return Promise.resolve({ status: "failed", reason: "cli_full", failure: "rate_limited" });
    }
    const maxItemSeconds = realtimeMaxItemSeconds(realtime);
    const leg: Leg = {
      sessionId: newSessionId(),
      link,
      endpointSlug: target.endpointSlug,
      state: "opening",
      owner: this,
      timer: null,
    };
    let wire: string;
    try {
      wire = encodeRelayServerControlMessage({
        type: "stt.open",
        sessionId: leg.sessionId,
        endpointSlug: target.endpointSlug,
        upstreamModel: target.upstreamModel,
        adapter: realtime.adapter,
        config: this.openConfig,
        maxItemSeconds,
        maxSessionMs: this.remainingSessionMs(),
        audioWindowBytes: STT_AUDIO_WINDOW_BYTES,
      });
    } catch {
      return Promise.resolve({
        status: "failed",
        reason: "not_eligible",
        failure: "unsupported_capability",
      });
    }
    try {
      link.send(wire);
    } catch (error) {
      console.error("[stt] open could not be sent", describeError(error));
      return Promise.resolve({ status: "failed", reason: "send_failed", failure: "transport" });
    }
    if (this.deadlineMs === null) {
      // The CLI's own deadline runs from its receipt of this open (plus a
      // grace), so the server's clock starts here and always ends first.
      this.deadlineMs = Date.now() + this.maxSessionMs;
      this.expiryTimer = startTimer(this.maxSessionMs, () =>
        this.finish({ cause: "expired", failure: "timeout" }, "timeout"),
      );
    }
    this.registry.add(leg);
    this.leg = leg;
    this.state = "opening";
    this.adapter = realtime.adapter;
    this.maxItemSeconds = maxItemSeconds;
    leg.timer = startTimer(STT_OPEN_TIMEOUT_MS, () =>
      this.openFailed(leg, { reason: "timeout", failure: "timeout" }, "timeout"),
    );
    return new Promise((resolve) => {
      this.attachResolve = resolve;
    });
  }

  /** Copies `pcm` (raw s16le, 24 kHz mono); the caller may reuse it. */
  appendAudio(pcm: Uint8Array): SttAppendResult {
    if (this.state === "ended") return { ok: false, reason: "ended" };
    if (pcm.byteLength === 0) return { ok: false, reason: "empty" };
    if (pcm.byteLength % 2 !== 0) return { ok: false, reason: "odd_length" };
    if (pcm.byteLength > STT_APPEND_MAX_BYTES) return { ok: false, reason: "too_large" };
    if (this.pendingAudio >= STT_PENDING_AUDIO_MAX_BYTES) {
      return { ok: false, reason: "backlog_full" };
    }
    const last = this.queue.at(-1);
    if (last?.kind === "audio" && last.itemSeq === this.openSeq) {
      writeAudio(last, pcm);
    } else {
      const entry: AudioEntry = {
        kind: "audio",
        itemSeq: this.openSeq,
        blocks: [],
        readOffset: 0,
        writeLen: 0,
        bytes: 0,
      };
      writeAudio(entry, pcm);
      this.queue.push(entry);
    }
    this.pendingAudio += pcm.byteLength;
    this.openHasAudio = true;
    this.pump();
    // Judged after sending what the credit allows, so a burst that fits never
    // pauses. The pump may have ended the session (a failed send).
    if (this.status === "ended") return { ok: false, reason: "ended" };
    if (!this.backlogged && this.pendingAudio >= STT_PENDING_AUDIO_MAX_BYTES) {
      this.backlogged = true;
      this.stallTimer = startTimer(STT_BACKLOG_STALL_MS, () =>
        this.finish({ cause: "audio_backlog", failure: "timeout" }, "timeout"),
      );
    }
    return { ok: true, backlogged: this.backlogged };
  }

  /** Ends the open item for transcription. */
  commit(): SttItemResult {
    if (this.state === "ended") return { ok: false, reason: "ended" };
    if (!this.openHasAudio) return { ok: false, reason: "empty" };
    if (this.items.size - 1 >= STT_PENDING_ITEMS_MAX)
      return { ok: false, reason: "too_many_items" };
    const refused = this.controlRefusal();
    if (refused) return refused;
    const itemSeq = this.openSeq;
    const record = this.items.get(itemSeq);
    if (record) record.ended = true;
    this.enqueueControl({ type: "stt.commit", itemSeq });
    this.advance(0);
    this.pump();
    return { ok: true, itemSeq };
  }

  /** Discards the open item; it uses up its number. Its unsent audio is dropped here. */
  clear(): SttItemResult {
    if (this.state === "ended") return { ok: false, reason: "ended" };
    const refused = this.controlRefusal();
    if (refused) return refused;
    const itemSeq = this.openSeq;
    while (true) {
      const last = this.queue.at(-1);
      if (last?.kind !== "audio" || last.itemSeq !== itemSeq) break;
      this.queue.pop();
      this.pendingAudio -= last.bytes;
    }
    this.items.delete(itemSeq);
    this.enqueueControl({ type: "stt.clear", itemSeq });
    this.advance(0);
    this.noteDrained();
    this.pump();
    return { ok: true, itemSeq };
  }

  /** Language or prompt from the next item on. */
  update(config: SttConfig): SttUpdateResult {
    if (this.state === "ended") return { ok: false, reason: "ended" };
    // Checked against the wire schema before it is queued: a config the
    // encoder would refuse must never reach the queue.
    if (!sttConfigSchema.safeParse(config).success) return { ok: false, reason: "invalid" };
    if (this.adapter === "vllm" && this.state !== "detached" && !configEmpty(config)) {
      return { ok: false, reason: "unsupported" };
    }
    if (this.pendingControls >= STT_PENDING_CONTROLS_MAX) {
      return { ok: false, reason: "control_backlog" };
    }
    this.enqueueControl({ type: "stt.update", config: wireConfig(config) });
    this.pump();
    return { ok: true };
  }

  /** Ends the session and tells the CLI. `onEnd` follows with cause `consumer`. */
  close(reason: RelayFailure = "cancelled") {
    this.finish({ cause: "consumer", failure: reason }, reason);
  }

  /** Server shutdown. */
  shutdown() {
    this.finish({ cause: "shutdown", failure: "cancelled" }, "cancelled");
  }

  // ---- CLI frames (through the hub) ----

  onLegFrame(leg: Leg, message: SttClientMessage) {
    if (this.leg !== leg) return;
    if (leg.state === "opening") {
      switch (message.type) {
        case "stt.opened":
          this.opened(leg);
          return;
        case "stt.error":
          this.openFailed(
            leg,
            {
              reason: "refused",
              failure: message.failure,
              ...(message.message !== undefined ? { message: message.message } : {}),
            },
            null,
          );
          return;
        case "stt.closed":
          this.openFailed(leg, { reason: "refused", failure: "unknown" }, null);
          return;
        default:
          // No audio was sent, so no ack or event can be due.
          this.openFailed(
            leg,
            { reason: "protocol_error", failure: "protocol_error" },
            "protocol_error",
          );
          return;
      }
    }
    switch (message.type) {
      case "stt.opened":
        this.protocolError();
        return;
      case "stt.error":
        this.finish(
          {
            cause: "upstream_error",
            failure: message.failure,
            ...(message.message !== undefined ? { message: message.message } : {}),
          },
          null,
        );
        return;
      case "stt.closed":
        this.finish({ cause: "upstream_closed", failure: "unknown" }, null);
        return;
      case "stt.audio.ack":
        this.ack(message.bytes);
        return;
      case "stt.event":
        this.event(message.event);
        return;
    }
  }

  /** A malformed frame named this session's leg. */
  onLegMalformed(leg: Leg) {
    if (this.leg !== leg) return;
    if (leg.state === "opening") {
      this.openFailed(
        leg,
        { reason: "protocol_error", failure: "protocol_error" },
        "protocol_error",
      );
    } else {
      this.protocolError();
    }
  }

  /** The CLI connection is gone; the leg is already forgotten. */
  onLinkLost(leg: Leg) {
    if (this.leg !== leg) return;
    if (leg.state === "opening") {
      this.openFailed(leg, { reason: "disconnected", failure: "disconnected" }, null);
    } else {
      this.finish({ cause: "disconnected", failure: "disconnected" }, null);
    }
  }

  /** The endpoint left the CLI's inventory. */
  onEndpointGone(leg: Leg) {
    if (this.leg !== leg) return;
    if (leg.state === "opening") {
      this.openFailed(leg, { reason: "endpoint_unavailable", failure: "not_found" }, "not_found");
    } else {
      this.finish({ cause: "endpoint_unavailable", failure: "not_found" }, "not_found");
    }
  }

  // ---- internals ----

  private controlRefusal(): SttItemResult | null {
    if (this.pendingControls >= STT_PENDING_CONTROLS_MAX) {
      return { ok: false, reason: "control_backlog" };
    }
    if (this.openSeq >= STT_ITEM_SEQ_MAX) return { ok: false, reason: "exhausted" };
    return null;
  }

  private enqueueControl(message: Extract<QueueEntry, { kind: "control" }>["message"]) {
    this.queue.push({ kind: "control", message });
    this.pendingControls += 1;
  }

  /** The open item ended; a new one opens with `carriedBytes` already sent for it. */
  private advance(carriedBytes: number) {
    this.openSeq += 1;
    this.items.set(this.openSeq, { sentBytes: carriedBytes, ended: false });
    this.openHasAudio = false;
  }

  private opened(leg: Leg) {
    if (leg.timer) clearTimeout(leg.timer);
    leg.timer = null;
    leg.state = "open";
    this.state = "open";
    const resolve = this.attachResolve;
    this.attachResolve = null;
    resolve?.({
      status: "opened",
      adapter: this.adapter ?? "segmented",
      maxItemSeconds: this.maxItemSeconds,
    });
    // The caller's `await attach()` continuation is queued by `resolve`; this
    // job runs after it. An end before then (the first send failing) defers
    // `onEnd` past it, so the caller sees `opened` before `onEnd`.
    this.openedUnobserved = true;
    queueMicrotask(() => {
      this.openedUnobserved = false;
    });
    this.pump();
  }

  /** What is left of `maxSessionMs` since the first `stt.open`, whole milliseconds. */
  private remainingSessionMs(): number {
    if (this.deadlineMs === null) return this.maxSessionMs;
    return Math.min(this.maxSessionMs, Math.max(0, Math.floor(this.deadlineMs - Date.now())));
  }

  private openFailed(
    leg: Leg,
    result: { reason: SttOpenFailureReason; failure: RelayFailure; message?: string },
    notify: RelayFailure | null,
  ) {
    if (this.leg !== leg) return;
    this.registry.retire(leg, notify);
    this.leg = null;
    this.state = "detached";
    this.adapter = null;
    this.maxItemSeconds = 0;
    const resolve = this.attachResolve;
    this.attachResolve = null;
    resolve?.({ status: "failed", ...result });
  }

  private protocolError() {
    console.error("[stt] session ended: the CLI broke the session protocol");
    this.finish({ cause: "protocol_error", failure: "protocol_error" }, "protocol_error");
  }

  private ack(bytes: number) {
    if (bytes > this.outstanding) {
      this.protocolError();
      return;
    }
    this.outstanding -= bytes;
    this.pump();
  }

  private event(event: SttEvent) {
    const itemSeq = event.itemSeq;
    if (itemSeq > this.openSeq) {
      this.protocolError();
      return;
    }
    if (event.kind === "auto_committed") {
      if (itemSeq < this.openSeq) {
        // A commit or clear for it is already on its way; the CLI ignores it.
        this.racedAutoCommit(itemSeq);
        return;
      }
      this.autoCommitted(itemSeq);
      return;
    }
    const record = this.items.get(itemSeq);
    if (event.kind === "delta") {
      if (record) this.emit({ kind: "delta", itemSeq, text: event.text });
      return;
    }
    if (itemSeq === this.openSeq) {
      // A result for an item nobody ended.
      this.protocolError();
      return;
    }
    if (!record?.ended) return; // cleared or already finished: late
    this.items.delete(itemSeq);
    if (event.kind === "completed") {
      this.emit({
        kind: "completed",
        itemSeq,
        text: event.text,
        audioBytes: record.sentBytes,
        ...(event.engineUsage ? { engineUsage: event.engineUsage } : {}),
      });
    } else {
      this.emit({ kind: "failed", itemSeq, code: event.code, message: event.message });
    }
  }

  private autoCommitted(itemSeq: number) {
    if (itemSeq >= STT_ITEM_SEQ_MAX || this.items.size - 1 >= 2 * STT_PENDING_ITEMS_MAX) {
      this.protocolError();
      return;
    }
    const record = this.items.get(itemSeq) ?? { sentBytes: 0, ended: false };
    record.ended = true;
    this.items.set(itemSeq, record);
    // The CLI cut the item at its length limit (or earlier, when the engine
    // ended it); bytes sent beyond that belong to the next item.
    const limit = this.maxItemSeconds * STT_PCM_BYTES_PER_SECOND;
    const carried = Math.max(0, record.sentBytes - limit);
    record.sentBytes -= carried;
    this.advance(carried);
    let queuedForNext = false;
    for (const entry of this.queue) {
      if (entry.kind === "audio" && entry.itemSeq === itemSeq) {
        entry.itemSeq = this.openSeq;
        queuedForNext = true;
      }
    }
    // Unacknowledged audio may have landed after the cut.
    this.openHasAudio = carried > 0 || queuedForNext || this.outstanding > 0;
    this.emit({ kind: "auto_committed", itemSeq });
  }

  /**
   * The valve cut item N after the client's commit for N was queued. Audio
   * past the cut is in the CLI's N+1, which is the server's open item when
   * nothing else ended since, so the next commit must not be refused as
   * empty. A raced clear is left alone: its tail stays in the next item (the
   * documented valve behaviour).
   */
  private racedAutoCommit(itemSeq: number) {
    const record = this.items.get(itemSeq);
    if (!record?.ended || itemSeq !== this.openSeq - 1) return;
    const limit = this.maxItemSeconds * STT_PCM_BYTES_PER_SECOND;
    const carried = Math.max(0, record.sentBytes - limit);
    record.sentBytes -= carried;
    const open = this.items.get(this.openSeq);
    if (open) open.sentBytes += carried;
    let queuedForNext = false;
    for (const entry of this.queue) {
      if (entry.kind === "audio" && entry.itemSeq === itemSeq) {
        entry.itemSeq = this.openSeq;
        queuedForNext = true;
      }
    }
    if (carried > 0 || queuedForNext || this.outstanding > 0) this.openHasAudio = true;
  }

  private emit(event: SttSessionEvent) {
    try {
      this.consumer.onEvent(event);
    } catch (error) {
      console.error("[stt] session consumer failed", describeError(error));
    }
  }

  private noteDrained() {
    if (!this.backlogged || this.pendingAudio > STT_PENDING_AUDIO_MAX_BYTES / 2) return;
    this.backlogged = false;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
    if (this.state === "ended") return;
    try {
      this.consumer.onDrain();
    } catch (error) {
      console.error("[stt] session consumer failed", describeError(error));
    }
  }

  /** Sends queued audio within credit, coalesced, and commands in order. */
  private pump() {
    if (this.pumping || this.state !== "open" || !this.leg) return;
    this.pumping = true;
    try {
      this.pumpLoop(this.leg);
    } catch (error) {
      // An invariant broke (a frame the encoder refused). End this session;
      // never throw out of a timer or a relay frame handler.
      console.error("[stt] session ended: a frame could not be encoded", describeError(error));
      this.pumping = false;
      this.finish({ cause: "protocol_error", failure: "protocol_error" }, "protocol_error");
      return;
    } finally {
      this.pumping = false;
    }
    this.noteDrained();
  }

  private pumpLoop(leg: Leg) {
    while (this.state === "open" && this.leg === leg) {
      const head = this.queue[0];
      if (!head) return;
      if (leg.link.bufferedAmount() > STT_RELAY_BUFFER_LIMIT) {
        this.busyTimer ??= startTimer(STT_RELAY_BUSY_RETRY_MS, () => {
          this.busyTimer = null;
          this.pump();
        });
        return;
      }
      if (head.kind === "control") {
        if (!this.send(leg, encodeRelayServerControlMessage(controlFrame(head.message, leg)))) {
          return;
        }
        this.queue.shift();
        this.pendingControls -= 1;
        continue;
      }
      const want = Math.min(head.bytes, STT_AUDIO_FRAME_MAX_BYTES);
      const boundary = this.queue.length > 1;
      if (want < STT_AUDIO_FRAME_MIN_BYTES && !boundary && !this.flushDue) {
        this.flushTimer ??= startTimer(STT_AUDIO_FLUSH_MS, () => {
          this.flushTimer = null;
          this.flushDue = true;
          this.pump();
        });
        return;
      }
      const credit = STT_AUDIO_WINDOW_BYTES - this.outstanding;
      let size = Math.min(want, credit);
      size -= size % 2;
      // Wait for acknowledgements rather than send a fragment; acks always
      // come while anything is outstanding, and with nothing outstanding the
      // whole window is free.
      if (size === 0 || (size < want && size < STT_AUDIO_FRAME_MIN_BYTES)) return;
      const body = takeBytes(head, size);
      const frame = encodeRelayBinaryFrame(
        { type: "stt.audio", sessionId: leg.sessionId, seq: this.seq },
        body,
      );
      if (!this.send(leg, frame)) return;
      this.seq += 1;
      this.outstanding += size;
      this.sent += size;
      this.pendingAudio -= size;
      const record = this.items.get(head.itemSeq);
      if (record) record.sentBytes += size;
      if (head.bytes === 0) this.queue.shift();
      // A remainder waits for more audio again, from now.
      this.flushDue = false;
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private send(leg: Leg, data: string | ArrayBuffer): boolean {
    try {
      leg.link.send(data);
      return true;
    } catch (error) {
      console.error("[stt] relay send failed", describeError(error));
      this.finish({ cause: "disconnected", failure: "transport" }, null);
      return false;
    }
  }

  /**
   * Every end goes through here once. With `notify` the CLI gets
   * `stt.close{notify}`; without it the CLI already ended the leg.
   */
  private finish(end: SttSessionEnd, notify: RelayFailure | null) {
    if (this.state === "ended") return;
    this.state = "ended";
    for (const timer of [this.stallTimer, this.flushTimer, this.busyTimer, this.expiryTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.stallTimer = this.flushTimer = this.busyTimer = this.expiryTimer = null;
    this.queue.length = 0;
    this.pendingAudio = 0;
    this.pendingControls = 0;
    this.items.clear();
    const leg = this.leg;
    this.leg = null;
    if (leg) this.registry.retire(leg, notify);
    this.hub.forget(this);
    const resolve = this.attachResolve;
    this.attachResolve = null;
    resolve?.({ status: "ended" });
    const notifyEnd = () => {
      try {
        this.consumer.onEnd(end);
      } catch (error) {
        console.error("[stt] session consumer failed", describeError(error));
      }
    };
    if (this.openedUnobserved) queueMicrotask(notifyEnd);
    else notifyEnd();
  }
}

/** Objects in schema key order, so the wire bytes match the shared goldens' form. */
function wireConfig(config: SttConfig): SttConfig {
  return {
    ...(config.language !== undefined ? { language: config.language } : {}),
    ...(config.prompt !== undefined ? { prompt: config.prompt } : {}),
  };
}

function controlFrame(
  message: Extract<QueueEntry, { kind: "control" }>["message"],
  leg: Leg,
): SttServerControlMessage {
  switch (message.type) {
    case "stt.update":
      return { type: "stt.update", sessionId: leg.sessionId, config: message.config };
    case "stt.commit":
      return { type: "stt.commit", sessionId: leg.sessionId, itemSeq: message.itemSeq };
    case "stt.clear":
      return { type: "stt.clear", sessionId: leg.sessionId, itemSeq: message.itemSeq };
  }
}

/** Removes `size` bytes from the front of an audio entry. */
function takeBytes(entry: AudioEntry, size: number): Uint8Array {
  const end = (index: number) =>
    index === entry.blocks.length - 1 ? entry.writeLen : (entry.blocks[index]?.byteLength ?? 0);
  const consumeFront = () => {
    // A drained first block is freed unless it is still being written.
    if (entry.blocks.length > 1 && entry.readOffset === end(0)) {
      entry.blocks.shift();
      entry.readOffset = 0;
    }
  };
  const first = entry.blocks[0];
  if (first && end(0) - entry.readOffset >= size) {
    // A view is enough: the frame encoder copies it, and nothing rewrites read bytes.
    const body = first.subarray(entry.readOffset, entry.readOffset + size);
    entry.readOffset += size;
    consumeFront();
    entry.bytes -= size;
    return body;
  }
  const body = new Uint8Array(size);
  let filled = 0;
  while (filled < size) {
    const block = entry.blocks[0];
    if (!block) throw new Error("unreachable: audio entry shorter than its byte count");
    const take = Math.min(size - filled, end(0) - entry.readOffset);
    body.set(block.subarray(entry.readOffset, entry.readOffset + take), filled);
    filled += take;
    entry.readOffset += take;
    consumeFront();
  }
  entry.bytes -= size;
  return body;
}

/** All live speech-to-text sessions of this process. */
export class SttRelayHub {
  private readonly registry: LegRegistry;
  private readonly sessions = new Set<SttRelaySession>();
  private shuttingDown = false;

  constructor(private readonly deps: SttHubDeps) {
    this.registry = new LegRegistry(deps.onLinkIdle);
  }

  createSession({
    consumer,
    config = {},
    maxSessionMs = STT_MAX_SESSION_MS,
  }: {
    consumer: SttSessionConsumer;
    config?: SttConfig;
    maxSessionMs?: number;
  }): SttCreateResult {
    if (
      !Number.isInteger(maxSessionMs) ||
      maxSessionMs < STT_MAX_SESSION_MS_MIN ||
      maxSessionMs > STT_MAX_SESSION_MS_MAX
    ) {
      throw new RangeError("maxSessionMs is outside the stt.open bounds.");
    }
    if (this.shuttingDown) return { ok: false, reason: "shutting_down" };
    if (!sttConfigSchema.safeParse(config).success) return { ok: false, reason: "invalid_config" };
    if (this.sessions.size >= STT_SESSIONS_SERVER_MAX) return { ok: false, reason: "server_full" };
    const session = new SttRelaySession(
      this,
      this.registry,
      this.deps,
      consumer,
      config,
      maxSessionMs,
    );
    this.sessions.add(session);
    return { ok: true, session };
  }

  /** @internal Called by a session as it ends. */
  forget(session: SttRelaySession) {
    this.sessions.delete(session);
  }

  /** An `stt.*` frame from a registered CLI. Frames for other links' or unknown sessions are dropped. */
  handleClientFrame(link: SttRelayLink, message: SttClientMessage) {
    const leg = this.registry.bySessionId.get(message.sessionId);
    if (!leg || leg.link !== link) return;
    if (leg.state === "closing") {
      if (message.type === "stt.closed" || message.type === "stt.error") this.registry.remove(leg);
      return;
    }
    leg.owner?.onLegFrame(leg, message);
  }

  /** A malformed `stt.*` frame that names `sessionId`. */
  malformed(link: SttRelayLink, sessionId: string) {
    const leg = this.registry.bySessionId.get(sessionId);
    if (!leg || leg.link !== link || leg.state === "closing") return;
    leg.owner?.onLegMalformed(leg);
  }

  /** The CLI connection closed or was replaced: every session on it fails. */
  linkLost(link: SttRelayLink) {
    const legs = [...(this.registry.byLink.get(link) ?? [])];
    for (const leg of legs) {
      const owner = leg.owner;
      this.registry.remove(leg);
      owner?.onLinkLost(leg);
    }
  }

  /** The CLI's inventory changed: sessions on endpoints no longer listed end. */
  endpointsChanged(link: SttRelayLink, slugs: ReadonlySet<string>) {
    const legs = [...(this.registry.byLink.get(link) ?? [])];
    for (const leg of legs) {
      if (leg.state === "closing" || slugs.has(leg.endpointSlug)) continue;
      leg.owner?.onEndpointGone(leg);
    }
  }

  /** Opening or open sessions on the link; closing legs are not work. */
  hasActiveLegs(link: SttRelayLink): boolean {
    return this.registry.activeOn(link) > 0;
  }

  /** Shutdown: every session ends and its CLI is told. New sessions are refused. */
  closeAll() {
    this.shuttingDown = true;
    for (const session of [...this.sessions]) session.shutdown();
  }

  /** Counters for tests and diagnostics. */
  stats(): { sessions: number; legs: number } {
    return { sessions: this.sessions.size, legs: this.registry.bySessionId.size };
  }
}
