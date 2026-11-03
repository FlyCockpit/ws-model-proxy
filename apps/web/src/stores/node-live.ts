import { create } from "zustand";

import {
  NODE_LIVE_OFF,
  type NodeLiveEventKind,
  type NodeLiveState,
  nodeLiveTransition,
} from "@/lib/node-live-updates";

/**
 * The tab's node live updates stream (`useNodeLiveUpdates`, mounted once in the root): its
 * status, and whether it has been down long enough for pages to say so (`notice`, only ever
 * true while `down`). Pages read it to pick their poll interval; they never open a second
 * stream. Only the stream changes it, through `dispatch` and the pure `nodeLiveTransition`.
 * Not persisted.
 */
export const useNodeLive = create<
  NodeLiveState & { dispatch: (event: NodeLiveEventKind) => void }
>()((set, get) => ({
  ...NODE_LIVE_OFF,
  dispatch: (event) => {
    const current = get();
    const next = nodeLiveTransition(current, event);
    if (next.status !== current.status || next.notice !== current.notice) set(next);
  },
}));
