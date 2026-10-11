import { describe, expect, it } from "vitest";
import { ResponseUsageRecorder } from "./response-usage-sample.js";
import {
  readUpstreamErrorExcerpt,
  UPSTREAM_ERROR_EXCERPT_CHARS,
  upstreamErrorExcerpt,
  upstreamErrorExcerptFromText,
} from "./upstream-error-excerpt.js";

function sampleOf(...parts: string[]) {
  const recorder = new ResponseUsageRecorder();
  for (const part of parts) recorder.push(new TextEncoder().encode(part));
  return recorder.sample();
}

describe("upstreamErrorExcerpt", () => {
  it("keeps an OpenAI-style error message and its param", () => {
    expect(
      upstreamErrorExcerptFromText(
        JSON.stringify({ error: { message: "Unknown field: user", param: "user", code: 400 } }),
      ),
    ).toBe("Unknown field: user (param: user)");
  });

  it("reads TensorFold and llama.cpp style answers", () => {
    expect(upstreamErrorExcerptFromText('{"detail":"messages must be a list"}')).toBe(
      "messages must be a list",
    );
    expect(upstreamErrorExcerptFromText('{"error":"malformed request"}')).toBe("malformed request");
    expect(upstreamErrorExcerptFromText("Bad Request\n\nmalformed\trequest")).toBe(
      "Bad Request malformed request",
    );
  });

  it("keeps pydantic locations and messages but never the echoed input", () => {
    const body = JSON.stringify({
      detail: [
        {
          type: "extra_forbidden",
          loc: ["body", "stream_options"],
          msg: "Extra inputs are not permitted",
          input: { include_usage: true, prompt: "my private prompt" },
        },
      ],
    });
    const excerpt = upstreamErrorExcerptFromText(body);
    expect(excerpt).toBe("body.stream_options: Extra inputs are not permitted");
    expect(excerpt).not.toContain("private");
  });

  it("never stores prompt text a runtime echoes back", () => {
    for (const body of [
      JSON.stringify({ errors: [{ field: "messages", input: "MY SECRET PROMPT" }] }),
      JSON.stringify({ detail: [{ loc: ["body"], input: "MY SECRET PROMPT" }] }),
      JSON.stringify({
        message: "1 validation error: {'type': 'missing', 'input': {'prompt': 'MY SECRET PROMPT'}}",
      }),
      JSON.stringify({ error: { message: "bad request: input_value='MY SECRET PROMPT'" } }),
      "Error: messages must be a list (input=MY SECRET PROMPT)",
    ]) {
      const excerpt = upstreamErrorExcerptFromText(body);
      expect(excerpt).not.toContain("SECRET");
      expect(excerpt).not.toBeNull();
    }
    expect(
      upstreamErrorExcerptFromText(JSON.stringify({ errors: [{ input: "MY SECRET PROMPT" }] })),
    ).toBe("(unrecognized JSON error body)");
  });

  it("reads only the message of JSON cut off at the read window", () => {
    const cut = `{"detail":[{"msg":"Field required","input":"${"private ".repeat(2000)}`;
    const excerpt = upstreamErrorExcerpt(sampleOf(cut));
    expect(excerpt).toBe("Field required");
  });

  it("redacts credentials and bounds the length", () => {
    const token = `Bearer ${"a".repeat(40)}`;
    const excerpt = upstreamErrorExcerptFromText(`invalid ${token} ${"x".repeat(1000)}`);
    expect(excerpt).not.toContain("aaaa");
    const keys = upstreamErrorExcerptFromText(
      `{"error":{"message":"Incorrect API key provided: sk-${"b".repeat(30)} or wsmp_node_${"c".repeat(30)}"}}`,
    );
    expect(keys).toBe("Incorrect API key provided: [redacted] or [redacted]");
    expect([...(excerpt ?? "")].length).toBeLessThanOrEqual(UPSTREAM_ERROR_EXCERPT_CHARS);
  });

  it("is null for an empty answer", () => {
    expect(upstreamErrorExcerpt(null)).toBeNull();
    expect(upstreamErrorExcerptFromText("  \n ")).toBeNull();
  });

  it("reads a failed answer's body without waiting on a stalled stream", async () => {
    const encoder = new TextEncoder();
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"error":{"message":"CUDA out'));
        controller.enqueue(encoder.encode(' of memory"}}'));
        // Never closes.
      },
    });
    await expect(readUpstreamErrorExcerpt(stalled, 20)).resolves.toBe("CUDA out of memory");
    await expect(readUpstreamErrorExcerpt(null)).resolves.toBeNull();
  });
});
