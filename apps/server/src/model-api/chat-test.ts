import type { Session } from "@ws-model-proxy/auth";
import { Hono } from "hono";
import { relaySessionManager } from "../relay/session-manager.js";
import { type DiagnosticCoreDependencies, diagnosticsCapacityRuntime } from "./diagnostics.js";
import { modelApiConcurrencyLimiter } from "./limits.js";
import { openAiFailureJsonResponse } from "./openai-errors.js";
import {
  anthropicMessagesHandler,
  chatTestCompletionsHandler,
  responsesCreateHandler,
} from "./routes.js";

type ChatTestRouteDependencies = DiagnosticCoreDependencies;

type ChatTestVariables = {
  session: Session | null;
};

export function createChatTestRoutes({
  manager = relaySessionManager,
  concurrencyLimiter = modelApiConcurrencyLimiter,
  capacityRuntime,
}: ChatTestRouteDependencies = {}) {
  const app = new Hono<{ Variables: ChatTestVariables }>();
  // One module-lifetime diagnostics capacity runtime, shared with the MCP
  // chat completion test tool. An injected runtime still wins in tests.
  // Admission is always installed; there is no limiter-only fallback.
  const admissionRuntime = capacityRuntime ?? diagnosticsCapacityRuntime();

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
