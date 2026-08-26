import type { Session } from "@ws-model-proxy/auth";
import { env } from "@ws-model-proxy/env/server";
import { Hono } from "hono";
import { type RelaySessionManager, relaySessionManager } from "../relay/session-manager.js";
import { PostgresCapacityAdmissionStore } from "./capacity/postgres-store.js";
import {
  type CapacityAdmissionRuntime,
  StoreCapacityAdmissionRuntime,
} from "./capacity/runtime.js";
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
  capacityEnabled?: boolean;
  capacityRuntime?: CapacityAdmissionRuntime;
};

type ChatTestVariables = {
  session: Session | null;
};

export function createChatTestRoutes({
  manager = relaySessionManager,
  concurrencyLimiter = modelApiConcurrencyLimiter,
  capacityEnabled = env.MODEL_API_GLOBAL_CAPACITY_ENABLED,
  capacityRuntime,
}: ChatTestRouteDependencies = {}) {
  const app = new Hono<{ Variables: ChatTestVariables }>();
  const admissionRuntime = capacityEnabled
    ? (capacityRuntime ?? new StoreCapacityAdmissionRuntime(new PostgresCapacityAdmissionStore()))
    : undefined;

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
      adaptationFeatureEnabled: true,
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
      adaptationFeatureEnabled: true,
      capacityRuntime: admissionRuntime,
    });
  });

  app.all("/*", () => openAiFailureJsonResponse("not_found"));

  return app;
}
