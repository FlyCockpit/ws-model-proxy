import type { RouterClient } from "@orpc/server";
import { getSignupAccessState } from "@ws-model-proxy/auth/signup-policy";
import { env } from "@ws-model-proxy/env/server";
import { publicProcedure } from "../index";
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
import { providerManagementRouter } from "./provider-management";
import { relayMetadataRouter } from "./relay-metadata";
import { settingsRouter } from "./settings";
import { usersRouter } from "./users";

export const appRouter = {
  appConfig: publicProcedure.handler(async () => {
    const signupAccess = await getSignupAccessState();
    const keyringConfigured = providerCredentialKeyringConfigured(
      env.WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS,
    );
    const deploymentFeatures = {
      MODEL_API_ANTHROPIC_ENABLED: env.MODEL_API_ANTHROPIC_ENABLED,
      MODEL_API_PROTOCOL_ADAPTATION_ENABLED: env.MODEL_API_PROTOCOL_ADAPTATION_ENABLED,
      MODEL_API_GLOBAL_CAPACITY_ENABLED: env.MODEL_API_GLOBAL_CAPACITY_ENABLED,
      WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: {
        enabled: env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED,
        keyringConfigured,
        ready: env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED && keyringConfigured,
      },
      WMP_MCP_ENABLED: env.WMP_MCP_ENABLED,
      WMP_MCP_PAT_ALLOW_NO_EXPIRY: env.WMP_MCP_PAT_ALLOW_NO_EXPIRY,
      WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS: env.WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS,
      SIGNUP_ENABLED: signupAccess.signupEnabled,
    };
    return {
      deploymentFeatures,
      ssoEnabled: false,
      forceSso: false,
      ssoProviderName: "SSO",
      signupEnabled: deploymentFeatures.SIGNUP_ENABLED,
      adminBootstrapSignupEnabled: signupAccess.adminBootstrapSignupEnabled,
      capacityEnabled: deploymentFeatures.MODEL_API_GLOBAL_CAPACITY_ENABLED,
      protocolAdaptationAvailable: deploymentFeatures.MODEL_API_PROTOCOL_ADAPTATION_ENABLED,
      providerEgressEnabled: deploymentFeatures.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED.enabled,
      // Gates the login challenge's "email me a code" affordance. The delivery
      // unreliability of Better-Auth's send-otp endpoint (it swallows SMTP
      // failures) is handled separately by the `auth.verifyEmailTransport`
      // preflight; this flag only reflects whether email is configured at all.
      emailEnabled: Boolean(env.SMTP_HOST),
    };
  }),
  auth: authRouter,
  adminObservability: adminObservabilityRouter,
  settings: settingsRouter,
  devices: devicesRouter,
  forwarderManagement: forwarderManagementRouter,
  cliCredentials: cliCredentialsRouter,
  capacityManagement: capacityManagementRouter,
  modelApiTokens: modelApiTokensRouter,
  providerManagement: providerManagementRouter,
  relayMetadata: relayMetadataRouter,
  users: usersRouter,
  // Human-only MCP grant management (Phase 7): never exposed as MCP tools —
  // see MCP_TOOL_EXCLUSIONS in apps/server/src/mcp/tool-manifest.ts.
  mcpGrants: mcpGrantsRouter,
  // Human-only MCP personal tokens: hashed Bearer credentials for headless
  // clients. Never exposed as MCP tools (same exclusion invariant as mcpGrants).
  mcpTokens: mcpTokensRouter,
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
