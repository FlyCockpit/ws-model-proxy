import { describe, expect, it } from "vitest";
import { sanitizeRelayRequestHeaders } from "./headers.js";
import {
  describeRelayControlParseError,
  encodeRelayBinaryFrame,
  parseRelayBinaryFrame,
  parseRelayClientControlFrame,
  parseRelaySubprotocolHeader,
  RELAY_BINARY_CHUNK_MAX_BYTES,
  RELAY_PROTOCOL_VERSIONS,
  RELAY_SUBPROTOCOL,
  relayProtocolAtLeast,
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

function endpoint() {
  return {
    slug: "local-openai",
    label: "Local OpenAI",
    kind: "openai-compatible",
    status: "online",
    defaultCapabilities: {
      version: 1,
      protocol: "openai-compatible",
      chatCompletions: { supported: true },
    },
    models: [],
  };
}

function uncompressedKey(prefix = 0x04): string {
  const bytes = Buffer.alloc(65, 9);
  bytes[0] = prefix;
  return bytes.toString("base64url");
}

function bytes16(): string {
  return Buffer.alloc(16, 7).toString("base64url");
}

function hello(
  protocolVersion: "2.0" | "2.1" | "2.2" | "2.3" | "2.4" | "2.5",
  capabilities: unknown,
) {
  return JSON.stringify({
    type: "hello",
    id: "hello-id",
    protocolVersion,
    cli: { slug: "desktop", label: "Desktop", version: "1.8.0", capabilities },
    endpoints: [endpoint()],
  });
}

describe("relay protocol 2.4", () => {
  const shared = {
    inventoryAck: true,
    inventoryReplace: true,
    endpointTargeting: true,
    binaryFrames: true,
    cancellation: true,
    maxBinaryChunkBytes: 1024 * 1024,
    requestBodyStreaming: true,
    requestBodyWindowChunks: 16,
  };

  it("accepts 2.0 through 2.3 hellos unchanged", () => {
    expect(
      parseRelayClientControlFrame(
        hello("2.0", {
          protocolVersion: "2.0",
          binaryFrames: true,
          cancellation: true,
          maxBinaryChunkBytes: 1024 * 1024,
          requestBodyStreaming: true,
          requestBodyWindowChunks: 16,
        }),
      ).type,
    ).toBe("hello");
    expect(
      parseRelayClientControlFrame(hello("2.1", { protocolVersion: "2.1", ...shared })).type,
    ).toBe("hello");
    expect(
      parseRelayClientControlFrame(
        hello("2.2", { protocolVersion: "2.2", ...shared, sharedTokenizerTps: true }),
      ).type,
    ).toBe("hello");
    expect(
      parseRelayClientControlFrame(
        hello("2.3", {
          protocolVersion: "2.3",
          ...shared,
          sharedTokenizerTps: true,
          standardizedMetrics: true,
        }),
      ).type,
    ).toBe("hello");
  });

  it("parses a 2.4 hello and rejects a mismatched capability version", () => {
    const parsed = parseRelayClientControlFrame(
      hello("2.4", {
        protocolVersion: "2.4",
        ...shared,
        sharedTokenizerTps: true,
        standardizedMetrics: true,
        terminal: true,
        exec: true,
        features: {
          humanTerminal: true,
          mcpCommands: false,
          terminalApproval: true,
          terminalSupported: true,
        },
        terminalPublicKey: uncompressedKey(),
      }),
    );
    expect(parsed).toMatchObject({ type: "hello", protocolVersion: "2.4" });
    const withConcurrency = JSON.parse(
      hello("2.4", {
        protocolVersion: "2.4",
        ...shared,
        sharedTokenizerTps: true,
        standardizedMetrics: true,
        terminal: true,
        exec: true,
        features: {
          humanTerminal: true,
          mcpCommands: false,
          terminalApproval: true,
          terminalSupported: true,
        },
        terminalPublicKey: uncompressedKey(),
      }),
    ) as { endpoints: Array<{ models: unknown[] }> };
    withConcurrency.endpoints[0]?.models.push({
      upstreamModelId: "llama-local",
      capabilityOverrideMode: "inherit",
      concurrencyLimit: 4,
    });
    expect(parseRelayClientControlFrame(JSON.stringify(withConcurrency))).toMatchObject({
      type: "hello",
      endpoints: [{ models: [{ upstreamModelId: "llama-local", concurrencyLimit: 4 }] }],
    });
    withConcurrency.endpoints[0]?.models.splice(0, 1, {
      upstreamModelId: "llama-local",
      concurrencyLimit: 0,
    });
    expect(() => parseRelayClientControlFrame(JSON.stringify(withConcurrency))).toThrow();

    expect(() =>
      parseRelayClientControlFrame(
        hello("2.4", {
          protocolVersion: "2.3",
          ...shared,
          sharedTokenizerTps: true,
          standardizedMetrics: true,
        }),
      ),
    ).toThrow();
    expect(() =>
      parseRelayClientControlFrame(
        hello("2.4", {
          protocolVersion: "2.4",
          ...shared,
          sharedTokenizerTps: true,
          standardizedMetrics: true,
          terminal: true,
          exec: true,
          features: {
            humanTerminal: true,
            mcpCommands: true,
            terminalApproval: false,
            terminalSupported: true,
          },
          terminalPublicKey: uncompressedKey(0x02),
        }),
      ),
    ).toThrow();
  });

  it("rejects unknown keys on terminal and exec frames", () => {
    const opened = parseRelayClientControlFrame(
      JSON.stringify({ type: "term.opened", terminalId: bytes16(), cliNonce: bytes16() }),
    );
    expect(opened).toMatchObject({ type: "term.opened" });
    expect(() =>
      parseRelayClientControlFrame(
        JSON.stringify({
          type: "term.opened",
          terminalId: bytes16(),
          cliNonce: bytes16(),
          extra: true,
        }),
      ),
    ).toThrow();
    expect(() =>
      parseRelayClientControlFrame(
        JSON.stringify({
          type: "exec.done",
          commandId: bytes16(),
          timedOut: false,
          unexpected: 1,
        }),
      ),
    ).toThrow();
    const done = parseRelayClientControlFrame(
      JSON.stringify({ type: "exec.done", commandId: bytes16(), timedOut: true, exitCode: 0 }),
    );
    expect(done).toMatchObject({ type: "exec.done", timedOut: true });
    const signaled = parseRelayClientControlFrame(
      JSON.stringify({
        type: "exec.done",
        commandId: bytes16(),
        timedOut: true,
        signal: 9,
      }),
    );
    expect(signaled).toMatchObject({ type: "exec.done", signal: "9", timedOut: true });
    const named = parseRelayClientControlFrame(
      JSON.stringify({
        type: "term.exit",
        terminalId: bytes16(),
        signal: "SIGKILL",
      }),
    );
    expect(named).toMatchObject({ type: "term.exit", signal: "SIGKILL" });
  });

  it("round-trips sealed terminal and exec output metadata", () => {
    const body = new Uint8Array([9, 8, 7]);
    const sealed = parseRelayBinaryFrame(
      encodeRelayBinaryFrame({ type: "term.sealed", terminalId: bytes16(), seq: 4 }, body),
    );
    expect(sealed.metadata).toEqual({ type: "term.sealed", terminalId: bytes16(), seq: 4 });
    const stdout = parseRelayBinaryFrame(
      encodeRelayBinaryFrame({ type: "exec.stdout", commandId: bytes16(), seq: 1 }, body),
    );
    expect(stdout.metadata.type).toBe("exec.stdout");
    const metadataBytes = new TextEncoder().encode(
      JSON.stringify({ type: "term.sealed", terminalId: bytes16(), seq: 1, extra: true }),
    );
    const extra = new Uint8Array(4 + metadataBytes.byteLength);
    new DataView(extra.buffer).setUint32(0, metadataBytes.byteLength, false);
    extra.set(metadataBytes, 4);
    expect(() => parseRelayBinaryFrame(extra.buffer)).toThrow();
  });
});

describe("relay protocol 2.5", () => {
  const capabilities24 = {
    inventoryAck: true,
    inventoryReplace: true,
    endpointTargeting: true,
    binaryFrames: true,
    cancellation: true,
    maxBinaryChunkBytes: 1024 * 1024,
    requestBodyStreaming: true,
    requestBodyWindowChunks: 16,
    sharedTokenizerTps: true,
    standardizedMetrics: true,
    terminal: true,
    exec: true,
    features: {
      humanTerminal: true,
      mcpCommands: true,
      terminalApproval: false,
      terminalSupported: true,
    },
    terminalPublicKey: uncompressedKey(),
  };

  function viewer(fill = 8): string {
    return Buffer.alloc(16, fill).toString("base64url");
  }

  function sealedFrame(metadata: Record<string, unknown>): ArrayBuffer {
    const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
    const frame = new Uint8Array(4 + metadataBytes.byteLength);
    new DataView(frame.buffer).setUint32(0, metadataBytes.byteLength, false);
    frame.set(metadataBytes, 4);
    return frame.buffer;
  }

  it("accepts a 2.5 hello only with terminalViewers and keeps 2.4 strict", () => {
    expect(RELAY_PROTOCOL_VERSIONS).toContain("2.5");
    expect(
      parseRelayClientControlFrame(
        hello("2.5", { protocolVersion: "2.5", ...capabilities24, terminalViewers: true }),
      ),
    ).toMatchObject({
      type: "hello",
      protocolVersion: "2.5",
      cli: { capabilities: { terminalViewers: true } },
    });
    expect(() =>
      parseRelayClientControlFrame(hello("2.5", { protocolVersion: "2.5", ...capabilities24 })),
    ).toThrow();
    expect(() =>
      parseRelayClientControlFrame(
        hello("2.5", { protocolVersion: "2.5", ...capabilities24, terminalViewers: false }),
      ),
    ).toThrow();
    expect(() =>
      parseRelayClientControlFrame(
        hello("2.5", {
          protocolVersion: "2.5",
          ...capabilities24,
          terminalViewers: true,
          extra: true,
        }),
      ),
    ).toThrow();
    expect(() =>
      parseRelayClientControlFrame(
        hello("2.4", { protocolVersion: "2.4", ...capabilities24, terminalViewers: true }),
      ),
    ).toThrow();
    expect(() =>
      parseRelayClientControlFrame(
        hello("2.4", { protocolVersion: "2.5", ...capabilities24, terminalViewers: true }),
      ),
    ).toThrow();
  });

  it("compares versions numerically", () => {
    expect(relayProtocolAtLeast("2.5", "2.4")).toBe(true);
    expect(relayProtocolAtLeast("2.10", "2.5")).toBe(true);
    expect(relayProtocolAtLeast("2.3", "2.4")).toBe(false);
    expect(relayProtocolAtLeast(null, "2.4")).toBe(false);
  });

  it("parses viewer ids on term.* frames and the new term.writer", () => {
    for (const type of ["term.opened", "term.attached", "term.pending"]) {
      expect(
        parseRelayClientControlFrame(
          JSON.stringify({ type, terminalId: bytes16(), viewerId: viewer(), cliNonce: bytes16() }),
        ),
      ).toMatchObject({ type, viewerId: viewer() });
    }
    expect(
      parseRelayClientControlFrame(
        JSON.stringify({
          type: "term.rejected",
          terminalId: bytes16(),
          viewerId: viewer(),
          reason: "viewer_limit",
        }),
      ),
    ).toMatchObject({ type: "term.rejected", viewerId: viewer(), reason: "viewer_limit" });
    expect(
      parseRelayClientControlFrame(
        JSON.stringify({ type: "term.writer", terminalId: bytes16(), viewerId: viewer() }),
      ),
    ).toEqual({ type: "term.writer", terminalId: bytes16(), viewerId: viewer() });
    expect(
      parseRelayClientControlFrame(JSON.stringify({ type: "term.writer", terminalId: bytes16() })),
    ).toEqual({ type: "term.writer", terminalId: bytes16() });
    expect(() =>
      parseRelayClientControlFrame(
        JSON.stringify({ type: "term.writer", terminalId: bytes16(), viewerId: "short" }),
      ),
    ).toThrow();
    expect(() =>
      parseRelayClientControlFrame(
        JSON.stringify({ type: "term.writer", terminalId: bytes16(), viewerId: null }),
      ),
    ).toThrow();
    expect(() =>
      parseRelayClientControlFrame(
        JSON.stringify({
          type: "term.writer",
          terminalId: bytes16(),
          cols: 80,
        }),
      ),
    ).toThrow();
  });

  it("parses unicast and broadcast sealed metadata and refuses both at once", () => {
    const body = new Uint8Array([1]);
    expect(
      parseRelayBinaryFrame(
        encodeRelayBinaryFrame(
          { type: "term.sealed", terminalId: bytes16(), seq: 1, viewerId: viewer() },
          body,
        ),
      ).metadata,
    ).toEqual({ type: "term.sealed", terminalId: bytes16(), seq: 1, viewerId: viewer() });
    expect(
      parseRelayBinaryFrame(
        encodeRelayBinaryFrame(
          { type: "term.sealed", terminalId: bytes16(), seq: 1, epoch: 0xffff_ffff },
          body,
        ),
      ).metadata,
    ).toEqual({ type: "term.sealed", terminalId: bytes16(), seq: 1, epoch: 0xffff_ffff });
    expect(() =>
      parseRelayBinaryFrame(
        sealedFrame({
          type: "term.sealed",
          terminalId: bytes16(),
          seq: 1,
          viewerId: viewer(),
          epoch: 1,
        }),
      ),
    ).toThrow();
    for (const epoch of [0, -1, 1.5, 0x1_0000_0000]) {
      expect(() =>
        parseRelayBinaryFrame(
          sealedFrame({ type: "term.sealed", terminalId: bytes16(), seq: 1, epoch }),
        ),
      ).toThrow();
    }
    expect(() =>
      parseRelayBinaryFrame(
        sealedFrame({ type: "term.sealed", terminalId: bytes16(), seq: 1, viewerId: "nope" }),
      ),
    ).toThrow();
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
