import type { Session } from "@ws-model-proxy/auth";
import { Hono } from "hono";
import { type RelaySessionManager, relaySessionManager } from "../relay/session-manager.js";
import { type ModelApiConcurrencyLimiter, modelApiConcurrencyLimiter } from "./limits.js";
import { openAiFailureJsonResponse } from "./openai-errors.js";
import {
  anthropicMessagesHandler,
  chatTestCompletionsHandler,
  responsesCreateHandler,
} from "./routes.js";

type ChatTestRouteDependencies = {
  manager?: Pick<
    RelaySessionManager,
    | "getActiveCliDeviceIds"
    | "registerRelayResponseHandlers"
    | "sendRelayRequest"
    | "cancelRelayRequest"
    | "completeRelayRequest"
  >;
  concurrencyLimiter?: ModelApiConcurrencyLimiter;
};

type ChatTestVariables = {
  session: Session | null;
};

export function createChatTestRoutes({
  manager = relaySessionManager,
  concurrencyLimiter = modelApiConcurrencyLimiter,
}: ChatTestRouteDependencies = {}) {
  const app = new Hono<{ Variables: ChatTestVariables }>();

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
      adaptationFeatureEnabled: true,
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
      adaptationFeatureEnabled: true,
    });
  });

  app.all("/*", () => openAiFailureJsonResponse("not_found"));

  return app;
}
