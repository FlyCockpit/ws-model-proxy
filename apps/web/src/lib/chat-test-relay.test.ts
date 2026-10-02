import { describe, expect, it, vi } from "vitest";

import {
  collectMediaIds,
  estimateRequestBytes,
  readChatRouteInfo,
  relayMessages,
  streamChatCompletion,
  withSystemPrompt,
} from "./chat-test-relay";

describe("Chat Test relay wire helpers", () => {
  it("keeps only replayable turns and sends media as content parts", () => {
    const messages = [
      {
        id: "user-1",
        role: "user" as const,
        content: "describe this",
        status: "ready" as const,
        attachments: [
          {
            id: "media-1",
            name: "image.png",
            modality: "image" as const,
            sizeBytes: 10,
            kind: "media" as const,
            mediaId: "media-1",
            previewUrl: "blob:preview",
          },
        ],
      },
      { id: "assistant-1", role: "assistant" as const, content: "", status: "streaming" as const },
    ];
    expect(relayMessages(messages, "user-1", (id) => `https://signed/${id}`)).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image_url", image_url: { url: "https://signed/media-1" } },
        ],
      },
    ]);
    expect(collectMediaIds(messages, "user-1")).toEqual(["media-1"]);
  });

  it("adds a system prompt only when present and produces a positive request estimate", () => {
    const relayed = withSystemPrompt([{ role: "user", content: "hello" }], "be concise");
    expect(relayed[0]).toEqual({ role: "system", content: "be concise" });
    expect(estimateRequestBytes("demo", relayed)).toBeGreaterThan(0);
  });

  it("keeps an explicit Anthropic cap when reasoning also supplies max_tokens", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await streamChatCompletion({
      model: "claude-test",
      messages: [{ role: "user", content: "hello" }],
      routingMode: "PREFER_NATIVE",
      surface: "ANTHROPIC_MESSAGES",
      reasoning: { thinking: { type: "enabled", budget_tokens: 1024 }, max_tokens: 2048 },
      anthropicMaxTokens: 4096,
      signal: new AbortController().signal,
      fallbackErrorMessage: "failed",
      onDelta: () => undefined,
      onThinkingDelta: () => undefined,
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(request.body as string)).toMatchObject({ max_tokens: 4096 });
    vi.unstubAllGlobals();
  });

  it("reads the route headers for each served route", () => {
    expect(readChatRouteInfo(new Headers())).toBeUndefined();
    expect(readChatRouteInfo(new Headers({ "x-wsmp-route": "local" }))).toEqual({
      route: "local",
      servedModel: null,
      fallbackReason: null,
      externalUnavailable: false,
    });
    expect(
      readChatRouteInfo(
        new Headers({
          "x-wsmp-route": "pool-fallback",
          "x-wsmp-fallback-reason": "local_wait_expired",
          "x-wsmp-served-model": "openai/gpt-4o-mini",
        }),
      ),
    ).toEqual({
      route: "pool-fallback",
      servedModel: "openai/gpt-4o-mini",
      fallbackReason: "local_wait_expired",
      externalUnavailable: false,
    });
    expect(
      readChatRouteInfo(
        new Headers({ "x-wsmp-route": "own-key", "x-wsmp-served-model": "anthropic/claude" }),
      ),
    ).toMatchObject({ route: "own-key", servedModel: "anthropic/claude", fallbackReason: null });
  });

  it("reports external unavailable with or without a local route and ignores unknown routes", () => {
    expect(readChatRouteInfo(new Headers({ "x-wsmp-fallback": "unavailable" }))).toEqual({
      route: null,
      servedModel: null,
      fallbackReason: null,
      externalUnavailable: true,
    });
    expect(
      readChatRouteInfo(new Headers({ "x-wsmp-route": "local", "x-wsmp-fallback": "unavailable" })),
    ).toMatchObject({ route: "local", externalUnavailable: true });
    expect(readChatRouteInfo(new Headers({ "x-wsmp-route": "somewhere" }))).toBeUndefined();
  });

  it("reports the route of an error response before throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "no external route" } }), {
          status: 503,
          headers: { "content-type": "application/json", "x-wsmp-fallback": "unavailable" },
        }),
      ),
    );
    const onRoute = vi.fn();
    await expect(
      streamChatCompletion({
        model: "owner/pool:external",
        messages: [{ role: "user", content: "hello" }],
        routingMode: "PREFER_NATIVE",
        surface: "OPENAI_CHAT_COMPLETIONS",
        reasoning: {},
        anthropicMaxTokens: 1024,
        signal: new AbortController().signal,
        fallbackErrorMessage: "failed",
        onDelta: () => undefined,
        onThinkingDelta: () => undefined,
        onRoute,
      }),
    ).rejects.toThrow("HTTP 503: no external route");
    expect(onRoute).toHaveBeenCalledWith(expect.objectContaining({ externalUnavailable: true }));
    vi.unstubAllGlobals();
  });

  it("computes tok/s from thinking time and shared thinking-inclusive tokens", async () => {
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"delta":{"reasoning_content":"plan"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: {"wsmp_metrics":{"completion_tokens":12,"tokenizer":"cl100k_base"}}\n\n',
    ];
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === 0) now = 1_250;
        if (index >= chunks.length) {
          now = 2_250;
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunks[index]));
        index += 1;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
        ),
    );
    const onThinkingDelta = vi.fn();
    const onDelta = vi.fn();
    const metrics = await streamChatCompletion({
      model: "demo",
      messages: [{ role: "user", content: "hello" }],
      routingMode: "PREFER_NATIVE",
      surface: "OPENAI_CHAT_COMPLETIONS",
      reasoning: {},
      anthropicMaxTokens: 1024,
      signal: new AbortController().signal,
      fallbackErrorMessage: "failed",
      onDelta,
      onThinkingDelta,
    });
    expect(onThinkingDelta).toHaveBeenCalledWith("plan");
    expect(onDelta).toHaveBeenCalledWith("ok");
    expect(metrics).toEqual({
      ttftMs: 250,
      completionTokens: 12,
      tokensPerSecond: 12,
    });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});
