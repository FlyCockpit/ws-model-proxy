/**
 * Pure pieces of the Chat Test live transcription panel: the socket address,
 * the browser login (subprotocols), PCM encoding, and the reducer that turns
 * `/v1/realtime` transcription events into a short transcript list.
 *
 * The API token travels only as the `openai-insecure-api-key.<token>`
 * subprotocol (the server selects `realtime` and never echoes it). It is
 * never put in the URL and never stored.
 */

export const REALTIME_SUBPROTOCOL = "realtime";
export const REALTIME_KEY_SUBPROTOCOL_PREFIX = "openai-insecure-api-key.";
export const REALTIME_WORKLET_URL = "/realtime-pcm-worklet.js";
export const REALTIME_WORKLET_NAME = "realtime-pcm";
/** Model API tokens; the subprotocol needs a token of URL-safe characters. */
const MODEL_API_TOKEN = /^wsmp_model_[A-Za-z0-9_-]{8,}$/;
/** Transcript entries kept on screen. */
export const REALTIME_ITEMS_MAX = 50;

export function isModelApiToken(value: string): boolean {
  return MODEL_API_TOKEN.test(value.trim());
}

/** Same-origin `/v1/realtime`, with only the intent and the model in the query. */
export function realtimeSocketUrl(model: string, location: Pick<Location, "href" | "protocol">) {
  const url = new URL("/v1/realtime", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.search = "";
  url.searchParams.set("intent", "transcription");
  url.searchParams.set("model", model);
  return url.toString();
}

export function realtimeSubprotocols(token: string): string[] {
  return [REALTIME_SUBPROTOCOL, `${REALTIME_KEY_SUBPROTOCOL_PREFIX}${token.trim()}`];
}

/** Base64 of raw PCM bytes, in chunks so large buffers never overflow the call stack. */
export function pcm16Base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export type RealtimeItem = {
  id: string;
  text: string;
  status: "transcribing" | "done" | "failed";
  seconds?: number;
};

/** Why the panel stopped or warns; each maps to a translated message. */
export type RealtimeProblem =
  | { kind: "mic"; reason: "denied" | "missing" | "failed" | "unsupported" }
  | { kind: "server"; code: string }
  | { kind: "close"; code: number };

export type RealtimePhase = "idle" | "starting" | "live" | "stopped" | "failed";

export type RealtimeState = {
  phase: RealtimePhase;
  items: RealtimeItem[];
  problem: RealtimeProblem | null;
};

export const initialRealtimeState: RealtimeState = { phase: "idle", items: [], problem: null };

export type RealtimeAction =
  | { type: "starting" }
  | { type: "live" }
  | { type: "event"; event: unknown }
  | { type: "closed"; code: number; requested: boolean }
  | { type: "failed"; problem: RealtimeProblem }
  | { type: "reset" };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function upsert(
  items: RealtimeItem[],
  id: string,
  change: (item: RealtimeItem) => RealtimeItem,
): RealtimeItem[] {
  const index = items.findIndex((item) => item.id === id);
  if (index >= 0) return items.map((item, at) => (at === index ? change(item) : item));
  const next = [...items, change({ id, text: "", status: "transcribing" })];
  return next.length > REALTIME_ITEMS_MAX ? next.slice(next.length - REALTIME_ITEMS_MAX) : next;
}

function applyEvent(state: RealtimeState, raw: unknown): RealtimeState {
  const event = record(raw);
  if (!event) return state;
  const itemId = text(event.item_id);
  switch (event.type) {
    case "session.created":
      return { ...state, phase: "live" };
    case "input_audio_buffer.committed":
      return itemId ? { ...state, items: upsert(state.items, itemId, (item) => item) } : state;
    case "conversation.item.input_audio_transcription.delta": {
      const delta = text(event.delta);
      if (!itemId || delta === null) return state;
      return {
        ...state,
        items: upsert(state.items, itemId, (item) => ({ ...item, text: item.text + delta })),
      };
    }
    case "conversation.item.input_audio_transcription.completed": {
      const transcript = text(event.transcript);
      if (!itemId || transcript === null) return state;
      const seconds = record(event.usage)?.seconds;
      return {
        ...state,
        items: upsert(state.items, itemId, (item) => ({
          ...item,
          text: transcript,
          status: "done",
          ...(typeof seconds === "number" ? { seconds } : {}),
        })),
      };
    }
    case "conversation.item.input_audio_transcription.failed":
      return itemId
        ? {
            ...state,
            items: upsert(state.items, itemId, (item) => ({ ...item, status: "failed" })),
          }
        : state;
    case "error": {
      const code = text(record(event.error)?.code) ?? "unknown";
      return { ...state, problem: { kind: "server", code } };
    }
    default:
      return state;
  }
}

export function realtimeReducer(state: RealtimeState, action: RealtimeAction): RealtimeState {
  switch (action.type) {
    case "starting":
      return { phase: "starting", items: [], problem: null };
    case "live":
      return { ...state, phase: "live" };
    case "event":
      return applyEvent(state, action.event);
    case "closed": {
      if (state.phase === "idle") return state;
      // A close the person asked for, or a clean end, is not a failure. The
      // server sends an `error` event before every other close; keep it.
      const clean = action.requested || action.code === 1000;
      if (clean) return { ...state, phase: "stopped" };
      return {
        ...state,
        phase: "failed",
        problem: state.problem ?? { kind: "close", code: action.code },
      };
    }
    case "failed":
      return { ...state, phase: "failed", problem: action.problem };
    case "reset":
      return initialRealtimeState;
  }
}

/** A `getUserMedia` / AudioWorklet failure, by its DOMException name. */
export function micProblem(error: unknown): RealtimeProblem {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return { kind: "mic", reason: "denied" };
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return { kind: "mic", reason: "missing" };
  return { kind: "mic", reason: "failed" };
}

const SERVER_PROBLEM_KEYS: Record<string, string> = {
  invalid_api_key: "invalidKey",
  model_not_found: "modelNotFound",
  model_not_available: "busy",
  server_busy: "busy",
  rate_limited: "busy",
  audio_backlog: "backlog",
  slow_consumer: "backlog",
  upstream_disconnected: "upstream",
  upstream_unavailable: "upstream",
  model_unavailable: "upstream",
  capacity_lease_lost: "upstream",
  server_shutting_down: "shutdown",
  session_expired: "expired",
  idle_timeout: "idle",
  input_audio_buffer_commit_empty: "emptyCommit",
};

const CLOSE_PROBLEM_KEYS: Record<number, string> = {
  1001: "shutdown",
  1008: "denied",
  1011: "upstream",
  1013: "busy",
};

/**
 * The `dashboard:chatTest.live.problems.*` key for a problem. An abnormal
 * close (1006) is how a browser reports a refused upgrade (bad token, no
 * live member, rate limit): it cannot see the HTTP status.
 */
export function problemMessageKey(problem: RealtimeProblem): string {
  if (problem.kind === "mic") return `mic.${problem.reason}`;
  if (problem.kind === "server") return SERVER_PROBLEM_KEYS[problem.code] ?? "server";
  return CLOSE_PROBLEM_KEYS[problem.code] ?? "connection";
}
