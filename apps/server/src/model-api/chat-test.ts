import type { Session } from "@ws-model-proxy/auth";
import { isForceTwoFactorRequired } from "@ws-model-proxy/auth/force-two-factor-policy";
import { Hono } from "hono";
import { relaySessionManager } from "../relay/session-manager.js";
import { capacityRequestScopeMiddleware } from "./capacity/request-scope.js";
import { type DiagnosticCoreDependencies, diagnosticsCapacityRuntime } from "./diagnostics.js";
import { modelApiConcurrencyLimiter } from "./limits.js";
import { openAiErrorBody, openAiFailureJsonResponse } from "./openai-errors.js";
import {
  anthropicMessagesHandler,
  chatTestCompletionsHandler,
  responsesCreateHandler,
} from "./routes.js";

type ChatTestRouteDependencies = DiagnosticCoreDependencies & {
  /** Tests replace the force-2FA policy read. */
  twoFactorRequired?: () => Promise<boolean>;
};

type ChatTestVariables = {
  session: Session | null;
};

export function createChatTestRoutes({
  manager = relaySessionManager,
  concurrencyLimiter = modelApiConcurrencyLimiter,
  capacityRuntime,
  twoFactorRequired = isForceTwoFactorRequired,
}: ChatTestRouteDependencies = {}) {
  const app = new Hono<{ Variables: ChatTestVariables }>();
  // The dashboard's force-2FA rule (`protectedProcedure`, the terminal and
  // Chat Test realtime sockets): while the policy is on, a signed-in user who
  // has not enrolled cannot drive Chat Test with their cookie. No session
  // falls through to each route's own 401.
  app.use("*", async (c, next) => {
    const user = c.get("session")?.user;
    if (user && !user.twoFactorEnabled && (await twoFactorRequired())) {
      return c.json(
        openAiErrorBody({
          message: "Two-factor authentication setup is required.",
          type: "invalid_request_error",
          code: "two_factor_required",
        }),
        403,
      );
    }
    await next();
  });
  // One module-lifetime diagnostics capacity runtime, shared with the MCP
  // chat completion test tool. An injected runtime still wins in tests.
  // Admission is always installed; there is no limiter-only fallback.
  const admissionRuntime = capacityRuntime ?? diagnosticsCapacityRuntime();
  // F2-CAP-6: owners created by a Chat Test request end with its response.
  app.use("*", capacityRequestScopeMiddleware);

  app.post("/chat/completions", async (c) => {
    const session = c.get("session");
    if (!session?.user) {
      return openAiFailureJsonResponse("access_denied", "Authentication is required.");
    }

    return chatTestCompletionsHandler({
      request: c.req.raw,
      userId: session.user.id,
      manager,
      limiter: concurrencyLimiter,
      capacityRuntime: admissionRuntime,
    });
  });

  app.post("/responses", async (c) => {
    const session = c.get("session");
    if (!session?.user)
      return openAiFailureJsonResponse("access_denied", "Authentication is required.");
    return responsesCreateHandler({
      request: c.req.raw,
      chatTestUserId: session.user.id,
      manager,
      limiter: concurrencyLimiter,
      capacityRuntime: admissionRuntime,
    });
  });

  app.post("/messages", async (c) => {
    const session = c.get("session");
    if (!session?.user)
      return openAiFailureJsonResponse("access_denied", "Authentication is required.");
    return anthropicMessagesHandler({
      request: c.req.raw,
      chatTestUserId: session.user.id,
      countTokens: false,
      manager,
      limiter: concurrencyLimiter,
      capacityRuntime: admissionRuntime,
    });
  });

  app.all("/*", () => openAiFailureJsonResponse("not_found"));

  return app;
}
