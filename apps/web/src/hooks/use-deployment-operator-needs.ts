import { useQuery } from "@tanstack/react-query";

import { useAuthSession } from "@/hooks/use-auth-session";
import { orpc } from "@/utils/orpc";

/** How often the dashboard asks which deployments wait for this user. */
export const DEPLOYMENT_OPERATOR_NEEDS_POLL_MS = 15_000;

/**
 * Deployments that wait for this user (`needsOperator`): a recipe step to run in an operator
 * terminal (STEP), or a stopped instance whose start is interactive (RESTART). Drives the
 * dashboard notice and the Deployments nav badge.
 */
export function useDeploymentOperatorNeeds() {
  const { state } = useAuthSession();
  const signedIn = Boolean(state.session);
  const query = useQuery({
    ...orpc.deployments.operatorNeeds.queryOptions(),
    enabled: signedIn,
    refetchInterval: signedIn ? DEPLOYMENT_OPERATOR_NEEDS_POLL_MS : false,
    refetchOnWindowFocus: true,
  });
  return {
    count: signedIn ? (query.data?.count ?? 0) : 0,
    items: signedIn ? (query.data?.items ?? []) : [],
  };
}
