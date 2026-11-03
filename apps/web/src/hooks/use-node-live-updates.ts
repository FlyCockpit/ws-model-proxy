import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import {
  invalidateNodeLiveQueries,
  NODE_EVENTS_PATH,
  NODE_LIVE_COALESCE_MS,
  NODE_LIVE_NOTICE_MS,
  NODE_LIVE_STABLE_MS,
  NODE_LIVE_WATCHDOG_MS,
  type NodeLiveEventKind,
  parseNodeLiveEvent,
} from "@/lib/node-live-updates";
import { INITIAL_RECONNECT_BACKOFF, planReconnect } from "@/lib/reconnect-backoff";
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

  // The effect owns a long-lived stream's lifecycle (open, reconnect, abort on cleanup), not a
  // one-shot data load: the data stays in the TanStack queries this only invalidates.
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- a streaming subscription, not a fetch for data; see above
  useEffect(() => {
    if (!sessionKey || typeof window === "undefined" || typeof fetch !== "function") {
      useNodeLive.getState().dispatch("off");
      return undefined;
    }
    return openNodeEventStream(queryClient);
  }, [sessionKey, queryClient]);
}

/**
 * The stream's own lifecycle (what it is doing, as opposed to the status pages see):
 * - `idle`: not started yet.
 * - `streaming`: an attempt owns `controller`, from the fetch through the read loop. Its
 *   `watchdog` ends it after {@link NODE_LIVE_WATCHDOG_MS} of silence.
 * - `waiting`: the reconnect `timer` is armed.
 * - `stopped`: unauthorized; final until the session changes (a new stream).
 * - `disposed`: closed by the cleanup.
 */
type StreamPhase =
  | { kind: "idle" }
  | {
      kind: "streaming";
      controller: AbortController;
      watchdog: ReturnType<typeof setTimeout> | undefined;
    }
  | { kind: "waiting"; timer: ReturnType<typeof setTimeout> }
  | { kind: "stopped" }
  | { kind: "disposed" };

/** Opens the stream and keeps it open (reconnecting) until the returned function ends it. */
function openNodeEventStream(queryClient: QueryClient): () => void {
  let phase: StreamPhase = { kind: "idle" };
  let backoff = INITIAL_RECONNECT_BACKOFF;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;

  // Re-read through a function: `phase` changes across awaits, and TypeScript would otherwise
  // keep a narrowing from before one.
  const currentPhase = (): StreamPhase => phase;

  const refreshSoon = () => {
    if (flushTimer !== undefined) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      if (currentPhase().kind !== "disposed") void invalidateNodeLiveQueries(queryClient);
    }, NODE_LIVE_COALESCE_MS);
  };

  /** Reports to the store; arms the notice on entering `down`, clears it on leaving. */
  const report = (event: NodeLiveEventKind) => {
    const store = useNodeLive.getState();
    const wasDown = store.status === "down";
    store.dispatch(event);
    const isDown = useNodeLive.getState().status === "down";
    if (isDown && !wasDown) {
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(() => {
        noticeTimer = undefined;
        useNodeLive.getState().dispatch("noticeDue");
      }, NODE_LIVE_NOTICE_MS);
    } else if (!isDown) {
      clearTimeout(noticeTimer);
      noticeTimer = undefined;
    }
  };

  const stop = () => {
    const current = currentPhase();
    if (current.kind === "streaming") clearTimeout(current.watchdog);
    phase = { kind: "stopped" };
    report("unauthorized");
  };

  const armWatchdog = (streaming: Extract<StreamPhase, { kind: "streaming" }>) => {
    clearTimeout(streaming.watchdog);
    streaming.watchdog = setTimeout(() => streaming.controller.abort(), NODE_LIVE_WATCHDOG_MS);
  };

  /** Starts an attempt, from `idle` or `waiting` only (one stream at a time). */
  const connect = async () => {
    const before = currentPhase();
    if (before.kind === "waiting") clearTimeout(before.timer);
    else if (before.kind !== "idle") return;
    const streaming: Extract<StreamPhase, { kind: "streaming" }> = {
      kind: "streaming",
      controller: new AbortController(),
      watchdog: undefined,
    };
    phase = streaming;
    const owns = () => currentPhase() === streaming;
    report("connecting");
    let openedAt: number | null = null;
    // Also bounds a response whose headers never arrive (a buffering proxy).
    armWatchdog(streaming);
    try {
      const response = await fetch(NODE_EVENTS_PATH, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "text/event-stream" },
        signal: streaming.controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined);
        if (owns()) stop();
        return;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      if (!owns()) return;
      openedAt = performance.now();
      report("opened");
      refreshSoon();
      armWatchdog(streaming);
      const parser = createSseParser((event) => {
        if (!owns()) return;
        if (event.event === "unauthorized") {
          stop();
          streaming.controller.abort();
        } else if (event.event === "node" && parseNodeLiveEvent(event.data)) {
          refreshSoon();
        }
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (owns()) armWatchdog(streaming);
        parser.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // A network error, the watchdog or the cleanup (an abort): the finally decides.
    } finally {
      clearTimeout(streaming.watchdog);
      // Only an attempt that still owns the stream schedules the next: after a stop or the
      // cleanup the phase has moved on.
      if (owns()) {
        report("failed");
        const plan = planReconnect(
          backoff,
          openedAt === null ? null : performance.now() - openedAt,
          NODE_LIVE_STABLE_MS,
        );
        backoff = plan.backoff;
        phase = { kind: "waiting", timer: setTimeout(() => void connect(), plan.delayMs) };
      }
    }
  };

  // Back online, or back to the tab: no need to wait out the backoff.
  const reconnectNow = () => {
    if (currentPhase().kind !== "waiting") return;
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
    const last = currentPhase();
    phase = { kind: "disposed" };
    if (last.kind === "waiting") clearTimeout(last.timer);
    if (last.kind === "streaming") {
      clearTimeout(last.watchdog);
      last.controller.abort();
    }
    clearTimeout(flushTimer);
    clearTimeout(noticeTimer);
    window.removeEventListener("online", reconnectNow);
    document.removeEventListener("visibilitychange", onVisibility);
    useNodeLive.getState().dispatch("off");
  };
}
