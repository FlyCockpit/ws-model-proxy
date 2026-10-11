import type { Session } from "@ws-model-proxy/auth";
import { isForceTwoFactorRequired } from "@ws-model-proxy/auth/force-two-factor-policy";
import prisma from "@ws-model-proxy/db";
import { Hono } from "hono";
import { relaySessionManager } from "../relay/session-manager.js";
import { capacityRequestScopeMiddleware } from "./capacity/request-scope.js";
import { type DiagnosticCoreDependencies, diagnosticsCapacityRuntime } from "./diagnostics.js";
import { modelApiConcurrencyLimiter } from "./limits.js";
import { openAiErrorBody, openAiFailureJsonResponse } from "./openai-errors.js";
import { observeRelayRequests } from "./relay-request-observer.js";
import {
  anthropicMessagesHandler,
  chatTestCompletionsHandler,
  modelTestHandler,
  responsesCreateHandler,
} from "./routes.js";

type ChatTestRouteDependencies = DiagnosticCoreDependencies & {
  /** Tests replace the force-2FA policy read. */
  twoFactorRequired?: () => Promise<boolean>;
  /** Tests replace the read of a failed Test request's upstream error excerpt. */
  readUpstreamExcerpt?: (userId: string, relayRequestId: string) => Promise<string | null>;
};

/** Largest error body the excerpt is added to (errors are small JSON objects). */
const ERROR_BODY_MAX_BYTES = 64 * 1024;
/** The request row is finalized after the answer returns; wait this long for it (as model-test). */
const ROW_SETTLE_WAIT_MS = 3_000;
const ROW_SETTLE_POLL_MS = 100;

/**
 * The runtime's own error excerpt of the person's request `relayRequestId`, once the row is
 * final. As on Activity, the excerpt stays with requests to the person's own hardware (or no
 * resource): on someone else's pool, what their runtime said is the owner's business.
 */
async function settledUpstreamExcerpt(
  userId: string,
  relayRequestId: string,
): Promise<string | null> {
  const read = () =>
    prisma.relayRequest.findFirst({
      where: { id: relayRequestId, userId },
      select: { status: true, upstreamErrorExcerpt: true, resourceOwnerUserId: true },
    });
  const deadline = Date.now() + ROW_SETTLE_WAIT_MS;
  let row = await read();
  while (row?.status === "PENDING" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, ROW_SETTLE_POLL_MS));
    row = await read();
  }
  if (!row) return null;
  const own = row.resourceOwnerUserId === null || row.resourceOwnerUserId === userId;
  return own ? row.upstreamErrorExcerpt : null;
}

/** The body text, or null when it is longer than `max` bytes. */
async function cappedText(response: Response, max: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
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
  const text = await cappedText(response.clone(), ERROR_BODY_MAX_BYTES).catch(() => null);
  if (text === null) return response;
  let body: unknown;
  try {
    body = JSON.parse(text);
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

export function createChatTestRoutes({
  manager = relaySessionManager,
  concurrencyLimiter = modelApiConcurrencyLimiter,
  capacityRuntime,
  twoFactorRequired = isForceTwoFactorRequired,
  readUpstreamExcerpt = settledUpstreamExcerpt,
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
  /** Sends one Test request, learning its own request row so a failure can quote the runtime. */
  const answer = async (userId: string, send: () => Promise<Response>) => {
    let relayRequestId: string | null = null;
    const response = await observeRelayRequests((id) => {
      relayRequestId ??= id;
    }, send);
    const id: string | null = relayRequestId;
    return id === null
      ? response
      : withUpstreamExcerpt(response, () => readUpstreamExcerpt(userId, id));
  };
  // F2-CAP-6: owners created by a Chat Test request end with its response.
  app.use("*", capacityRequestScopeMiddleware);

  app.post("/chat/completions", async (c) => {
    const session = c.get("session");
    if (!session?.user) {
      return openAiFailureJsonResponse("access_denied", "Authentication is required.");
    }

    const userId = session.user.id;
    return answer(userId, () =>
      chatTestCompletionsHandler({
        request: c.req.raw,
        userId,
        manager,
        limiter: concurrencyLimiter,
        capacityRuntime: admissionRuntime,
      }),
    );
  });

  app.post("/responses", async (c) => {
    const session = c.get("session");
    if (!session?.user)
      return openAiFailureJsonResponse("access_denied", "Authentication is required.");
    const userId = session.user.id;
    return answer(userId, () =>
      responsesCreateHandler({
        request: c.req.raw,
        chatTestUserId: userId,
        manager,
        limiter: concurrencyLimiter,
        capacityRuntime: admissionRuntime,
      }),
    );
  });

  app.post("/messages", async (c) => {
    const session = c.get("session");
    if (!session?.user)
      return openAiFailureJsonResponse("access_denied", "Authentication is required.");
    const userId = session.user.id;
    return answer(userId, () =>
      anthropicMessagesHandler({
        request: c.req.raw,
        chatTestUserId: userId,
        countTokens: false,
        manager,
        limiter: concurrencyLimiter,
        capacityRuntime: admissionRuntime,
      }),
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
      return answer(userId, () =>
        modelTestHandler({
          request: c.req.raw,
          userId,
          kind,
          source: "TEST",
          manager,
          limiter: concurrencyLimiter,
          capacityRuntime: admissionRuntime,
        }),
      );
    });
  }

  app.all("/*", () => openAiFailureJsonResponse("not_found"));

  return app;
}
