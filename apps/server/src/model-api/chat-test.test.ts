import type { Session } from "@ws-model-proxy/auth";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ws-model-proxy/db", () => ({ default: {} }));
vi.mock("@ws-model-proxy/auth/force-two-factor-policy", () => ({
  isForceTwoFactorRequired: vi.fn(async () => false),
}));
vi.mock("../relay/session-manager.js", () => ({ relaySessionManager: {} }));
vi.mock("./limits.js", () => ({ modelApiConcurrencyLimiter: {} }));
vi.mock("./diagnostics.js", () => ({ diagnosticsCapacityRuntime: vi.fn(() => ({})) }));
vi.mock("./capacity/request-scope.js", () => ({
  capacityRequestScopeMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock("./routes.js", () => ({
  anthropicMessagesHandler: vi.fn(),
  chatTestCompletionsHandler: vi.fn(),
  modelTestHandler: vi.fn(),
  responsesCreateHandler: vi.fn(),
}));

import { createChatTestRoutes } from "./chat-test.js";
import { reportRelayRequestCreated } from "./relay-request-observer.js";
import { chatTestCompletionsHandler, modelTestHandler } from "./routes.js";

const session = { user: { id: "me", twoFactorEnabled: true } } as unknown as Session;

function app(
  readUpstreamExcerpt = vi.fn(async (_userId: string, _id: string) => null as string | null),
) {
  const root = new Hono<{ Variables: { session: Session | null } }>();
  root.use("*", async (c, next) => {
    c.set("session", c.req.header("x-test-anonymous") ? null : session);
    await next();
  });
  root.route(
    "/chat-test",
    createChatTestRoutes({
      twoFactorRequired: async () => false,
      readUpstreamExcerpt,
    }),
  );
  return { root, readUpstreamExcerpt };
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

beforeEach(() => {
  vi.mocked(chatTestCompletionsHandler).mockReset();
  vi.mocked(modelTestHandler).mockReset();
});

describe("Test page routes", () => {
  it("sends embeddings and file transcription as the person's Test traffic", async () => {
    vi.mocked(modelTestHandler).mockResolvedValue(json({ data: [] }, 200));
    const { root } = app();
    for (const [path, kind] of [
      ["/chat-test/embeddings", "embeddings"],
      ["/chat-test/audio/transcriptions", "transcription"],
    ] as const) {
      const response = await root.request(path, { method: "POST", body: "{}" });
      expect(response.status).toBe(200);
      expect(modelTestHandler).toHaveBeenLastCalledWith(
        expect.objectContaining({ userId: "me", kind, source: "TEST" }),
      );
    }
  });

  it("refuses a request without a session before sending anything", async () => {
    const { root } = app();
    const response = await root.request("/chat-test/embeddings", {
      method: "POST",
      headers: { "x-test-anonymous": "1" },
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect(modelTestHandler).not.toHaveBeenCalled();
  });

  it("quotes the runtime's own error of this request in a failed answer", async () => {
    vi.mocked(chatTestCompletionsHandler).mockImplementation(async () => {
      reportRelayRequestCreated("rr1");
      // A later row (a sidecar hop) is not the request.
      reportRelayRequestCreated("rr2");
      return json({ error: { message: "The model failed.", code: "upstream_error" } }, 502);
    });
    const { root, readUpstreamExcerpt } = app(
      vi.fn(async (_userId: string, _id: string) => "max_tokens is too large"),
    );
    const response = await root.request("/chat-test/chat/completions", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: {
        message: "The model failed.",
        code: "upstream_error",
        upstream_error: "max_tokens is too large",
      },
    });
    expect(readUpstreamExcerpt).toHaveBeenCalledWith("me", "rr1");
  });

  it("leaves successful answers and answers without an excerpt unchanged", async () => {
    const { root, readUpstreamExcerpt } = app();
    vi.mocked(chatTestCompletionsHandler).mockImplementationOnce(async () => {
      reportRelayRequestCreated("rr1");
      return json({ ok: true }, 200);
    });
    expect(
      await (await root.request("/chat-test/chat/completions", { method: "POST" })).json(),
    ).toEqual({ ok: true });
    expect(readUpstreamExcerpt).not.toHaveBeenCalled();

    vi.mocked(chatTestCompletionsHandler).mockImplementationOnce(async () => {
      reportRelayRequestCreated("rr2");
      return json({ error: { message: "Busy." } }, 429);
    });
    expect(
      await (await root.request("/chat-test/chat/completions", { method: "POST" })).json(),
    ).toEqual({ error: { message: "Busy." } });
    expect(readUpstreamExcerpt).toHaveBeenCalledTimes(1);

    // Refused before any request row: nothing to read.
    vi.mocked(chatTestCompletionsHandler).mockResolvedValueOnce(
      json({ error: { message: "Bad JSON." } }, 400),
    );
    await root.request("/chat-test/chat/completions", { method: "POST" });
    expect(readUpstreamExcerpt).toHaveBeenCalledTimes(1);
  });
});
