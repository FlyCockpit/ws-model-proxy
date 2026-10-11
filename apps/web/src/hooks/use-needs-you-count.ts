import { useQuery } from "@tanstack/react-query";

import { orpc } from "@/utils/orpc";

/** How often the nav badge rechecks what needs the person (spec §7.4). */
export const NEEDS_YOU_REFRESH_MS = 30_000;

/**
 * How many things wait for the signed-in person: interactive steps, restarts, Mark as stopped
 * and commands agents queued for them. One shared query for every nav surface; 0 when signed out.
 */
export function useNeedsYouCount(signedIn: boolean): number {
  const query = useQuery({
    ...orpc.activity.needsYou.count.queryOptions(),
    enabled: signedIn,
    refetchInterval: NEEDS_YOU_REFRESH_MS,
  });
  return signedIn ? (query.data?.count ?? 0) : 0;
}
