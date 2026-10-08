import type { Session } from "@ws-model-proxy/auth";
import { isForceTwoFactorRequired } from "@ws-model-proxy/auth/force-two-factor-policy";
import prisma from "@ws-model-proxy/db";
import { Hono } from "hono";
import { relaySessionManager } from "../relay/session-manager.js";
import { capacityRequestScopeMiddleware } from "./capacity/request-scope.js";
import { type DiagnosticCoreDependencies, diagnosticsCapacityRuntime } from "./diagnostics.js";
import { modelApiConcurrencyLimiter } from "./limits.js";
import { openAiErrorBody, openAiFailureJsonResponse } from "./openai-errors.js";
import {
  anthropicMessagesHandler,
  chatTestCompletionsHandler,
  modelTestHandler,
  responsesCreateHandler,
} from "./routes.js";

type ChatTestRouteDependencies = DiagnosticCoreDependencies & {
  /** Tests replace the force-2FA policy read. */
  twoFactorRequired?: () => Promise<boolean>;
  /** Tests replace the read of the latest failed Test request's upstream error excerpt. */
  readUpstreamExcerpt?: (userId: string, since: Date) => Promise<string | null>;
};

/** Database and server clocks may differ a little; the window still starts before the request. */
const EXCERPT_CLOCK_SKEW_MS = 1_000;
/** Largest error body the excerpt is added to (errors are small JSON objects). */
const ERROR_BODY_MAX_BYTES = 64 * 1024;

/**
 * The newest upstream error excerpt of the person's own Test requests since `since`. The Test
 * page sends one request at a time, so this is the failure being answered.
 */
async function latestUpstreamExcerpt(userId: string, since: Date): Promise<string | null> {
  const row = await prisma.relayRequest.findFirst({
    where: {
      userId,
      source: "TEST",
      createdAt: { gte: since },
      upstreamErrorExcerpt: { not: null },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { upstreamErrorExcerpt: true },
  });
  return row?.upstreamErrorExcerpt ?? null;
}

/**
 * Adds the runtime's own error (the redacted excerpt the request log keeps) to a failed JSON
 * answer as `error.upstream_error`, so the Test page can quote it. Anything else, or a failed
 * read, returns the answer unchanged.
 */
async function withUpstreamExcerpt(
  response: Response,
  read: () => Promise<string | null>,
): Promise<Response> {
  if (response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    return response;
  }
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > ERROR_BODY_MAX_BYTES) return response;
  let body: unknown;
  try {
    body = JSON.parse(await response.clone().text());
  } catch {
    return response;
  }
  const error =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).error
      : undefined;
  if (!error || typeof error !== "object" || Array.isArray(error)) return response;
  const excerpt = await read().catch(() => null);
  if (!excerpt) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(
    JSON.stringify({ ...(body as object), error: { ...error, upstream_error: excerpt } }),
    { status: response.status, statusText: response.statusText, headers },
  );
}

type ChatTestVariables = {
  session: Session | null;
};

function excerptWindowStart(): Date {
  return new Date(Date.now() - EXCERPT_CLOCK_SKEW_MS);
}

export function createChatTestRoutes({
  manager = relaySessionManager,
  concurrencyLimiter = modelApiConcurrencyLimiter,
  capacityRuntime,
  twoFactorRequired = isForceTwoFactorRequired,
  readUpstreamExcerpt = latestUpstreamExcerpt,
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

    const userId = session.user.id;
    const since = excerptWindowStart();
    return withUpstreamExcerpt(
      await chatTestCompletionsHandler({
        request: c.req.raw,
        userId,
        manager,
        limiter: concurrencyLimiter,
        capacityRuntime: admissionRuntime,
      }),
      () => readUpstreamExcerpt(userId, since),
    );
  });

  app.post("/responses", async (c) => {
    const session = c.get("session");
    if (!session?.user)
      return openAiFailureJsonResponse("access_denied", "Authentication is required.");
    const userId = session.user.id;
    const since = excerptWindowStart();
    return withUpstreamExcerpt(
      await responsesCreateHandler({
        request: c.req.raw,
        chatTestUserId: userId,
        manager,
        limiter: concurrencyLimiter,
        capacityRuntime: admissionRuntime,
      }),
      () => readUpstreamExcerpt(userId, since),
    );
  });

  app.post("/messages", async (c) => {
    const session = c.get("session");
    if (!session?.user)
      return openAiFailureJsonResponse("access_denied", "Authentication is required.");
    const userId = session.user.id;
    const since = excerptWindowStart();
    return withUpstreamExcerpt(
      await anthropicMessagesHandler({
        request: c.req.raw,
        chatTestUserId: userId,
        countTokens: false,
        manager,
        limiter: concurrencyLimiter,
        capacityRuntime: admissionRuntime,
      }),
      () => readUpstreamExcerpt(userId, since),
    );
  });

  // The Test page's embeddings and file transcription: the same targets, admission and
  // routing as an agent's model test, as the person's own Test traffic (source TEST).
  for (const [path, kind] of [
    ["/embeddings", "embeddings"],
    ["/audio/transcriptions", "transcription"],
  ] as const) {
    app.post(path, async (c) => {
      const session = c.get("session");
      if (!session?.user)
        return openAiFailureJsonResponse("access_denied", "Authentication is required.");
      const userId = session.user.id;
      const since = excerptWindowStart();
      return withUpstreamExcerpt(
        await modelTestHandler({
          request: c.req.raw,
          userId,
          kind,
          source: "TEST",
          manager,
          limiter: concurrencyLimiter,
          capacityRuntime: admissionRuntime,
        }),
        () => readUpstreamExcerpt(userId, since),
      );
    });
  }

  app.all("/*", () => openAiFailureJsonResponse("not_found"));

  return app;
}
