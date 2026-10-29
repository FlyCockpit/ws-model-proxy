import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import {
  invalidateNodeLiveQueries,
  NODE_EVENTS_PATH,
  NODE_LIVE_COALESCE_MS,
  NODE_LIVE_NOTICE_MS,
  NODE_LIVE_STABLE_MS,
  NODE_LIVE_WATCHDOG_MS,
  nodeLiveReconnectDelayMs,
  parseNodeLiveEvent,
} from "@/lib/node-live-updates";
import { createSseParser } from "@/lib/sse-parse";
import { useNodeLive } from "@/stores/node-live";

/**
 * The tab's one node event stream (#255; the server side is apps/server/src/node-events/).
 * Mounted once in the root with the signed-in session's id (null: signed out, no stream).
 *
 * The push is a hint: on every event, and after every (re)connect (events may have been missed
 * while down), it waits {@link NODE_LIVE_COALESCE_MS} for more, then invalidates the node
 * queries once (`invalidateNodeLiveQueries`). The queries stay the source of truth, so there is
 * no replay.
 *
 * `fetch`, not `EventSource`: a 401 or 403 (the session ended, a ban, the force-2FA policy) and
 * an `unauthorized` event are final until the session changes; anything else (a deploy's 503,
 * a 429, a network drop) reconnects with the terminal socket's backoff. The backoff resets
 * after a stream stayed open {@link NODE_LIVE_STABLE_MS}. Coming back online, or to the tab,
 * reconnects at once. A watchdog ends a stream that heard nothing (not even the server's ping)
 * for {@link NODE_LIVE_WATCHDOG_MS}: after sleep the connection can be half-open.
 *
 * Its status goes to `useNodeLive`; pages poll at their old intervals while it is not live.
 */
export function useNodeLiveUpdates(sessionKey: string | null): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!sessionKey || typeof window === "undefined" || typeof fetch !== "function") {
      useNodeLive.getState().set({ status: "off" });
      return undefined;
    }
    return openNodeEventStream(queryClient);
  }, [sessionKey, queryClient]);
}

/** Opens the stream and keeps it open (reconnecting) until the returned function ends it. */
function openNodeEventStream(queryClient: QueryClient): () => void {
  let disposed = false;
  let stopped = false;
  let attempt = 0;
  let controller: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;

  const refreshSoon = () => {
    if (flushTimer !== undefined) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      if (!disposed) void invalidateNodeLiveQueries(queryClient);
    }, NODE_LIVE_COALESCE_MS);
  };

  const markLive = () => {
    clearTimeout(noticeTimer);
    noticeTimer = undefined;
    useNodeLive.getState().set({ status: "live" });
  };

  const markDown = () => {
    const { notice } = useNodeLive.getState();
    useNodeLive.getState().set({ status: "down", notice });
    if (notice || noticeTimer !== undefined) return;
    noticeTimer = setTimeout(() => {
      noticeTimer = undefined;
      if (!disposed && useNodeLive.getState().status === "down")
        useNodeLive.getState().set({ status: "down", notice: true });
    }, NODE_LIVE_NOTICE_MS);
  };

  const stop = () => {
    stopped = true;
    clearTimeout(noticeTimer);
    noticeTimer = undefined;
    useNodeLive.getState().set({ status: "unauthorized" });
  };

  const armWatchdog = (current: AbortController) => {
    clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => current.abort(), NODE_LIVE_WATCHDOG_MS);
  };

  const connect = async () => {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    if (disposed || stopped || controller) return;
    const current = new AbortController();
    controller = current;
    if (useNodeLive.getState().status !== "down")
      useNodeLive.getState().set({ status: "connecting" });
    let openedAt: number | null = null;
    // Also bounds a response whose headers never arrive (a buffering proxy).
    armWatchdog(current);
    try {
      const response = await fetch(NODE_EVENTS_PATH, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "text/event-stream" },
        signal: current.signal,
      });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined);
        stop();
        return;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      openedAt = performance.now();
      markLive();
      refreshSoon();
      armWatchdog(current);
      const parser = createSseParser((event) => {
        if (event.event === "unauthorized") {
          stop();
          current.abort();
        } else if (event.event === "node" && parseNodeLiveEvent(event.data)) {
          refreshSoon();
        }
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armWatchdog(current);
        parser.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // A network error, the watchdog or the cleanup (an abort): the finally decides.
    } finally {
      clearTimeout(watchdogTimer);
      if (controller === current) controller = null;
      if (!disposed && !stopped) {
        markDown();
        if (openedAt !== null && performance.now() - openedAt >= NODE_LIVE_STABLE_MS) attempt = 0;
        retryTimer = setTimeout(() => void connect(), nodeLiveReconnectDelayMs(attempt));
        attempt += 1;
      }
    }
  };

  // Back online, or back to the tab: no need to wait out the backoff.
  const reconnectNow = () => {
    if (disposed || stopped || controller) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    void connect();
  };
  const onVisibility = () => {
    if (document.visibilityState === "visible") reconnectNow();
  };
  window.addEventListener("online", reconnectNow);
  document.addEventListener("visibilitychange", onVisibility);

  void connect();
  return () => {
    disposed = true;
    clearTimeout(retryTimer);
    clearTimeout(watchdogTimer);
    clearTimeout(flushTimer);
    clearTimeout(noticeTimer);
    window.removeEventListener("online", reconnectNow);
    document.removeEventListener("visibilitychange", onVisibility);
    controller?.abort();
    controller = null;
    useNodeLive.getState().set({ status: "off" });
  };
}
