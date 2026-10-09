import type { RouterClient } from "@orpc/server";
import { getSignupAccessState } from "@ws-model-proxy/auth/signup-policy";
import { env } from "@ws-model-proxy/env/server";
import { contractProcedure, publicContractProcedure } from "../contract-procedure";
import { appContract } from "../contracts/account";
import { providerCredentialKeyringConfigured } from "../lib/provider-credential-crypto";
// Registers share-invite acceptance with the Better Auth hooks (side effect).
import "../lib/share-invite-accept";
import { accessRouter } from "./access";
import { activityRouter } from "./activity";
import { adminObservabilityRouter } from "./admin-observability";
import { adminSettingsRouter } from "./admin-settings";
import { authRouter } from "./auth";
import { modelsRouter } from "./models";
import { nodesRouter } from "./nodes";
import { poolsRouter } from "./pools";
import { profilesRouter } from "./profiles";
import { providersRouter } from "./providers";
import { runtimesRouter } from "./runtimes";
import { settingsRouter } from "./settings";
import { usersRouter } from "./users";

function cloudEnabled(): boolean {
  return (
    env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED &&
    providerCredentialKeyringConfigured(env.WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS)
  );
}

const appRouterApp = {
  config: publicContractProcedure(appContract.config).handler(async () => {
    const signupAccess = await getSignupAccessState();
    return {
      signupEnabled: signupAccess.signupEnabled,
      adminBootstrapSignupEnabled: signupAccess.adminBootstrapSignupEnabled,
      // Gates the login challenge's "email me a code" affordance; delivery itself is checked
      // by `auth.verifyEmailTransport`.
      emailEnabled: Boolean(env.SMTP_HOST),
    };
  }),
  flags: contractProcedure(appContract.flags).handler(async () => ({
    cloudEnabled: cloudEnabled(),
    privateNetworksAllowed: env.WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS,
    mcpEnabled: env.WMP_MCP_ENABLED,
    agentTokenNoExpiryAllowed: env.WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY,
  })),
  features: contractProcedure(appContract.features).handler(async () => {
    const signupAccess = await getSignupAccessState();
    return {
      WMP_PUBLIC_PROVIDER_EGRESS_ENABLED: {
        enabled: env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED,
        keyringConfigured: providerCredentialKeyringConfigured(
          env.WMP_PROVIDER_CREDENTIAL_ENCRYPTION_KEYS,
        ),
        ready: cloudEnabled(),
      },
      WMP_MCP_ENABLED: env.WMP_MCP_ENABLED,
      WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY: env.WMP_AGENT_TOKEN_ALLOW_NO_EXPIRY,
      WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS: env.WMP_PROVIDER_ALLOW_PRIVATE_NETWORKS,
      SIGNUP_ENABLED: signupAccess.signupEnabled,
    };
  }),
};

/** The 0.4.0 router: one key per contract router (`contracts/index.ts`). */
export const appRouter = {
  app: appRouterApp,
  auth: authRouter,
  settings: settingsRouter,
  users: usersRouter,
  adminObservability: adminObservabilityRouter,
  adminSettings: adminSettingsRouter,
  nodes: nodesRouter,
  runtimes: runtimesRouter,
  profiles: profilesRouter,
  pools: poolsRouter,
  models: modelsRouter,
  access: accessRouter,
  providers: providersRouter,
  activity: activityRouter,
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
