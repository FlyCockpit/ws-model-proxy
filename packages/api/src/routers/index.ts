import type { RouterClient } from "@orpc/server";
import { getSignupAccessState } from "@ws-model-proxy/auth/signup-policy";
import { env } from "@ws-model-proxy/env/server";
import { adminProcedure, authenticatedProcedure, publicProcedure } from "../index";
import { providerCredentialKeyringConfigured } from "../lib/provider-credential-crypto";
import { adminObservabilityRouter } from "./admin-observability";
import { authRouter } from "./auth";
import { capacityManagementRouter } from "./capacity-management";
import { cliCredentialsRouter } from "./cli-credentials";
import { devicesRouter } from "./devices";
import { forwarderManagementRouter } from "./forwarder-management";
import { mcpGrantsRouter } from "./mcp-grants";
import { mcpTokensRouter } from "./mcp-tokens";
import { modelApiTokensRouter } from "./model-api-tokens";
import { overviewRouter } from "./overview";
import { providerManagementRouter } from "./provider-management";
import { relayMetadataRouter } from "./relay-metadata";
import { settingsRouter } from "./settings";
import { supervisedCommandsRouter } from "./supervised-commands";
import { usersRouter } from "./users";

async function deploymentFeatureSnapshot() {
  const signupAccess = await getSignupAccessState();
  const keyringConfigured = providerCredentialKeyringConfigured(
    env.WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS,
  );
  return {
    signupAccess,
    features: {
      WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: {
        enabled: env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED,
        keyringConfigured,
        ready: env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED && keyringConfigured,
      },
      WMP_MCP_ENABLED: env.WMP_MCP_ENABLED,
      WMP_MCP_PAT_ALLOW_NO_EXPIRY: env.WMP_MCP_PAT_ALLOW_NO_EXPIRY,
      WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS: env.WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS,
      SIGNUP_ENABLED: signupAccess.signupEnabled,
    },
  };
}

export const appRouter = {
  appConfig: publicProcedure.handler(async () => {
    const { signupAccess, features } = await deploymentFeatureSnapshot();
    return {
      ssoEnabled: false,
      forceSso: false,
      ssoProviderName: "SSO",
      signupEnabled: features.SIGNUP_ENABLED,
      adminBootstrapSignupEnabled: signupAccess.adminBootstrapSignupEnabled,
      // Gates the login challenge's "email me a code" affordance. The delivery
      // unreliability of Better-Auth's send-otp endpoint (it swallows SMTP
      // failures) is handled separately by the `auth.verifyEmailTransport`
      // preflight; this flag only reflects whether email is configured at all.
      emailEnabled: Boolean(env.SMTP_HOST),
    };
  }),
  /** Product gates for a signed-in user. No keyring status and no feature inventory. */
  deploymentFlags: authenticatedProcedure.handler(async () => {
    const { features } = await deploymentFeatureSnapshot();
    return {
      providerEgressEnabled: features.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED.enabled,
      privateNetworksAllowed: features.WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS,
    };
  }),
  /** Admin inventory, including whether the credential keyring is configured. */
  deploymentFeatures: adminProcedure.handler(async () => {
    const { features } = await deploymentFeatureSnapshot();
    return features;
  }),
  auth: authRouter,
  adminObservability: adminObservabilityRouter,
  settings: settingsRouter,
  devices: devicesRouter,
  forwarderManagement: forwarderManagementRouter,
  cliCredentials: cliCredentialsRouter,
  capacityManagement: capacityManagementRouter,
  modelApiTokens: modelApiTokensRouter,
  overview: overviewRouter,
  providerManagement: providerManagementRouter,
  relayMetadata: relayMetadataRouter,
  users: usersRouter,
  // Human-only: confirm/review agent-requested commands. Never MCP tools.
  supervisedCommands: supervisedCommandsRouter,
  // Human-only MCP grant management (Phase 7): never exposed as MCP tools —
  // see MCP_TOOL_EXCLUSIONS in apps/server/src/mcp/tool-manifest.ts.
  mcpGrants: mcpGrantsRouter,
  // Human-only MCP personal tokens: hashed Bearer credentials for headless
  // clients. Never exposed as MCP tools (same exclusion invariant as mcpGrants).
  mcpTokens: mcpTokensRouter,
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
