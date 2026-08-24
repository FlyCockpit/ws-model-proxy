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
    const result = parseAnthropicIngress(new Headers(officialFixture.requestHeaders));
    expect(result).toEqual({
      version: officialFixture.protocolVersion,
      betaFeatures: ["prompt-caching-2024-07-31", "interleaved-thinking-2025-05-14"],
    });
    expect(JSON.parse(JSON.stringify(officialFixture.error))).toMatchObject({
      type: "error",
      error: { type: "invalid_request_error" },
    });
    expect(officialFixture.stream).toContain("event: message_start");
    expect(officialFixture.stream.endsWith("\n\n")).toBe(true);
    expect(officialFixture.request).toMatchObject({
      model: expect.any(String),
      max_tokens: expect.any(Number),
      messages: [{ role: "user", content: expect.any(String) }],
    });
    expect(officialFixture.response).toMatchObject({
      type: "message",
      role: "assistant",
      stop_reason: "end_turn",
      usage: { input_tokens: expect.any(Number), output_tokens: expect.any(Number) },
    });
    expect(officialFixture.countTokensRequest).toMatchObject({ messages: expect.any(Array) });
    expect(officialFixture.countTokensResponse).toEqual({ input_tokens: expect.any(Number) });
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
