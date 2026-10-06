/**
 * oRPC procedures (dotted router paths) that require the `x-csrf-token`
 * header even on a same-origin deployment, where the rest of `/rpc` relies on
 * CORS alone. Each one acts on the caller's session cookie and would
 * otherwise accept a headerless cross-origin POST (no preflight) from a
 * same-site sibling origin, whose request still carries the SameSite=Lax
 * cookie.
 *
 * - `cliCredentials.approveDeviceLogin`: binds a `wsmp login` code to the
 *   signed-in account. Better Auth's own `/device/approve`, which it replaces,
 *   refused cross-origin requests.
 * - Deployment mutations that save, approve, or authorize shell commands on
 *   the caller's nodes, and the grants that route prompts or commands to a
 *   machine (contribution acceptance, CLI feature grants, token identity
 *   reset). An attacker can learn some of their ids (it creates the offer it
 *   wants accepted), so an unguessable id is not a defense.
 */
export const ALWAYS_CSRF_PROTECTED_PROCEDURES: ReadonlySet<string> = new Set([
  "cliCredentials.approveDeviceLogin",
  "deployments.confirmPlan",
  "deployments.createConfig",
  "deployments.updateConfig",
  "deployments.setNodeGrant",
  "deployments.setAgentsMayPreempt",
  "deployments.deleteConfig",
  "inferenceContributions.accept",
  "cliCredentials.resetTokenIdentity",
  "forwarderManagement.setCliDeviceFeatureGrants",
]);
