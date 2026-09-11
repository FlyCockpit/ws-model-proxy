import { describe, expect, it, vi } from "vitest";

import {
  collectMediaIds,
  estimateRequestBytes,
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
});
