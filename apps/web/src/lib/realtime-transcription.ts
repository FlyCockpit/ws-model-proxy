import type { VisibleModels } from "@/components/chat-test/chat-test-types";

/**
 * Pure pieces of the Chat Test live transcription panel: the socket address,
 * PCM encoding, and the reducer that turns the realtime transcription events
 * (the `/v1/realtime` protocol) into a short transcript list.
 *
 * The panel's socket is the dashboard's own: the session cookie signs it in,
 * as for every other Chat Test request. No token is typed, sent or stored.
 */

export type LiveModelOption = { modelId: string; label: string };

/** Models whose capabilities advertise live transcription (a hint; the server decides). */
export function liveModelOptions(visibleModels: VisibleModels | undefined): LiveModelOption[] {
  if (!visibleModels) return [];
  return [
    ...visibleModels.directModels
      .filter((model) => model.realtimeTranscription)
      .map((model) => ({ modelId: model.modelId, label: model.upstreamModelId })),
    ...visibleModels.modelPools
      .filter((pool) => pool.realtimeTranscription)
      .map((pool) => ({ modelId: pool.modelId, label: pool.name })),
  ];
}

export const CHAT_TEST_REALTIME_PATH = "/api/internal/chat-test/realtime";
export const REALTIME_WORKLET_URL = "/realtime-pcm-worklet.js";
export const REALTIME_WORKLET_NAME = "realtime-pcm";
/** Transcript entries kept on screen. */
export const REALTIME_ITEMS_MAX = 50;

/** The same-origin Chat Test socket, with only the intent and the model in the query. */
export function realtimeSocketUrl(model: string, location: Pick<Location, "href" | "protocol">) {
  const url = new URL(CHAT_TEST_REALTIME_PATH, location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  url.search = "";
  url.searchParams.set("intent", "transcription");
  url.searchParams.set("model", model);
  return url.toString();
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
  dashboard_session_ended: "signedOut",
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
 * close (1006) is how a browser reports a refused upgrade (signed out, too
 * many sessions, the server restarting): it cannot see the HTTP status.
 */
export function problemMessageKey(problem: RealtimeProblem): string {
  if (problem.kind === "mic") return `mic.${problem.reason}`;
  if (problem.kind === "server") return SERVER_PROBLEM_KEYS[problem.code] ?? "server";
  return CLOSE_PROBLEM_KEYS[problem.code] ?? "connection";
}
