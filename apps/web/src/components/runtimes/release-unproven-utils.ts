import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";

type Rank = Awaited<
  ReturnType<AppRouterClient["runtimes"]["get"]>
>["instanceList"][number]["ranks"][number];

/**
 * Why the node cannot prove the stop right now, as the server records it on release: the node is
 * gone or offline, else the last automatic check's code (`status_running`, `port_in_use`, ...).
 */
export function stopUnprovenReason(rank: Rank): string {
  if (rank.nodeConnection === null) return "node_removed";
  if (rank.nodeConnection.state === "OFFLINE") return "node_offline";
  if (rank.lastStopCheck === null) return "no_check";
  return rank.lastStopCheck.errorCode ?? "not_stopped";
}
