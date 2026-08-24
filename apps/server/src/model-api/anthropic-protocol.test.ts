import { describe, expect, it } from "vitest";
import {
  anthropicRelayHeaders,
  parseAnthropicIngress,
  SUPPORTED_ANTHROPIC_VERSIONS,
} from "./anthropic-protocol";
import officialFixture from "./fixtures/anthropic-2023-06-01.json";

describe("Anthropic protocol boundary", () => {
  it("tracks the supported official-version fixture and ordered beta semantics", () => {
    expect(Object.values(officialFixture.sources)).toHaveLength(5);
    for (const source of Object.values(officialFixture.sources)) {
      expect(source).toMatch(/^https:\/\/docs\.anthropic\.com\//);
    }
    expect(officialFixture.derivedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(officialFixture.provenance.upstreamCapture).toBe(false);
    const result = parseAnthropicIngress(new Headers(officialFixture.requestHeaders));
    expect(result).toEqual({
      version: officialFixture.protocolVersion,
      betaFeatures: ["prompt-caching-2024-07-31", "interleaved-thinking-2025-05-14"],
    });
    expect(officialFixture.error).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "Invalid request" },
    });
    expect(officialFixture.stream.endsWith("\n\n")).toBe(true);
    const streamRecords = officialFixture.stream
      .trimEnd()
      .split("\n\n")
      .map((record) => {
        const [eventLine, dataLine] = record.split("\n");
        return { event: eventLine?.slice(7), data: JSON.parse(dataLine?.slice(6) ?? "null") };
      });
    expect(streamRecords).toEqual(officialFixture.streamEvents);
    expect(streamRecords.map(({ event }) => event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(streamRecords.at(-1)).toEqual({
      event: "message_stop",
      data: { type: "message_stop" },
    });
    expect(officialFixture.request).toEqual({
      model: "claude-sonnet-4-20250514",
      max_tokens: 32,
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(officialFixture.response).toEqual({
      id: "msg_fixture",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hello!" }],
      model: "claude-sonnet-4-20250514",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 8, output_tokens: 4 },
    });
    expect(officialFixture.countTokensRequest).toEqual({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(officialFixture.countTokensResponse).toEqual({ input_tokens: 8 });
    expect(officialFixture.beta.header).toBe("anthropic-beta");
    expect(officialFixture.requestHeaders["anthropic-beta"]).toBe(
      officialFixture.beta.features.join(officialFixture.beta.separator),
    );
  });
  it("requires the supported official protocol version", async () => {
    for (const headers of [new Headers(), new Headers({ "anthropic-version": "2099-01-01" })]) {
      const result = parseAnthropicIngress(headers);
      expect(result).toBeInstanceOf(Response);
      if (result instanceof Response)
        expect(await result.json()).toMatchObject({
          type: "error",
          error: { type: "invalid_request_error" },
        });
    }
    expect(SUPPORTED_ANTHROPIC_VERSIONS).toContain("2023-06-01");
  });

  it("parses comma/space beta sets in order and rejects malformed values", () => {
    expect(
      parseAnthropicIngress(
        new Headers({ "anthropic-version": "2023-06-01", "anthropic-beta": "one, two,one" }),
      ),
    ).toEqual({ version: "2023-06-01", betaFeatures: ["one", "two"] });
    expect(
      parseAnthropicIngress(
        new Headers({ "anthropic-version": "2023-06-01", "anthropic-beta": "bad beta" }),
      ),
    ).toBeInstanceOf(Response);
  });

  it("isolates inbound WSMP bearer and x-api-key from relay headers", () => {
    const request = new Request("https://wsmp.test/v1/messages", {
      headers: {
        authorization: "Bearer wsmp-secret",
        cookie: "private",
        "x-api-key": "provider-secret",
        "anthropic-version": "2023-06-01",
      },
    });
    expect(parseAnthropicIngress(request.headers)).toBeInstanceOf(Response);
    const clean = new Request(request.url, {
      headers: {
        authorization: "Bearer wsmp-secret",
        cookie: "private",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "one, two",
      },
    });
    const ingress = parseAnthropicIngress(clean.headers);
    if (ingress instanceof Response) throw new Error("expected ingress");
    const relayed = anthropicRelayHeaders(clean, ingress);
    expect(relayed.get("authorization")).toBeNull();
    expect(relayed.get("x-api-key")).toBeNull();
    expect(relayed.get("cookie")).toBeNull();
    expect(relayed.get("anthropic-beta")).toBe("one,two");
  });
});
