import { create } from "zustand";

import type { NodeLiveStatus } from "@/lib/node-live-updates";

/**
 * The tab's node live updates stream (`useNodeLiveUpdates`, mounted once in the root): its
 * status, and whether it has been down long enough for pages to say so. Pages read it to pick
 * their poll interval; they never open a second stream. Not persisted.
 */
export const useNodeLive = create<{
  status: NodeLiveStatus;
  /** Down for at least `NODE_LIVE_NOTICE_MS`. */
  notice: boolean;
  set: (next: { status: NodeLiveStatus; notice?: boolean }) => void;
}>()((set) => ({
  status: "off",
  notice: false,
  set: (next) => set({ status: next.status, notice: next.notice ?? false }),
}));
