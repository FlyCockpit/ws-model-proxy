import type { RouterClient } from "@orpc/server";
import { getSignupAccessState } from "@ws-model-proxy/auth/signup-policy";
import prisma from "@ws-model-proxy/db";
import { env } from "@ws-model-proxy/env/server";

import { protectedProcedure, publicProcedure } from "../index";
import { adminObservabilityRouter } from "./admin-observability";
import { authRouter } from "./auth";
import { cliCredentialsRouter } from "./cli-credentials";
import { devicesRouter } from "./devices";
import { forwarderManagementRouter } from "./forwarder-management";
import { modelApiTokensRouter } from "./model-api-tokens";
import { relayMetadataRouter } from "./relay-metadata";
import { seedRouter } from "./seed";
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
  seed: seedRouter,
  devices: devicesRouter,
  forwarderManagement: forwarderManagementRouter,
  cliCredentials: cliCredentialsRouter,
  modelApiTokens: modelApiTokensRouter,
  relayMetadata: relayMetadataRouter,
  users: usersRouter,
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
