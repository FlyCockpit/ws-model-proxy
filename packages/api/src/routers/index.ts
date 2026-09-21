import type { RouterClient } from "@orpc/server";
import { getSignupAccessState } from "@ws-model-proxy/auth/signup-policy";
import prisma from "@ws-model-proxy/db";
import { env } from "@ws-model-proxy/env/server";

import { protectedProcedure, publicProcedure } from "../index";
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
  health: {
    check: publicProcedure.handler(() => {
      return "OK";
    }),
    ready: publicProcedure.handler(async () => {
      await prisma.$queryRaw`SELECT 1`;
      return "OK";
    }),
  },
  appConfig: publicProcedure.handler(async () => {
    const signupAccess = await getSignupAccessState();
    return {
      ssoEnabled: false,
      forceSso: false,
      ssoProviderName: "SSO",
      signupEnabled: signupAccess.signupEnabled,
      adminBootstrapSignupEnabled: signupAccess.adminBootstrapSignupEnabled,
      capacityEnabled: env.MODEL_API_GLOBAL_CAPACITY_ENABLED,
      protocolAdaptationAvailable: env.MODEL_API_PROTOCOL_ADAPTATION_ENABLED,
      providerEgressEnabled: env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED,
      // Gates the login challenge's "email me a code" affordance. The delivery
      // unreliability of Better-Auth's send-otp endpoint (it swallows SMTP
      // failures) is handled separately by the `auth.verifyEmailTransport`
      // preflight; this flag only reflects whether email is configured at all.
      emailEnabled: Boolean(env.SMTP_HOST),
    };
  }),
  privateData: protectedProcedure.handler(({ context }) => {
    return {
      message: "This is private",
      user: context.session?.user,
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
