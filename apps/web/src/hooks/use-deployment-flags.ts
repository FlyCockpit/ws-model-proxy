import { useQuery } from "@tanstack/react-query";

import { privateNetworksAllowedFromConfig } from "@/lib/deployment-feature-gate";
import { providerEgressFromAppConfig } from "@/lib/guarded-pool-wizard-validation";
import { orpc } from "@/utils/orpc";

/** Signed-in product gates. A failed refetch closes both gates. */
export function useDeploymentFlags(options?: { refetchOnMount?: boolean | "always" }) {
  const query = useQuery({
    ...orpc.deploymentFlags.queryOptions(),
    refetchOnMount: options?.refetchOnMount,
  });
  return {
    query,
    providerEgressEnabled: providerEgressFromAppConfig(query.data) && !query.isError,
    privateNetworksAllowed: privateNetworksAllowedFromConfig(query.data, query.isError),
  };
}
