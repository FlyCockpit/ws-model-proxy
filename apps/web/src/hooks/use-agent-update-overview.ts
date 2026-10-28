import { useQuery } from "@tanstack/react-query";

import { overviewRefetchInterval } from "@/lib/agent-update";
import { orpc } from "@/utils/orpc";

/**
 * The owner's wsmp update overview (`nodes.agentUpdate.overview`): one shared query for the
 * nodes list, the "Update all" card and a node's page. It polls every few seconds while an
 * update or an "Update all" batch is in flight, and every 30 s otherwise (a node that reconnects
 * changes what Update may do); mutations invalidate `orpc.nodes.key()` to pick up the start.
 */
export function useAgentUpdateOverview() {
  return useQuery({
    ...orpc.nodes.agentUpdate.overview.queryOptions(),
    refetchInterval: (query) => overviewRefetchInterval(query.state.data),
  });
}
