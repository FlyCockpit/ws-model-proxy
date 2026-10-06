import type { RelayFailure } from "../../relay/relay-failure.js";
import type { SttConfig } from "../../relay/stt-protocol.js";
import {
  STT_APPEND_MAX_BYTES,
  type SttAttachResult,
  type SttAttachTarget,
  type SttCreateResult,
  type SttRelaySession,
  type SttSessionConsumer,
  type SttSessionEnd,
  type SttSessionEvent,
} from "../../relay/stt-relay.js";
import {
  audioSeconds,
  clearedEvent,
  committedEvents,
  errorEvent,
  parseRealtimeClientEvent,
  type RealtimeClientEvent,
  type RealtimeError,
  type RealtimeSessionPatch,
  type RealtimeSessionView,
  realtimeId,
  sessionCreatedEvent,
  sessionUpdatedEvent,
  transcriptionCompletedEvents,
  transcriptionDeltaEvent,
  transcriptionFailedEvent,
} from "./events.js";
import type { RealtimeAdmission } from "./limits.js";

/**
 * One `/v1/realtime?intent=transcription` client session (design §2, §3, §9):
 * the OpenAI transcription protocol on top of a chunk 5 relay session.
 *
 * `AWAITING_MODEL → ROUTING → OPEN → CLOSED`. The relay session is created
 * the moment a model is known (the query or the first `session.update`), so
 * audio appended while routing is buffered there and replayed to whichever
 * member opens. Routing has a hard deadline; each candidate is tried with an
 * awaited `attach` (at most {@link REALTIME_MAX_OPEN_ATTEMPTS} real opens),
 * and only failures that reflect a member's health are reported as such.
 *
 * The socket, the router (model resolution against the token, live-capable
 * recipe-managed members from the database) and the admission lease are
 * ports, wired by the endpoint (chunk 6b). The admission lease is acquired by
 * the caller before this object exists, and released exactly once here.
 *
 * Every non-1000 close is preceded by an `error` event. Nothing here logs
 * client audio, prompts or transcripts.
 */

export const REALTIME_ROUTING_DEADLINE_MS = 10_000;
export const REALTIME_IDLE_TIMEOUT_MS = 120_000;
export const REALTIME_MAX_OPEN_ATTEMPTS = 3;
/**
 * One open attempt's budget inside the routing deadline (review M1): a member
 * that never answers costs at most this, then the next candidate is tried.
 * A healthy local engine opens in milliseconds.
 */
export const REALTIME_OPEN_ATTEMPT_MS = 4_000;
/** Below this much routing time left, no further attempt starts. */
const REALTIME_OPEN_ATTEMPT_MIN_MS = 250;
/** `session.update`s with language or prompt held while routing. */
export const REALTIME_HELD_UPDATES_MAX = 8;
/** Bytes queued on the client socket before it counts as a slow consumer. */
export const REALTIME_CLIENT_BUFFER_LIMIT = 1024 * 1024;
export const REALTIME_EVENT_RATE_WINDOW_MS = 10_000;
export const REALTIME_EVENT_RATE_MAX = 400;
/** Consecutive rate-limited windows before the socket is closed. */
export const REALTIME_RATE_STRIKES_MAX = 3;
/** Events that arrive after the socket was paused (already read from TCP). */
export const REALTIME_DEFERRED_EVENTS_MAX = 64;
export const REALTIME_DEFERRED_AUDIO_MAX_BYTES = STT_APPEND_MAX_BYTES;
const ITEM_RECORDS_MAX = 256;

export const REALTIME_CLOSE_CODES = {
  normal: 1000,
  goingAway: 1001,
  policy: 1008,
  internal: 1011,
  tryAgainLater: 1013,
} as const;
export type RealtimeCloseCode = (typeof REALTIME_CLOSE_CODES)[keyof typeof REALTIME_CLOSE_CODES];

/**
 * Where a candidate sits in the database: what admission, health and
 * accounting need. Opaque to this module; the router fills it.
 */
export type RealtimeRouteIdentity = {
  kind: "pool" | "direct";
  poolId: string | null;
  poolMemberId: string | null;
  discoveredModelId: string;
  endpointId: string;
  executionTargetId: string | null;
  capacityId: string | null;
  /** The admission owner: the pool owner for pools, the model owner for direct models. */
  ownerUserId: string;
  /** The model's owner (a contributor's model in a pool may belong to someone else). */
  engineOwnerUserId: string;
  accessGrantId: string | null;
  /** The member's inference contribution, when the model is contributed. */
  contributionId: string | null;
};

/** A candidate member, in route order. `deploymentManaged` comes from the database. */
export type RealtimeCandidate = SttAttachTarget & {
  memberId: string | null;
  route?: RealtimeRouteIdentity;
};

export type RealtimeRouteResult =
  | { ok: true; candidates: readonly RealtimeCandidate[] }
  | { ok: false; code: "model_not_found" | "external_variant_unsupported" | "no_live_member" };

export interface RealtimeRouter {
  /**
   * Resolves `model` for the token and returns its live-capable,
   * recipe-managed members in route order. Unknown and forbidden models are
   * both `model_not_found`.
   */
  candidates(input: {
    model: string;
    config: SttConfig;
    signal: AbortSignal;
  }): Promise<RealtimeRouteResult>;
  /** An open failed in a way that reflects the member's health (see {@link openFailureMarksMember}). */
  memberOpenFailed(candidate: RealtimeCandidate, failure: RelayFailure): void;
  /**
   * The member refused the open for a configuration reason (no realtime
   * route, a wrong model or credential): reported, never counted against the
   * member's health, which HTTP shares (review 6b L2).
   */
  memberMisconfigured?(candidate: RealtimeCandidate, failure: RelayFailure): void;
}

export type RealtimeCandidateLease = {
  release(): void;
  /** Aborts if the lease is lost (heartbeat refused); the session then ends 1011. */
  signal?: AbortSignal;
};

export type RealtimeAdmitResult = { ok: true; lease: RealtimeCandidateLease } | { ok: false };

/**
 * The send claim's verdict on one open (review 6b M1). `requester` and
 * `access` end the session (the caller lost access); `member` and
 * `check_failed` move on to the next candidate, never as a health failure.
 */
export type RealtimeAuthorizeResult =
  | { ok: true }
  | { ok: false; denial: "requester" | "access" | "member" | "check_failed" };

export type RealtimeOpenedInfo = {
  adapter: "vllm" | "segmented";
  maxItemSeconds: number;
  /** The lease `admit` gave for this member; released when the session ends. */
  lease: RealtimeCandidateLease | null;
};

export type RealtimeItemOutcome = {
  itemSeq: number;
  itemId: string;
  status: "completed" | "failed";
  /** PCM the server forwarded for the item (approximate across a valve split). */
  audioBytes: number;
  audioSeconds: number;
  code?: string;
  engineUsage?: { inputTokens?: number; outputTokens?: number };
  /** UTF-8 bytes of the final transcript (a count only; the text is never passed on). */
  transcriptBytes: number;
};

export type RealtimeSessionOutcome = {
  /** The member the session opened on, or null when it never opened. */
  candidate: RealtimeCandidate | null;
  /** The close code sent; null when the client went away first. */
  closeCode: RealtimeCloseCode | null;
  errorCode: string | null;
  /** PCM bytes forwarded to the member: the metered amount. */
  sentAudioBytes: number;
};

/**
 * Seams for the endpoint (6b) and accounting (7). Every hook is optional and
 * isolated: a throwing hook never breaks the session.
 */
export interface RealtimeSessionHooks {
  /**
   * Capacity admission on one candidate, before its open attempt. Refused
   * (busy) moves on to the next candidate and counts as capacity. The lease is
   * released if the attempt fails, or when the session ends.
   */
  admit?(candidate: RealtimeCandidate, signal: AbortSignal): Promise<RealtimeAdmitResult>;
  /**
   * The locked send claim around one open (the HTTP send's permission check):
   * `open` sends `stt.open` synchronously and must be called inside the
   * claim, after the check passed; `abort` withdraws a sent open whose claim
   * did not commit. Without this hook the open is sent unclaimed (tests).
   */
  authorizeOpen?(
    candidate: RealtimeCandidate,
    open: () => void,
    abort: () => void,
  ): Promise<RealtimeAuthorizeResult>;
  /** The session opened on `candidate`: bind the lease, start rechecks, open the usage row. */
  opened?(candidate: RealtimeCandidate, info: RealtimeOpenedInfo): void;
  /** One item finished (completed or failed), with its audio and engine usage. */
  itemFinished?(outcome: RealtimeItemOutcome): void;
  /** Exactly once, at the end. */
  ended?(outcome: RealtimeSessionOutcome): void;
}

export interface RealtimeClientSocket {
  send(text: string): void;
  close(code: number, reason: string): void;
  /** Stop reading from the client (TCP backpressure). */
  pause(): void;
  resume(): void;
  bufferedAmount(): number;
}

export interface RealtimeRelay {
  createSttSession(input: { consumer: SttSessionConsumer; config?: SttConfig }): SttCreateResult;
}

/**
 * The client-visible text of an item failure (security review L4). The code
 * and message come from a contributor's CLI, which is trusted less than the
 * server: known codes get the server's own message, anything else becomes a
 * generic failure. Engine text never reaches the client.
 */
const ITEM_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  empty_item: "The item has no audio.",
  transcript_too_large: "The transcript is too large to deliver.",
  upstream_1xx: "The transcription engine did not finish the item.",
  upstream_redirect: "The transcription engine could not take the item.",
  upstream_4xx: "The transcription engine refused the item.",
  upstream_5xx: "The transcription engine failed the item.",
  invalid_response: "The transcription engine gave an invalid response.",
  invalid_audio: "The transcription engine refused the audio.",
  engine_error: "The transcription engine failed the item.",
  timeout: "The transcription engine did not finish the item in time.",
  transport: "The transcription engine could not be reached.",
};

/** Exported for tests. */
export function itemFailure(code: string): { code: string; message: string } {
  const message = Object.hasOwn(ITEM_FAILURE_MESSAGES, code)
    ? ITEM_FAILURE_MESSAGES[code]
    : undefined;
  if (message === undefined) {
    return { code: "transcription_failed", message: "The item could not be transcribed." };
  }
  return { code, message };
}

function realOpenFailure(result: Extract<SttAttachResult, { status: "failed" }>): boolean {
  return (
    result.reason === "refused" || result.reason === "timeout" || result.reason === "protocol_error"
  );
}

/**
 * Whether a failed open should count against the member's health (review
 * L4, 6b L2). Only an engine or transport fault does: a refusal for capacity
 * (`rate_limited`), a stopping or unknown deployment (`not_found`), a CLI
 * that left (`disconnected`, recorded by the relay itself), a configuration
 * fault ({@link openFailureIsConfiguration}) or a server-side refusal before
 * anything was sent is not. The pool member's health is shared with HTTP: a
 * wrong realtime claim in a recipe must not push the member out of HTTP
 * routing.
 */
export function openFailureMarksMember(
  result: Extract<SttAttachResult, { status: "failed" }>,
): boolean {
  if (!realOpenFailure(result)) return false;
  return (
    result.failure === "transport" ||
    result.failure === "timeout" ||
    result.failure === "upstream_5xx" ||
    result.failure === "protocol_error" ||
    result.failure === "unknown"
  );
}

/**
 * A configuration fault of the member's live transcription: the engine has
 * no `/v1/realtime` (`unsupported_capability`) or refused the request itself
 * (`upstream_4xx`: a wrong model or credential).
 */
export function openFailureIsConfiguration(
  result: Extract<SttAttachResult, { status: "failed" }>,
): boolean {
  return (
    realOpenFailure(result) &&
    (result.failure === "unsupported_capability" || result.failure === "upstream_4xx")
  );
}

/** Whether an open was really attempted on the member (counts toward the attempt cap). */
function openWasAttempted(reason: Extract<SttAttachResult, { status: "failed" }>["reason"]) {
  return (
    reason === "refused" ||
    reason === "timeout" ||
    reason === "protocol_error" ||
    reason === "disconnected"
  );
}

/** `announced`: the client has seen this item id (a commit or a delta named it). */
type ItemRecord = { id: string; previousItemId: string | null; announced: boolean };

type Deferred = RealtimeClientEvent;

const ROUTE_ERRORS: Record<
  Extract<RealtimeRouteResult, { ok: false }>["code"],
  { error: Omit<RealtimeError, "eventId">; close: RealtimeCloseCode }
> = {
  model_not_found: {
    error: {
      type: "invalid_request_error",
      code: "model_not_found",
      message: "The model does not exist or you do not have access to it.",
      param: "session.audio.input.transcription.model",
    },
    close: REALTIME_CLOSE_CODES.policy,
  },
  external_variant_unsupported: {
    error: {
      type: "invalid_request_error",
      code: "external_variant_unsupported",
      message: "Live transcription runs on local models only.",
      param: "session.audio.input.transcription.model",
    },
    close: REALTIME_CLOSE_CODES.policy,
  },
  no_live_member: {
    error: {
      type: "server_error",
      code: "model_not_available",
      message: "No member of this model can take a live transcription session right now.",
    },
    close: REALTIME_CLOSE_CODES.tryAgainLater,
  },
};

export class RealtimeTranscriptionSession {
  private state: "awaiting_model" | "routing" | "open" | "closed" = "awaiting_model";
  private readonly view: RealtimeSessionView;
  private relaySession: SttRelaySession | null = null;
  private routingAbort: AbortController | null = null;
  private routingTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly deferred: Deferred[] = [];
  private deferredAudioBytes = 0;
  /** The relay asked for backpressure; events wait in `deferred`. */
  private backlogged = false;
  private clientPaused = false;

  private readonly items = new Map<number, ItemRecord>();
  private lastItemId: string | null = null;

  /** Language/prompt updates received while routing, applied once open (review L1). */
  private readonly heldUpdates: { patch: RealtimeSessionPatch; eventId: string | undefined }[] = [];
  /** The candidate whose open is in flight, and its admission lease. */
  private attempting: RealtimeCandidate | null = null;
  private lease: RealtimeCandidateLease | null = null;
  private openedOn: RealtimeCandidate | null = null;

  private rateWindowStart = 0;
  private rateCount = 0;
  private rateWindowExceeded = false;
  private rateStrikes = 0;

  private readonly consumer: SttSessionConsumer = {
    onEvent: (event) => this.onRelayEvent(event),
    onDrain: () => this.onRelayDrain(),
    onEnd: (end) => this.onRelayEnd(end),
  };

  constructor(
    private readonly deps: {
      client: RealtimeClientSocket;
      router: RealtimeRouter;
      relay: RealtimeRelay;
      /** Acquired by the caller before the upgrade; released here once. */
      admission: RealtimeAdmission;
      /** `?model=` from the URL, already bounded by the caller. */
      initialModel?: string | null;
      hooks?: RealtimeSessionHooks;
      /** The error for a requester the send claim refused (default: the API key's). */
      credentialEnded?: { code: string; message: string };
    },
  ) {
    this.view = { id: realtimeId("sess"), model: null };
  }

  get status(): "awaiting_model" | "routing" | "open" | "closed" {
    return this.state;
  }

  /** Sends `session.created`; with `?model=` routing starts at once. */
  start() {
    this.send(sessionCreatedEvent(this.view));
    this.armIdleTimer();
    const model = this.deps.initialModel;
    if (model) {
      this.view.model = model;
      this.startRouting();
    }
  }

  /** One text frame from the client. */
  handleText(text: string) {
    if (this.state === "closed") return;
    if (!this.admitEventRate()) return;
    const parsed = parseRealtimeClientEvent(text);
    if (!parsed.ok) {
      this.send(errorEvent(parsed.error));
      return;
    }
    const event = parsed.event;
    if (event.type === "input_audio_buffer.append") this.armIdleTimer();
    if (this.backlogged || this.deferred.length > 0) {
      this.defer(event);
      return;
    }
    this.apply(event);
  }

  /** Binary frames carry nothing in this protocol. */
  handleBinary() {
    if (this.state === "closed") return;
    if (!this.admitEventRate()) return;
    this.send(
      errorEvent({
        type: "invalid_request_error",
        code: "invalid_event",
        message: "Send events as JSON text frames; audio goes base64 in input_audio_buffer.append.",
      }),
    );
  }

  /** The client socket closed or errored. */
  clientClosed() {
    this.closeWith({ code: null, error: null, relayReason: "cancelled" });
  }

  /**
   * Ends the session from outside: access lost on a recheck (1008), the
   * capacity lease lost (1011), shutdown (1001). An `error` precedes it.
   */
  terminate(code: RealtimeCloseCode, error: Omit<RealtimeError, "eventId">) {
    this.closeWith({
      code,
      error,
      relayReason: code === REALTIME_CLOSE_CODES.policy ? "access_denied" : "cancelled",
    });
  }

  // ---- client events ----

  private apply(event: RealtimeClientEvent) {
    if (this.state === "closed") return;
    switch (event.type) {
      case "session.update":
        this.applyPatch(event.patch, event.eventId);
        return;
      case "input_audio_buffer.append":
        this.append(event);
        return;
      case "input_audio_buffer.commit":
        this.commit(event.eventId);
        return;
      case "input_audio_buffer.clear":
        this.clear(event.eventId);
        return;
    }
  }

  private applyPatch(patch: RealtimeSessionPatch, eventId: string | undefined) {
    const startsRouting = patch.model !== undefined && this.state === "awaiting_model";
    if (patch.model !== undefined && !startsRouting && patch.model !== this.view.model) {
      this.clientError({
        code: "invalid_value",
        message: "The transcription model cannot change once the session has one.",
        param: "session.audio.input.transcription.model",
        eventId,
      });
      return;
    }
    const languageChanged = patch.language !== undefined && patch.language !== this.view.language;
    const promptChanged = patch.prompt !== undefined && patch.prompt !== this.view.prompt;
    if ((languageChanged || promptChanged) && this.state === "routing") {
      // Whether the member takes a language or prompt is known only once it
      // opens; answer then (session.updated or an error), never before.
      if (this.heldUpdates.length >= REALTIME_HELD_UPDATES_MAX) {
        this.clientError({ code: "rate_limited", message: "Too many pending updates.", eventId });
        return;
      }
      this.heldUpdates.push({ patch, eventId });
      return;
    }
    if ((languageChanged || promptChanged) && this.relaySession) {
      const config = this.config({
        ...(patch.language !== undefined ? { language: patch.language } : {}),
        ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
      });
      const updated = this.relaySession.update(config);
      if (!updated.ok) {
        if (updated.reason === "ended") return;
        this.clientError(
          updated.reason === "unsupported"
            ? {
                code: "unsupported_parameter",
                message: "This model's live transcription takes no language or prompt.",
                param:
                  patch.language !== undefined
                    ? "session.audio.input.transcription.language"
                    : "session.audio.input.transcription.prompt",
                eventId,
              }
            : updated.reason === "control_backlog"
              ? { code: "rate_limited", message: "Too many pending commands.", eventId }
              : { code: "invalid_value", message: "Invalid transcription options.", eventId },
        );
        return;
      }
    }
    if (patch.language !== undefined) this.view.language = patch.language;
    if (patch.prompt !== undefined) this.view.prompt = patch.prompt;
    if (startsRouting) this.view.model = patch.model ?? null;
    this.send(sessionUpdatedEvent(this.view));
    if (startsRouting) this.startRouting();
  }

  private append(event: Extract<RealtimeClientEvent, { type: "input_audio_buffer.append" }>) {
    const relay = this.relaySession;
    if (!relay) {
      this.clientError({
        code: "model_required",
        message: "Set session.audio.input.transcription.model before sending audio.",
        param: "session.audio.input.transcription.model",
        eventId: event.eventId,
      });
      return;
    }
    const itemSeq = relay.openItemSeq;
    const result = relay.appendAudio(event.audio);
    if (result.ok) {
      this.itemRecord(itemSeq);
      if (result.backlogged) this.pauseClient();
      return;
    }
    if (result.reason === "backlog_full") {
      // Read from TCP before the pause took hold: keep it, in order.
      this.pauseClient();
      this.defer(event);
      return;
    }
    if (result.reason === "ended") return;
    this.clientError({
      code: "invalid_value",
      message: "'audio' must hold whole 16-bit samples.",
      param: "audio",
      eventId: event.eventId,
    });
  }

  private commit(eventId: string | undefined) {
    const result = this.relaySession?.commit() ?? { ok: false as const, reason: "empty" as const };
    if (result.ok) {
      this.announceCommitted(result.itemSeq);
      return;
    }
    if (result.reason === "ended") return;
    if (result.reason === "empty") {
      this.clientError({
        code: "input_audio_buffer_commit_empty",
        message: "The input audio buffer is empty.",
        eventId,
      });
      return;
    }
    this.clientError({
      code: "rate_limited",
      message:
        result.reason === "too_many_items"
          ? "Too many items are waiting for transcription; wait for results before committing more."
          : "Too many pending commands.",
      eventId,
    });
  }

  private clear(eventId: string | undefined) {
    const relay = this.relaySession;
    if (relay) {
      const result = relay.clear();
      if (!result.ok) {
        if (result.reason === "ended") return;
        this.clientError({ code: "rate_limited", message: "Too many pending commands.", eventId });
        return;
      }
      this.items.delete(result.itemSeq);
    }
    this.send(clearedEvent());
  }

  private announceCommitted(itemSeq: number) {
    const record = this.itemRecord(itemSeq);
    record.previousItemId = this.lastItemId;
    record.announced = true;
    for (const event of committedEvents(record.id, record.previousItemId)) this.send(event);
    this.lastItemId = record.id;
  }

  private itemRecord(itemSeq: number): ItemRecord {
    let record = this.items.get(itemSeq);
    if (!record) {
      record = { id: realtimeId("item"), previousItemId: null, announced: false };
      this.items.set(itemSeq, record);
      // The relay bounds items in flight; this only guards the map itself.
      if (this.items.size > ITEM_RECORDS_MAX) {
        const oldest = this.items.keys().next().value;
        if (oldest !== undefined) this.items.delete(oldest);
      }
    }
    return record;
  }

  // ---- routing ----

  private config(change: SttConfig = {}): SttConfig {
    const language = change.language ?? this.view.language;
    const prompt = change.prompt ?? this.view.prompt;
    return {
      ...(language !== undefined ? { language } : {}),
      ...(prompt !== undefined ? { prompt } : {}),
    };
  }

  private startRouting() {
    const model = this.view.model;
    if (!model) return;
    const created = this.deps.relay.createSttSession({
      consumer: this.consumer,
      config: this.config(),
    });
    if (!created.ok) {
      if (created.reason === "shutting_down") {
        this.fail(REALTIME_CLOSE_CODES.goingAway, {
          type: "server_error",
          code: "server_shutting_down",
          message: "The server is shutting down.",
        });
      } else {
        this.fail(REALTIME_CLOSE_CODES.tryAgainLater, {
          type: "server_error",
          code: "server_busy",
          message: "The server has no room for another live session.",
        });
      }
      return;
    }
    this.relaySession = created.session;
    this.state = "routing";
    this.routingAbort = new AbortController();
    this.routingTimer = setTimeout(() => {
      if (this.state !== "routing") return;
      // The deadline cut an open in flight: that member did not answer in time.
      const cut = this.attempting;
      if (cut) this.notifyMemberFailed(cut, "timeout");
      this.fail(REALTIME_CLOSE_CODES.tryAgainLater, {
        type: "server_error",
        code: "server_busy",
        message: "No live transcription capacity became available in time.",
      });
    }, REALTIME_ROUTING_DEADLINE_MS);
    this.routingTimer.unref?.();
    const deadline = Date.now() + REALTIME_ROUTING_DEADLINE_MS;
    void this.route(model, created.session, this.routingAbort.signal, deadline).catch(() => {
      this.fail(REALTIME_CLOSE_CODES.internal, {
        type: "server_error",
        code: "server_error",
        message: "The session could not be routed.",
      });
    });
  }

  private async route(
    model: string,
    relay: SttRelaySession,
    signal: AbortSignal,
    deadline: number,
  ) {
    const route = await this.deps.router.candidates({ model, config: this.config(), signal });
    if (this.state !== "routing" || signal.aborted) return;
    if (!route.ok) {
      const { error, close } = ROUTE_ERRORS[route.code];
      this.fail(close, error);
      return;
    }
    let attempts = 0;
    let sawCapacity = false;
    let tried = 0;
    let notEligible = 0;
    for (const candidate of route.candidates) {
      if (attempts >= REALTIME_MAX_OPEN_ATTEMPTS) break;
      const admitted = await this.admit(candidate, signal);
      if (this.state !== "routing" || signal.aborted) {
        if (admitted.ok) this.releaseLease(admitted.lease);
        return;
      }
      if (!admitted.ok) {
        sawCapacity = true;
        continue;
      }
      this.lease = admitted.lease;
      const budget = Math.min(REALTIME_OPEN_ATTEMPT_MS, deadline - Date.now());
      if (budget < REALTIME_OPEN_ATTEMPT_MIN_MS) {
        this.releaseLease(this.lease);
        this.lease = null;
        return; // the routing deadline ends the session
      }
      const attempt: { pending: Promise<SttAttachResult> | null } = { pending: null };
      const open = () => {
        this.attempting = candidate;
        // With a send claim, nothing is sent after `stt.opened` until the
        // claim commits (security review L2); a failed commit withdraws the
        // opened leg and routing moves on.
        attempt.pending = relay.attach(candidate, {
          openTimeoutMs: budget,
          holdUntilReleased: Boolean(this.deps.hooks?.authorizeOpen),
        });
      };
      const authorized = await this.authorizeOpen(candidate, open, () => relay.cancelOpening());
      // Awaited directly (review L2): `opened` is seen before any `onEnd`.
      const outcome = attempt.pending ? await attempt.pending : null;
      this.attempting = null;
      if (this.state !== "routing" || signal.aborted || outcome?.status === "ended") return;
      if (!authorized.ok || !outcome) {
        // Never left open unauthorized, whatever the claim did with `abort`.
        if (outcome?.status === "opened") relay.cancelOpening();
        if (relay.status === "ended") return;
        this.releaseLease(this.lease);
        this.lease = null;
        if (!authorized.ok && authorized.denial === "requester") {
          this.fail(REALTIME_CLOSE_CODES.policy, {
            type: "invalid_request_error",
            ...(this.deps.credentialEnded ?? {
              code: "invalid_api_key",
              message: "The API key is no longer valid.",
            }),
          });
          return;
        }
        if (!authorized.ok && authorized.denial === "access") {
          this.fail(REALTIME_CLOSE_CODES.policy, ROUTE_ERRORS.model_not_found.error);
          return;
        }
        continue; // this member is unavailable now; never a health failure
      }
      if (outcome.status === "opened") {
        this.opened(candidate, outcome);
        relay.releaseHold();
        return;
      }
      this.releaseLease(this.lease);
      this.lease = null;
      tried += 1;
      if (outcome.reason === "not_eligible") notEligible += 1;
      if (openWasAttempted(outcome.reason)) attempts += 1;
      if (outcome.failure === "rate_limited") sawCapacity = true;
      if (openFailureMarksMember(outcome)) this.notifyMemberFailed(candidate, outcome.failure);
      else if (openFailureIsConfiguration(outcome)) {
        const failure = outcome.failure;
        this.hook(() => this.deps.router.memberMisconfigured?.(candidate, failure));
      }
    }
    const config = this.config();
    if (tried > 0 && notEligible === tried && !sawCapacity && (config.language || config.prompt)) {
      // Every member's engine takes no language or prompt (vLLM).
      this.fail(REALTIME_CLOSE_CODES.policy, {
        type: "invalid_request_error",
        code: "unsupported_parameter",
        message: "This model's live transcription takes no language or prompt.",
        param: config.language
          ? "session.audio.input.transcription.language"
          : "session.audio.input.transcription.prompt",
      });
      return;
    }
    // The routing deadline, not the members, ended the search when the last
    // attempt timed out against it (its timer and the deadline can fire in
    // the same tick): that is busy (1013), deterministically.
    if (Date.now() >= deadline - REALTIME_OPEN_ATTEMPT_MIN_MS) sawCapacity = true;
    this.fail(
      sawCapacity ? REALTIME_CLOSE_CODES.tryAgainLater : REALTIME_CLOSE_CODES.internal,
      sawCapacity
        ? {
            type: "server_error",
            code: "server_busy",
            message: "Every live transcription member is at capacity.",
          }
        : {
            type: "server_error",
            code: "upstream_unavailable",
            message: "No member could open the live transcription session.",
          },
    );
  }

  private opened(
    candidate: RealtimeCandidate,
    outcome: Extract<SttAttachResult, { status: "opened" }>,
  ) {
    this.state = "open";
    this.clearRoutingTimer();
    this.routingAbort = null;
    this.openedOn = candidate;
    this.hook(() =>
      this.deps.hooks?.opened?.(candidate, {
        adapter: outcome.adapter,
        maxItemSeconds: outcome.maxItemSeconds,
        lease: this.deps.hooks?.admit ? this.lease : null,
      }),
    );
    // Updates held while routing are answered now, in order.
    const held = this.heldUpdates.splice(0);
    for (const { patch, eventId } of held) {
      if (this.status === "closed") return;
      this.applyPatch(patch, eventId);
    }
  }

  private async admit(
    candidate: RealtimeCandidate,
    signal: AbortSignal,
  ): Promise<RealtimeAdmitResult> {
    const admit = this.deps.hooks?.admit;
    if (!admit) return { ok: true, lease: { release() {} } };
    try {
      return await admit(candidate, signal);
    } catch {
      return { ok: false };
    }
  }

  private async authorizeOpen(
    candidate: RealtimeCandidate,
    open: () => void,
    abort: () => void,
  ): Promise<RealtimeAuthorizeResult> {
    const authorize = this.deps.hooks?.authorizeOpen;
    if (!authorize) {
      open();
      return { ok: true };
    }
    try {
      return await authorize(candidate, open, abort);
    } catch {
      // A broken claim never lets an open stand.
      abort();
      return { ok: false, denial: "check_failed" };
    }
  }

  private releaseLease(lease: RealtimeCandidateLease | null) {
    if (lease) this.hook(() => lease.release());
  }

  private notifyMemberFailed(candidate: RealtimeCandidate, failure: RelayFailure) {
    this.hook(() => this.deps.router.memberOpenFailed(candidate, failure));
  }

  /** Runs a port callback; a throwing hook never breaks the session. */
  private hook(run: () => void) {
    try {
      run();
    } catch {
      // Isolated by contract; the hook owns its own reporting.
    }
  }

  // ---- relay events ----

  private onRelayEvent(event: SttSessionEvent) {
    if (this.state === "closed") return;
    switch (event.kind) {
      case "delta": {
        const record = this.itemRecord(event.itemSeq);
        record.announced = true;
        this.send(transcriptionDeltaEvent(record.id, event.text));
        return;
      }
      case "auto_committed":
        this.announceCommitted(event.itemSeq);
        return;
      case "completed": {
        const record = this.itemRecord(event.itemSeq);
        this.items.delete(event.itemSeq);
        this.hook(() =>
          this.deps.hooks?.itemFinished?.({
            itemSeq: event.itemSeq,
            itemId: record.id,
            status: "completed",
            audioBytes: event.audioBytes,
            audioSeconds: audioSeconds(event.audioBytes),
            transcriptBytes: Buffer.byteLength(event.text, "utf8"),
            ...(event.engineUsage ? { engineUsage: event.engineUsage } : {}),
          }),
        );
        for (const out of transcriptionCompletedEvents(
          record.id,
          record.previousItemId,
          event.text,
          event.audioBytes,
        )) {
          this.send(out);
        }
        return;
      }
      case "failed": {
        const record = this.itemRecord(event.itemSeq);
        this.items.delete(event.itemSeq);
        const failure = itemFailure(event.code);
        this.hook(() =>
          this.deps.hooks?.itemFinished?.({
            itemSeq: event.itemSeq,
            itemId: record.id,
            status: "failed",
            audioBytes: 0,
            audioSeconds: 0,
            code: failure.code,
            transcriptBytes: 0,
          }),
        );
        this.send(transcriptionFailedEvent(record.id, failure.code, failure.message));
        return;
      }
    }
  }

  private onRelayDrain() {
    if (this.state === "closed") return;
    this.backlogged = false;
    // `apply` may close the session or pause again; re-read both each turn.
    while (this.deferred.length > 0 && !this.backlogged && this.status !== "closed") {
      const next = this.deferred.shift();
      if (!next) break;
      if (next.type === "input_audio_buffer.append")
        this.deferredAudioBytes -= next.audio.byteLength;
      this.apply(next);
    }
    if (
      !this.backlogged &&
      this.deferred.length === 0 &&
      this.clientPaused &&
      this.status !== "closed"
    ) {
      this.clientPaused = false;
      this.deps.client.resume();
    }
  }

  private onRelayEnd(end: SttSessionEnd) {
    if (this.state === "closed") return; // we ended it
    const mapped = relayEndToClient(end);
    // Items the client knows of (committed, or named by a delta) that will
    // never get a result are failed first; unannounced audio is not an item yet.
    const pending = [...this.items.entries()].sort(([a], [b]) => a - b);
    this.items.clear();
    for (const [itemSeq, record] of pending) {
      if (!record.announced) continue;
      this.hook(() =>
        this.deps.hooks?.itemFinished?.({
          itemSeq,
          itemId: record.id,
          status: "failed",
          audioBytes: 0,
          audioSeconds: 0,
          code: mapped.error.code,
          transcriptBytes: 0,
        }),
      );
      this.send(transcriptionFailedEvent(record.id, mapped.error.code, mapped.itemMessage));
    }
    this.closeWith({ code: mapped.close, error: mapped.error, relayReason: null });
  }

  // ---- plumbing ----

  private pauseClient() {
    this.backlogged = true;
    if (this.clientPaused) return;
    this.clientPaused = true;
    this.deps.client.pause();
  }

  private defer(event: RealtimeClientEvent) {
    const bytes = event.type === "input_audio_buffer.append" ? event.audio.byteLength : 0;
    if (
      this.deferred.length >= REALTIME_DEFERRED_EVENTS_MAX ||
      this.deferredAudioBytes + bytes > REALTIME_DEFERRED_AUDIO_MAX_BYTES
    ) {
      this.fail(REALTIME_CLOSE_CODES.tryAgainLater, {
        type: "server_error",
        code: "audio_backlog",
        message: "Audio arrived faster than the model could take it.",
      });
      return;
    }
    this.deferred.push(event);
    this.deferredAudioBytes += bytes;
  }

  /** 400 events per 10 s; three windows in a row over it close the socket. */
  private admitEventRate(): boolean {
    const now = Date.now();
    if (now - this.rateWindowStart >= REALTIME_EVENT_RATE_WINDOW_MS) {
      const consecutive = now - this.rateWindowStart < 2 * REALTIME_EVENT_RATE_WINDOW_MS;
      if (!this.rateWindowExceeded || !consecutive) this.rateStrikes = 0;
      this.rateWindowStart = now;
      this.rateCount = 0;
      this.rateWindowExceeded = false;
    }
    this.rateCount += 1;
    if (this.rateCount <= REALTIME_EVENT_RATE_MAX) return true;
    if (!this.rateWindowExceeded) {
      this.rateWindowExceeded = true;
      this.rateStrikes += 1;
      if (this.rateStrikes >= REALTIME_RATE_STRIKES_MAX) {
        this.fail(REALTIME_CLOSE_CODES.policy, {
          type: "invalid_request_error",
          code: "rate_limited",
          message: "Too many events; the session is closed.",
        });
        return false;
      }
      this.send(
        errorEvent({
          type: "invalid_request_error",
          code: "rate_limited",
          message: `More than ${REALTIME_EVENT_RATE_MAX} events in ${REALTIME_EVENT_RATE_WINDOW_MS / 1000} s; events are dropped.`,
        }),
      );
    }
    return false;
  }

  private armIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.closeWith({
        code: REALTIME_CLOSE_CODES.normal,
        error: {
          type: "invalid_request_error",
          code: "idle_timeout",
          message: "No audio arrived for 120 seconds.",
        },
        relayReason: "timeout",
      });
    }, REALTIME_IDLE_TIMEOUT_MS);
    this.idleTimer.unref?.();
  }

  private clearRoutingTimer() {
    if (this.routingTimer) clearTimeout(this.routingTimer);
    this.routingTimer = null;
  }

  private clientError(error: Omit<RealtimeError, "type">) {
    this.send(errorEvent({ type: "invalid_request_error", ...error }));
  }

  private fail(code: RealtimeCloseCode, error: Omit<RealtimeError, "eventId">) {
    this.closeWith({ code, error, relayReason: "cancelled" });
  }

  /** Sends one event unless the client is gone or not reading (slow consumer). */
  private send(event: object) {
    if (this.state === "closed") return;
    if (this.deps.client.bufferedAmount() > REALTIME_CLIENT_BUFFER_LIMIT) {
      this.closeWith({
        code: REALTIME_CLOSE_CODES.tryAgainLater,
        error: {
          type: "server_error",
          code: "slow_consumer",
          message: "The client is not reading events fast enough.",
        },
        relayReason: "cancelled",
      });
      return;
    }
    this.rawSend(event);
  }

  private rawSend(event: object) {
    try {
      this.deps.client.send(JSON.stringify(event));
    } catch {
      this.clientClosed();
    }
  }

  /**
   * Every end goes through here once. `code: null` means the client socket is
   * already gone. `relayReason` closes the relay session (null: it ended).
   */
  private closeWith({
    code,
    error,
    relayReason,
  }: {
    code: RealtimeCloseCode | null;
    error: Omit<RealtimeError, "eventId"> | null;
    relayReason: RelayFailure | null;
  }) {
    if (this.state === "closed") return;
    this.state = "closed";
    this.clearRoutingTimer();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.routingAbort?.abort();
    this.routingAbort = null;
    this.deferred.length = 0;
    this.deferredAudioBytes = 0;
    this.heldUpdates.length = 0;
    this.items.clear();
    this.attempting = null;
    const relay = this.relaySession;
    this.relaySession = null;
    if (relay && relayReason && relay.status !== "ended") relay.close(relayReason);
    const sentAudioBytes = relay?.sentAudioBytes ?? 0;
    this.releaseLease(this.lease);
    this.lease = null;
    this.deps.admission.release();
    if (code !== null) {
      if (error) this.rawSend(errorEvent(error));
      try {
        this.deps.client.close(code, error?.code ?? "");
      } catch {
        // Already closed.
      }
    }
    const candidate = this.openedOn;
    this.hook(() =>
      this.deps.hooks?.ended?.({
        candidate,
        closeCode: code,
        errorCode: error?.code ?? null,
        sentAudioBytes,
      }),
    );
  }
}

function relayEndToClient(end: SttSessionEnd): {
  close: RealtimeCloseCode;
  error: Omit<RealtimeError, "eventId">;
  itemMessage: string;
} {
  const itemMessage = "The session ended before this item was transcribed.";
  switch (end.cause) {
    case "shutdown":
      return {
        close: REALTIME_CLOSE_CODES.goingAway,
        error: {
          type: "server_error",
          code: "server_shutting_down",
          message: "The server is shutting down.",
        },
        itemMessage,
      };
    case "expired":
      return {
        close: REALTIME_CLOSE_CODES.normal,
        error: {
          type: "invalid_request_error",
          code: "session_expired",
          message: "The session reached its maximum duration.",
        },
        itemMessage,
      };
    case "audio_backlog":
      return {
        close: REALTIME_CLOSE_CODES.tryAgainLater,
        error: {
          type: "server_error",
          code: "audio_backlog",
          message: "Audio arrived faster than the model could transcribe it.",
        },
        itemMessage,
      };
    case "endpoint_unavailable":
      return {
        close: REALTIME_CLOSE_CODES.internal,
        error: {
          type: "server_error",
          code: "model_unavailable",
          message: "The model was stopped during the session.",
        },
        itemMessage,
      };
    default:
      return {
        close: REALTIME_CLOSE_CODES.internal,
        error: {
          type: "server_error",
          code: "upstream_disconnected",
          message: "The transcription node failed or disconnected.",
        },
        itemMessage,
      };
  }
}
