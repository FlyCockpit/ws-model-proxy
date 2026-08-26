import { describe, expect, it } from "vitest";
import {
  adaptNonstreamResponse,
  createProtocolAdaptationTransform,
  parseCanonicalRequest,
  renderCanonicalRequest,
} from "./adaptation.js";

describe("protocol adaptation orchestration", () => {
  it("parses once and renders the requested model without mutating canonical state", () => {
    const canonical = parseCanonicalRequest("openai-chat", {
      model: "pool",
      messages: [{ role: "user", content: "hello" }],
    });
    const before = structuredClone(canonical);
    expect(
      renderCanonicalRequest({ request: canonical, target: "openai-responses", model: "up" }),
    ).toMatchObject({ model: "up", input: [{ role: "user" }] });
    expect(canonical).toEqual(before);
  });

  it("renders nonstream responses into the requested envelope", () => {
    const result = adaptNonstreamResponse({
      source: "openai-chat",
      target: "openai-responses",
      status: 200,
      body: {
        id: "c",
        object: "chat.completion",
        created: 0,
        model: "gpt",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hello" },
            finish_reason: "stop",
            logprobs: null,
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toMatchObject({ object: "response", status: "completed" });
  });

  it("streams through the bounded parser and renderer state machines", async () => {
    const transform = createProtocolAdaptationTransform({
      source: "openai-chat",
      target: "openai-responses",
    });
    const writer = transform.writable.getWriter();
    const reader = transform.readable.getReader();
    const chunks: string[] = [];
    const consume = (async () => {
      while (true) {
        const result = await reader.read();
        if (result.done) return;
        chunks.push(new TextDecoder().decode(result.value));
      }
    })();
    await writer.write(
      new TextEncoder().encode(
        'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"gpt","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
      ),
    );
    expect(chunks.join("")).toContain("response.created");
    await writer.write(
      new TextEncoder().encode(
        'data: {"id":"c","object":"chat.completion.chunk","created":0,"model":"gpt","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      ),
    );
    await writer.close();
    await consume;
    expect(chunks.join("")).toContain("response.completed");
  });
});
