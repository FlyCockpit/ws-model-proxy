import { isAdminRole } from "@ws-model-proxy/auth/roles";

import { useAuthSession } from "@/hooks/use-auth-session";

/** Admins see the env variable that opens a gated control. Everyone else does not. */
export function useDeploymentAudience(): { isAdmin: boolean } {
  const { state } = useAuthSession();
  const isAdmin = state.status === "authenticated" && isAdminRole(state.session.user.role);
  return { isAdmin };
}
