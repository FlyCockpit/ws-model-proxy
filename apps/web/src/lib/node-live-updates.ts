import type { QueryClient } from "@tanstack/react-query";

import { orpc } from "@/utils/orpc";

/**
 * Pure parts of the node live updates (#255): the stream's path and timings, its event, the
 * queries an event refreshes, the stream's status machine, and the poll interval pages use
 * while the stream is down. The connection itself is `hooks/use-node-live-updates.ts`; its
 * reconnect backoff is the shared one in `lib/reconnect-backoff.ts`.
 */

export const NODE_EVENTS_PATH = "/api/dashboard/events";

/** Events that arrive this close together refresh the queries once (a reconnect burst). */
export const NODE_LIVE_COALESCE_MS = 250;
/** The server pings every 25 s: nothing for this long means a dead (half-open) stream. */
export const NODE_LIVE_WATCHDOG_MS = 65_000;
/** A stream that stayed open this long resets the reconnect backoff when it ends. */
export const NODE_LIVE_STABLE_MS = 30_000;
/** Down this long before pages say so (a deploy or a brief network drop says nothing). */
export const NODE_LIVE_NOTICE_MS = 10_000;

export type NodeLiveEvent = { type: string; nodeId: string };

/**
 * One `event: node` payload, or null when it is not one. Every type refreshes the same
 * queries, so a type this build does not know (added by a newer server) still refreshes them.
 */
export function parseNodeLiveEvent(data: string): NodeLiveEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const type = Reflect.get(value, "type");
  const nodeId = Reflect.get(value, "nodeId");
  if (typeof type !== "string" || typeof nodeId !== "string") return null;
  return { type, nodeId };
}

/**
 * The queries that show a node's connection, trust or update state, or what follows from them.
 * Only the active ones refetch; the others are marked stale and refetch when shown.
 */
export function nodeLiveQueryKeys() {
  return [
    orpc.nodes.list.key(),
    orpc.nodes.get.key(),
    orpc.nodes.agentUpdate.overview.key(),
    orpc.nodes.enrollmentCodes.list.key(),
    orpc.activity.overview.summary.key(),
    orpc.runtimes.get.key(),
  ];
}

export function invalidateNodeLiveQueries(queryClient: QueryClient): Promise<void> {
  return Promise.all(
    nodeLiveQueryKeys().map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  ).then(() => undefined);
}

/**
 * The stream's status as pages see it. Every state carries `notice` so a page can select it
 * alone, but only `down` can have it set: the other states fix it to false.
 *
 * - `off`: no stream (signed out, or no `fetch`).
 * - `connecting`: the first attempt (or one after being live) is in flight.
 * - `live`: the stream is open.
 * - `down`: it ended or was refused, and a reconnect is waiting or in flight. `notice`: it has
 *   been down for {@link NODE_LIVE_NOTICE_MS}, so pages say so.
 * - `unauthorized`: final until the session changes (the hook then starts again from `off`).
 */
export type NodeLiveState =
  | { status: "off"; notice: false }
  | { status: "connecting"; notice: false }
  | { status: "live"; notice: false }
  | { status: "down"; notice: boolean }
  | { status: "unauthorized"; notice: false };

export type NodeLiveStatus = NodeLiveState["status"];

/**
 * What the stream reports. `connecting`: an attempt starts. `opened`: the response is a
 * stream. `failed`: an attempt or an open stream ended. `noticeDue`: down for
 * `NODE_LIVE_NOTICE_MS`. `unauthorized`: a 401/403 or an `unauthorized` event. `off`: the
 * stream was closed (sign-out, unmount).
 */
export type NodeLiveEventKind =
  | "connecting"
  | "opened"
  | "failed"
  | "noticeDue"
  | "unauthorized"
  | "off";

export const NODE_LIVE_OFF: NodeLiveState = { status: "off", notice: false };

/**
 * The status machine. Rules a page relies on:
 * - A reconnect attempt while down stays `down` (with its notice): pages keep polling and the
 *   notice does not flicker on every retry.
 * - `unauthorized` is final: only `off` (the session changed) leaves it.
 * - `off` only leaves through `connecting`: a late report from a closed stream changes nothing.
 * - `noticeDue` only sets the notice while still down.
 */
export function nodeLiveTransition(state: NodeLiveState, event: NodeLiveEventKind): NodeLiveState {
  if (event === "off") return NODE_LIVE_OFF;
  if (state.status === "unauthorized") return state;
  if (state.status === "off" && event !== "connecting") return state;
  switch (event) {
    case "connecting":
      return state.status === "down" ? state : { status: "connecting", notice: false };
    case "opened":
      return { status: "live", notice: false };
    case "failed":
      return state.status === "down" ? state : { status: "down", notice: false };
    case "noticeDue":
      return state.status === "down" ? { status: "down", notice: true } : state;
    case "unauthorized":
      return { status: "unauthorized", notice: false };
  }
}

/**
 * A page's poll interval: `whenLive` while the stream is open (false: no poll, the push
 * refreshes it), `fallback` otherwise (today's interval, so a blocked stream is never worse).
 */
export function nodeLiveInterval(
  status: NodeLiveStatus,
  fallback: number,
  whenLive: number | false = false,
): number | false {
  return status === "live" ? whenLive : fallback;
}
