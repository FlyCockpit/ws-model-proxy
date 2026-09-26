import { useQuery } from "@tanstack/react-query";

import { useAuthSession } from "@/hooks/use-auth-session";
import { orpc } from "@/utils/orpc";

/** How often the dashboard asks for agent command requests waiting on this user. */
export const PENDING_AGENT_REQUESTS_POLL_MS = 15_000;

/**
 * Supervised commands an MCP agent asked for that wait on this user: a
 * confirm screen on the CLI, or output to review. The terminal socket only
 * exists once Terminals was opened, so the rest of the app polls this.
 */
export function usePendingAgentRequests() {
  const { state } = useAuthSession();
  const signedIn = Boolean(state.session);
  const query = useQuery({
    ...orpc.supervisedCommands.pending.queryOptions(),
    enabled: signedIn,
    refetchInterval: signedIn ? PENDING_AGENT_REQUESTS_POLL_MS : false,
    refetchOnWindowFocus: true,
  });
  const requests = signedIn ? (query.data?.requests ?? []) : [];
  return {
    requests,
    /** Requests that need the person: confirm on the CLI screen, or review output. */
    count: requests.filter(
      (request) =>
        request.status === "awaiting_user" || request.status === "awaiting_output_review",
    ).length,
  };
}
