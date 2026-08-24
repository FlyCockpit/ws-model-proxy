import { describe, expect, it } from "vitest";
import {
  anthropicRelayHeaders,
  parseAnthropicIngress,
  SUPPORTED_ANTHROPIC_VERSIONS,
} from "./anthropic-protocol";
import officialFixture from "./fixtures/anthropic-2023-06-01.json";

describe("Anthropic protocol boundary", () => {
  it("tracks the supported official-version fixture and ordered beta semantics", () => {
    expect(officialFixture.source).toMatch(/^https:\/\/docs\.anthropic\.com\//);
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
