import { useQuery } from "@tanstack/react-query";

import { overviewRefetchInterval } from "@/lib/agent-update";
import { useNodeLive } from "@/stores/node-live";
import { orpc } from "@/utils/orpc";

/**
 * The owner's wsmp update overview (`nodes.agentUpdate.overview`): one shared query for the
 * nodes list, the "Update all" card and a node's page. It polls every few seconds while an
 * update or an "Update all" batch is in flight; otherwise the node live updates refresh it, or a
 * 30 s poll while they are down (a node that reconnects changes what Update may do). Mutations
 * invalidate `orpc.nodes.key()` to pick up the start.
 */
export function useAgentUpdateOverview() {
  const live = useNodeLive((state) => state.status === "live");
  return useQuery({
    ...orpc.nodes.agentUpdate.overview.queryOptions(),
    refetchInterval: (query) => overviewRefetchInterval(query.state.data, live),
  });
}
