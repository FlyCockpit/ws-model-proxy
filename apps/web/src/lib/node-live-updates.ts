import type { QueryClient } from "@tanstack/react-query";

import { orpc } from "@/utils/orpc";

/**
 * Pure parts of the node live updates (#255): the stream's path and timings, its event, the
 * queries an event refreshes, and the poll interval pages use while the stream is down. The
 * connection itself is `hooks/use-node-live-updates.ts`.
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

/** The terminal socket's backoff: 0.5 s doubling to 15 s, plus up to 250 ms of jitter. */
export function nodeLiveReconnectDelayMs(attempt: number, random: () => number = Math.random) {
  return Math.min(15_000, 500 * 2 ** attempt) + Math.floor(random() * 250);
}

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

export type NodeLiveStatus = "off" | "connecting" | "live" | "down" | "unauthorized";

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
