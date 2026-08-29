import { describe, expect, it } from "vitest";
import { sanitizeRelayRequestHeaders } from "./headers.js";
import {
  describeRelayControlParseError,
  encodeRelayBinaryFrame,
  parseRelayBinaryFrame,
  parseRelayClientControlFrame,
  parseRelaySubprotocolHeader,
  RELAY_BINARY_CHUNK_MAX_BYTES,
  RELAY_SUBPROTOCOL,
} from "./protocol.js";

const RELAY_JSON_CONTROL_MAX_BYTES = 64 * 1024;

describe("relayProtocol", () => {
  it("accepts the v2 websocket subprotocol and rejects unsupported major versions", () => {
    expect(parseRelaySubprotocolHeader(RELAY_SUBPROTOCOL)).toEqual({
      ok: true,
      supported: true,
      requestedMajorVersions: [2],
    });
    expect(parseRelaySubprotocolHeader("ws-model-proxy.relay.v1")).toEqual({
      ok: true,
      supported: false,
      requestedMajorVersions: [1],
    });
  });

  it("rejects oversized JSON control frames", () => {
    expect(() =>
      parseRelayClientControlFrame("x".repeat(RELAY_JSON_CONTROL_MAX_BYTES + 1)),
    ).toThrow("JSON control frame exceeds 64 KiB.");
  });

  it("rejects oversized binary chunks", () => {
    const oversized = new Uint8Array(RELAY_BINARY_CHUNK_MAX_BYTES + 1);
    expect(() =>
      encodeRelayBinaryFrame(
        {
          type: "relay.request.body",
          requestId: "request-id",
          chunkId: "0",
        },
        oversized,
      ),
    ).toThrow("Binary body chunk exceeds 1 MiB.");
  });

  it("round-trips binary-safe frames without coercing bytes to JSON strings", () => {
    const body = new Uint8Array([0, 1, 2, 255]);
    const frame = encodeRelayBinaryFrame(
      {
        type: "relay.request.body",
        requestId: "request-id",
        chunkId: "0",
        final: true,
      },
      body,
    );

    const parsed = parseRelayBinaryFrame(frame);
    expect(parsed.metadata).toEqual({
      type: "relay.request.body",
      requestId: "request-id",
      chunkId: "0",
      final: true,
    });
    expect([...parsed.body]).toEqual([0, 1, 2, 255]);
  });

  it("accepts separate standardized relay metrics", () => {
    expect(
      parseRelayClientControlFrame(
        JSON.stringify({
          type: "relay.complete",
          requestId: "request-id",
          usage: { completionTokens: 42 },
          metrics: { completionTokens: 40, tokenizer: "cl100k_base" },
        }),
      ),
    ).toMatchObject({
      type: "relay.complete",
      usage: { completionTokens: 42 },
      metrics: { completionTokens: 40, tokenizer: "cl100k_base" },
    });
  });

  it("rejects capability blobs with unsupported versions", () => {
    try {
      parseRelayClientControlFrame(
        JSON.stringify({
          type: "hello",
          id: "hello-id",
          protocolVersion: "2.1",
          cli: {
            slug: "desktop",
            label: "Desktop",
            capabilities: {
              protocolVersion: "2.1",
              inventoryAck: true,
              inventoryReplace: true,
              endpointTargeting: true,
              binaryFrames: true,
              cancellation: true,
              maxBinaryChunkBytes: 1024 * 1024,
              requestBodyStreaming: true,
              requestBodyWindowChunks: 16,
            },
          },
          endpoints: [
            {
              slug: "local-openai",
              label: "Local OpenAI",
              kind: "openai-compatible",
              status: "online",
              defaultCapabilities: {
                version: 5,
                protocol: "openai-compatible",
              },
              models: [],
            },
          ],
        }),
      );
      throw new Error("expected parse failure");
    } catch (error) {
      const description = describeRelayControlParseError(error);
      expect(description.kind).toBe("schema");
      if (description.kind !== "schema") throw new Error("expected schema rejection");
      expect(description.issues.some((issue) => issue.path.includes("version"))).toBe(true);
    }
  });

  it("rejects extra keys on v4 capability surfaces", () => {
    try {
      parseRelayClientControlFrame(
        JSON.stringify({
          type: "hello",
          id: "hello-id",
          protocolVersion: "2.1",
          cli: {
            slug: "desktop",
            label: "Desktop",
            capabilities: {
              protocolVersion: "2.1",
              inventoryAck: true,
              inventoryReplace: true,
              endpointTargeting: true,
              binaryFrames: true,
              cancellation: true,
              maxBinaryChunkBytes: 1024 * 1024,
              requestBodyStreaming: true,
              requestBodyWindowChunks: 16,
            },
          },
          endpoints: [
            {
              slug: "local-openai",
              label: "Local OpenAI",
              kind: "openai-compatible",
              status: "online",
              defaultCapabilities: {
                version: 4,
                protocol: "openai-compatible",
                surfaces: {
                  openaiChatCompletions: {
                    supported: true,
                    unknownField: true,
                  },
                },
              },
              models: [],
            },
          ],
        }),
      );
      throw new Error("expected parse failure");
    } catch (error) {
      const description = describeRelayControlParseError(error);
      expect(description.kind).toBe("schema");
      if (description.kind !== "schema") throw new Error("expected schema rejection");
      expect(
        description.issues.some(
          (issue) => issue.path.includes("unknownField") || issue.message.includes("unknownField"),
        ),
      ).toBe(true);
    }
  });

  it("classifies oversize control frames before schema validation", () => {
    try {
      parseRelayClientControlFrame("x".repeat(RELAY_JSON_CONTROL_MAX_BYTES + 1));
      throw new Error("expected parse failure");
    } catch (error) {
      expect(describeRelayControlParseError(error)).toEqual({ kind: "oversize" });
    }
  });
});

describe("sanitizeRelayRequestHeaders", () => {
  it("strips bearer credentials, cookies, hop-by-hop headers, and token material", () => {
    const headers = sanitizeRelayRequestHeaders({
      Authorization: "Bearer secret",
      Cookie: "session=secret",
      Connection: "keep-alive",
      "X-Api-Key": "secret",
      "X-Custom-Token": "secret",
      Accept: "application/json",
      "Content-Type": "application/json",
      "OpenAI-Beta": "responses=v1",
      "OpEnAI-OrGaNiZaTiOn": "org_untrusted",
      "OPENAI-PrOjEcT": "project_untrusted",
      "X-Request-Id": "request-id",
      "Anthropic-Version": "2023-06-01",
      "Anthropic-Beta": "one,two",
    });

    expect(headers).toEqual({
      accept: "application/json",
      "content-type": "application/json",
      "openai-beta": "responses=v1",
      "x-request-id": "request-id",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "one,two",
    });
    expect(headers).not.toHaveProperty("openai-organization");
    expect(headers).not.toHaveProperty("openai-project");
  });
});
