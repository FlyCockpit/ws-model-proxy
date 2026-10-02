import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sanitizeRelayRequestHeaders } from "./headers.js";
import {
  describeRelayControlParseError,
  encodeRelayBinaryFrame,
  encodeRelayServerControlMessage,
  helloNeedsUpgrade,
  NODE_METRIC_SOURCES_MAX,
  parseRelayBinaryFrame,
  parseRelayClientControlFrame,
  parseRelaySubprotocolHeader,
  RELAY_BINARY_CHUNK_MAX_BYTES,
  RELAY_MIN_PROTOCOL_VERSION,
  RELAY_PROTOCOL_VERSIONS,
  RELAY_SUBPROTOCOL,
  RELAY_UPGRADE_REQUIRED_MESSAGE,
  type RelayServerControlMessage,
  rejectedHelloFacts,
  relayProtocolAtLeast,
  remoteMetricSourceSchema,
  remoteMetricSourcesSchema,
} from "./protocol.js";
import { characterCount, RelayWireTextError, truncateCharacters } from "./wire-text.js";

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
            hostname: "desk-01.local",
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
            hostname: "desk-01.local",
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

function dummySignature(): string {
  return Buffer.alloc(64, 0x22).toString("base64url");
}

const CAPABILITIES = {
  features: {
    humanTerminal: true,
    mcpCommandMode: "supervised",
    terminalApproval: false,
    terminalSupported: true,
    remoteMetricSources: false,
    remoteEngineAdapters: false,
    mcpFileRead: false,
    fileRootsConfigured: false,
    allowFileToolsAsRoot: false,
  },
  terminalPublicKey: uncompressedKey(),
};

function hello(protocolVersion: string, capabilities: unknown) {
  return JSON.stringify({
    type: "hello",
    id: "hello-id",
    protocolVersion,
    cli: {
      slug: "desktop",
      hostname: "desk-01.local",
      identityPublicKey: uncompressedKey(),
      identitySignature: dummySignature(),
      version: "0.4.0",
      capabilities,
    },
    endpoints: [endpoint()],
  });
}

function helloWithCli(cli: Record<string, unknown>) {
  return JSON.stringify({
    type: "hello",
    id: "hello-id",
    protocolVersion: "2.4",
    cli: {
      slug: "desktop",
      identityPublicKey: uncompressedKey(),
      identitySignature: dummySignature(),
      capabilities: CAPABILITIES,
      ...cli,
    },
    endpoints: [endpoint()],
  });
}

describe("hello hostname", () => {
  function parsedHostname(cli: Record<string, unknown>) {
    const parsed = parseRelayClientControlFrame(helloWithCli(cli));
    if (parsed.type !== "hello") throw new Error("expected hello");
    return parsed.cli.hostname;
  }

  it("is null when omitted, null, or blank", () => {
    expect(parsedHostname({})).toBeNull();
    expect(parsedHostname({ hostname: null })).toBeNull();
    expect(parsedHostname({ hostname: " \t\u0007 " })).toBeNull();
  });

  it("is trimmed, stripped of control characters, and bounded", () => {
    expect(parsedHostname({ hostname: "  desk\u0000-01\n" })).toBe("desk-01");
    expect(parsedHostname({ hostname: "a".repeat(400) })).toHaveLength(253);
  });

  it("rejects the removed label field", () => {
    expect(() => parseRelayClientControlFrame(helloWithCli({ label: "Desktop" }))).toThrow();
  });
});

describe("relay protocol 2.4 minimum", () => {
  it("speaks 2.4 and names the minimum protocol in the upgrade message", () => {
    expect(RELAY_PROTOCOL_VERSIONS).toEqual(["2.4"]);
    expect(RELAY_MIN_PROTOCOL_VERSION).toBe("2.4");
    expect(RELAY_UPGRADE_REQUIRED_MESSAGE).toContain("relay protocol 2.4");
    expect(RELAY_UPGRADE_REQUIRED_MESSAGE).toContain("Upgrade wsmp");
  });

  it("flags every hello that is not the minimum protocol, and the pre-naming label field", () => {
    for (const version of ["2.0", "2.3", "2.5", "2.6", "2.7", "2.8", "2.9"]) {
      expect(helloNeedsUpgrade(hello(version, { protocolVersion: version }))).toBe(true);
    }
    // 0.3.x shape: protocol 2.3 with `cli.label` and no hostname.
    expect(
      helloNeedsUpgrade(
        JSON.stringify({
          type: "hello",
          id: "h",
          protocolVersion: "2.3",
          cli: { slug: "desk", label: "Desk", capabilities: { protocolVersion: "2.3" } },
          endpoints: [],
        }),
      ),
    ).toBe(true);
    expect(helloNeedsUpgrade(helloWithCli({ label: "Desk" }))).toBe(true);
    expect(helloNeedsUpgrade(hello("2.4", CAPABILITIES))).toBe(false);
    // A released 0.3.x CLI (protocol 2.3) gets the upgrade message, not "malformed".
    expect(helloNeedsUpgrade(hello("2.3", CAPABILITIES))).toBe(true);
    expect(helloNeedsUpgrade(JSON.stringify({ type: "heartbeat", id: "x" }))).toBe(false);
    expect(helloNeedsUpgrade("not json")).toBe(false);
  });

  it("flags a hello newer than the newest protocol: the server must be upgraded", () => {
    for (const version of ["2.10", "3.0"]) {
      expect(helloNeedsUpgrade(hello(version, { ...CAPABILITIES, protocolVersion: version }))).toBe(
        true,
      );
    }
  });

  it("accepts a self-consistent 2.4 hello", () => {
    expect(() => parseRelayClientControlFrame(hello("2.4", CAPABILITIES))).not.toThrow();
  });

  it("requires cli.identityPublicKey and identitySignature on a 2.4 hello", () => {
    expect(() =>
      parseRelayClientControlFrame(helloWithCli({ identityPublicKey: undefined })),
    ).toThrow();
    expect(() =>
      parseRelayClientControlFrame(helloWithCli({ identityPublicKey: "not-a-key" })),
    ).toThrow();
    expect(() =>
      parseRelayClientControlFrame(helloWithCli({ identitySignature: "short" })),
    ).toThrow();
    const parsed = parseRelayClientControlFrame(helloWithCli({}));
    if (parsed.type !== "hello") throw new Error("expected hello");
    expect(parsed.cli.identityPublicKey).toBe(uncompressedKey());
    expect(parsed.cli.identitySignature).toBe(dummySignature());
  });

  describe("rejectedHelloFacts sanitising", () => {
    const facts = (protocolVersion: unknown, version: unknown) =>
      rejectedHelloFacts(
        JSON.stringify({ type: "hello", id: "h", protocolVersion, cli: { version } }),
      );

    it("keeps well-formed versions", () => {
      expect(facts("2.6", "0.4.0")).toEqual({ protocolVersion: "2.6", cliVersion: "0.4.0" });
      expect(facts("2.8", "1.2.3-rc.1+build.5")).toEqual({
        protocolVersion: "2.8",
        cliVersion: "1.2.3-rc.1+build.5",
      });
      expect(facts("2.10", "10.20.30").protocolVersion).toBe("2.10");
    });

    it.each([
      ["overlong", "1.0." + "9".repeat(40)],
      ["overlong padded semver", `1.2.3-${"a".repeat(40)}`],
      ["newline", "1.2.3\nX-Injected: 1"],
      ["NUL", "1.2.3\u0000"],
      ["ANSI escape", "1.2.3\u001b[31m"],
      ["bidi override", "1.2.3\u202e"],
      ["html", "<script>1.2.3</script>"],
      ["non-semver word", "latest"],
      ["two-part", "1.2"],
      ["four-part", "1.2.3.4"],
      // A >9-digit numeric identifier that still fits in the 32-character cap
      // (an IP-shaped string here; phone-shaped elsewhere) is not a semver, and
      // the per-component digit bound rejects it.
      ["overlong numeric identifier", `${"9".repeat(10)}.1.1`],
      ["v prefix", "v1.2.3"],
      ["empty", ""],
      ["padded with spaces", " 1.2.3 "],
      ["number", 123],
      ["object", { toString: "1.2.3" }],
      ["array", ["1.2.3"]],
      ["null", null],
    ])("drops a hostile cli version: %s", (_name, value) => {
      expect(facts("2.6", value).cliVersion).toBeNull();
      expect(facts("2.6", value).protocolVersion).toBe("2.6");
    });

    it.each([
      ["overlong", `2.${"9".repeat(40)}`],
      ["control characters", "2.\u00006"],
      ["newline", "2.6\n"],
      ["semver", "2.6.1"],
      ["single number", "2"],
      ["word", "next"],
      ["empty", ""],
      ["number", 2.6],
      ["null", null],
    ])("drops a hostile protocol version: %s", (_name, value) => {
      expect(facts(value, "0.4.0").protocolVersion).toBeNull();
      expect(facts(value, "0.4.0").cliVersion).toBe("0.4.0");
    });

    it("returns nothing for unusable frames", () => {
      const none = { protocolVersion: null, cliVersion: null };
      expect(rejectedHelloFacts("not json")).toEqual(none);
      expect(rejectedHelloFacts("[]")).toEqual(none);
      expect(rejectedHelloFacts("null")).toEqual(none);
      expect(rejectedHelloFacts(JSON.stringify({ type: "hello", cli: "1.2.3" }))).toEqual(none);
      const oversize = JSON.stringify({
        type: "hello",
        protocolVersion: "2.6",
        pad: "x".repeat(RELAY_JSON_CONTROL_MAX_BYTES),
      });
      expect(rejectedHelloFacts(oversize)).toEqual(none);
    });
  });

  it("parses a 2.4 hello and refuses older or loose capability shapes", () => {
    expect(parseRelayClientControlFrame(hello("2.4", CAPABILITIES))).toMatchObject({
      type: "hello",
      protocolVersion: "2.4",
      cli: {
        capabilities: {
          features: { mcpCommandMode: "supervised" },
        },
      },
    });
    const withConcurrency = JSON.parse(hello("2.4", CAPABILITIES)) as {
      endpoints: Array<{ models: unknown[] }>;
    };
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

    const bad: unknown[] = [
      { ...CAPABILITIES, supervisedCommands: true },
      { ...CAPABILITIES, countContext: true },
      { ...CAPABILITIES, extra: true },
      {
        ...CAPABILITIES,
        features: { ...CAPABILITIES.features, remoteMetricSources: undefined },
      },
      { ...CAPABILITIES, terminalPublicKey: uncompressedKey(0x02) },
      {
        ...CAPABILITIES,
        features: { ...CAPABILITIES.features, mcpCommandMode: "always" },
      },
      {
        ...CAPABILITIES,
        features: {
          humanTerminal: true,
          mcpCommands: true,
          terminalApproval: false,
          terminalSupported: true,
          remoteMetricSources: false,
          remoteEngineAdapters: false,
          mcpFileRead: false,
          fileRootsConfigured: false,
          allowFileToolsAsRoot: false,
        },
      },
    ];
    for (const capabilities of bad) {
      expect(() => parseRelayClientControlFrame(hello("2.4", capabilities))).toThrow();
    }
    expect(() =>
      parseRelayClientControlFrame(hello("2.6", { ...CAPABILITIES, protocolVersion: "2.6" })),
    ).toThrow();
  });

  it("refuses leftover always-true capability flags on a 2.4 hello", () => {
    expect(() => parseRelayClientControlFrame(hello("2.4", CAPABILITIES))).not.toThrow();
    expect(() =>
      parseRelayClientControlFrame(hello("2.4", { ...CAPABILITIES, countContext: true })),
    ).toThrow();
    expect(() =>
      parseRelayClientControlFrame(hello("2.4", { ...CAPABILITIES, fileOps: true })),
    ).toThrow();
  });

  it("parses context.count result and error frames", () => {
    expect(
      parseRelayClientControlFrame(
        JSON.stringify({
          type: "context.count.result",
          requestId: "count-1",
          tokens: 12,
          method: "vllm_tokenize",
        }),
      ),
    ).toMatchObject({ type: "context.count.result", tokens: 12, method: "vllm_tokenize" });
    expect(
      parseRelayClientControlFrame(
        JSON.stringify({
          type: "context.count.error",
          requestId: "count-1",
          failure: "timeout",
        }),
      ),
    ).toMatchObject({ type: "context.count.error", failure: "timeout" });
    expect(() =>
      parseRelayClientControlFrame(
        JSON.stringify({
          type: "context.count.result",
          requestId: "count-1",
          tokens: 12,
          method: "unknown",
        }),
      ),
    ).toThrow();
  });

  it("encodes a count-first relay.request", () => {
    expect(
      JSON.parse(
        encodeRelayServerControlMessage({
          type: "relay.request",
          requestId: "request-1",
          family: "chat.completions",
          method: "POST",
          path: "/v1/chat/completions",
          headers: {},
          timeoutMs: 30_000,
          endpointSlug: "local",
          expectBody: true,
          countFirst: true,
          countCeiling: 8192,
        }),
      ),
    ).toEqual({
      type: "relay.request",
      requestId: "request-1",
      family: "chat.completions",
      method: "POST",
      path: "/v1/chat/completions",
      headers: {},
      timeoutMs: 30_000,
      endpointSlug: "local",
      expectBody: true,
      countFirst: true,
      countCeiling: 8192,
    });
  });

  it("encodes a context.count server frame", () => {
    expect(
      JSON.parse(
        encodeRelayServerControlMessage({
          type: "context.count",
          requestId: "count-1",
          endpointSlug: "local",
          model: "llama",
          timeoutMs: 5000,
          expectBody: true,
        }),
      ),
    ).toEqual({
      type: "context.count",
      requestId: "count-1",
      endpointSlug: "local",
      model: "llama",
      timeoutMs: 5000,
      expectBody: true,
    });
  });

  it("accepts an optional, strict terminalIdentity", () => {
    const identityKey = Buffer.alloc(65, 3);
    identityKey[0] = 0x04;
    const terminalIdentity = {
      publicKey: identityKey.toString("base64url"),
      signature: Buffer.alloc(64, 7).toString("base64url"),
    };
    expect(
      parseRelayClientControlFrame(
        helloWithCli({
          identityPublicKey: terminalIdentity.publicKey,
          capabilities: { ...CAPABILITIES, terminalIdentity },
        }),
      ),
    ).toMatchObject({ cli: { capabilities: { terminalIdentity } } });
    for (const bad of [
      { publicKey: terminalIdentity.publicKey },
      { ...terminalIdentity, signature: Buffer.alloc(63, 7).toString("base64url") },
      { ...terminalIdentity, extra: true },
    ]) {
      expect(() =>
        parseRelayClientControlFrame(hello("2.4", { ...CAPABILITIES, terminalIdentity: bad })),
      ).toThrow();
    }
  });

  it("parses the supervised-command frames strictly", () => {
    const id = bytes16();
    expect(
      parseRelayClientControlFrame(
        JSON.stringify({ type: "term.spawned", terminalId: id, commandId: id }),
      ),
    ).toMatchObject({ type: "term.spawned" });
    for (const frame of [
      { type: "supervised.rejected", commandId: id, reason: "limit" },
      { type: "supervised.accepted", commandId: id },
      { type: "supervised.declined", commandId: id },
      { type: "supervised.done", commandId: id, exitCode: 0, review: false, outputBytes: 3 },
      { type: "supervised.done", commandId: id, signal: 9, review: true },
    ]) {
      expect(parseRelayClientControlFrame(JSON.stringify(frame)).type).toBe(frame.type);
    }
    for (const frame of [
      { type: "supervised.accepted", commandId: id, extra: 1 },
      { type: "supervised.done", commandId: id, exitCode: 0 },
      { type: "supervised.done", commandId: "short", review: false },
      { type: "supervised.done", commandId: id, review: false, outputBytes: -1 },
      { type: "term.spawned", terminalId: id },
    ]) {
      expect(() => parseRelayClientControlFrame(JSON.stringify(frame))).toThrow();
    }
    const output = parseRelayBinaryFrame(
      encodeRelayBinaryFrame(
        { type: "supervised.output", commandId: id, part: "tail", seq: 2 },
        new Uint8Array([1, 2]),
      ),
    );
    expect(output.metadata).toEqual({
      type: "supervised.output",
      commandId: id,
      part: "tail",
      seq: 2,
    });
    const metadataBytes = new TextEncoder().encode(
      JSON.stringify({ type: "supervised.output", commandId: id, part: "middle", seq: 1 }),
    );
    const bad = new Uint8Array(4 + metadataBytes.byteLength);
    new DataView(bad.buffer).setUint32(0, metadataBytes.byteLength, false);
    bad.set(metadataBytes, 4);
    expect(() => parseRelayBinaryFrame(bad.buffer)).toThrow();
  });
});

describe("relay terminal and exec frames", () => {
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

describe("relay viewer frames", () => {
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

describe("relay text is always well-formed Unicode", () => {
  it("refuses to encode a frame with an unpaired surrogate in any string", () => {
    // JSON.stringify would write `\ud800`, which the CLI cannot parse.
    expect(JSON.stringify({ command: "\ud800" })).toBe('{"command":"\\ud800"}');
    for (const command of ["echo \ud800", "\udc00", "x\udbff"]) {
      expect(() =>
        encodeRelayServerControlMessage({ type: "exec.start", commandId: "c", command }),
      ).toThrow(RelayWireTextError);
    }
    expect(() =>
      encodeRelayServerControlMessage({
        type: "term.spawn",
        terminalId: "t",
        commandId: "c",
        command: "true",
        requester: "agent \ud83d",
        shareOutput: false,
      }),
    ).toThrow(RelayWireTextError);
    expect(() =>
      encodeRelayServerControlMessage({
        type: "relay.request",
        requestId: "r",
        family: "generic",
        method: "GET",
        path: "/",
        headers: { "x-\ud800": "v" },
        timeoutMs: 1,
        endpointSlug: "e",
        expectBody: false,
      }),
    ).toThrow(RelayWireTextError);
    expect(() =>
      encodeRelayBinaryFrame(
        { type: "term.sealed", terminalId: "\ud800", seq: 1 },
        new Uint8Array(),
      ),
    ).toThrow(RelayWireTextError);
    // Paired surrogates (astral characters) are fine and sent as they are.
    expect(
      encodeRelayServerControlMessage({ type: "exec.start", commandId: "c", command: "echo 😀" }),
    ).toBe('{"type":"exec.start","commandId":"c","command":"echo 😀"}');
  });

  it("counts characters as code points and cuts only between graphemes", () => {
    expect(characterCount("😀".repeat(500))).toBe(500);
    expect(truncateCharacters(`${"a".repeat(99)}😀b`, 100)).toBe(`${"a".repeat(99)}😀`);
    expect(truncateCharacters(`${"a".repeat(99)}😀`, 100)).toBe(`${"a".repeat(99)}😀`);
    expect(truncateCharacters(`${"a".repeat(100)}😀`, 100)).toBe("a".repeat(100));
    expect(truncateCharacters(`${"a".repeat(98)}e\u0301x`, 99)).toBe("a".repeat(98));
    expect(truncateCharacters("a\ud800b", 100)).toBe("a\ufffdb");
  });

  it("never truncates non-empty text to nothing", () => {
    // One grapheme of 101 code points: the cut falls between code points.
    const stacked = `e${"\u0301".repeat(100)}`;
    expect(truncateCharacters(stacked, 100)).toBe(`e${"\u0301".repeat(99)}`);
    expect(truncateCharacters(`${stacked}x`, 100)).toBe(`e${"\u0301".repeat(99)}`);
    // A lone surrogate becomes U+FFFD, which starts a new grapheme.
    const broken = truncateCharacters(`e${"\u0301".repeat(50)}\ud800${"\u0301".repeat(60)}`, 100);
    expect(broken).toBe(`e${"\u0301".repeat(50)}`);
    // Marks with no base letter are one grapheme too.
    expect(truncateCharacters("\u0301".repeat(120), 100)).toBe("\u0301".repeat(100));
    expect(truncateCharacters("", 100)).toBe("");
  });
});

/** Cross-language vectors: `apps/cli/src/protocol.rs` encodes these exactly. */
function relay24Vector(name: string): Record<string, unknown> {
  const url = new URL(`../../../cli/tests/fixtures/relay-2.4/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
}

describe("relay protocol 2.7 telemetry frames", () => {
  it("accepts every CLI-encoded telemetry vector and the 2.4 hello", () => {
    for (const name of [
      "node-info.json",
      "node-metrics.json",
      "endpoint-load.json",
      // The CLI's conform pass applied to out-of-range readings
      // (`apps/cli/src/telemetry_bounds.rs`): still accepted here.
      "node-info-extreme.json",
      "node-metrics-extreme.json",
      "endpoint-load-extreme.json",
    ]) {
      const vector = relay24Vector(name);
      expect(parseRelayClientControlFrame(JSON.stringify(vector))).toMatchObject({
        type: vector.type,
      });
    }
    const hello = parseRelayClientControlFrame(JSON.stringify(relay24Vector("hello.json")));
    if (hello.type !== "hello") throw new Error("expected hello");
    expect(hello.endpoints[0]?.engineFacts).toEqual({
      engine: { value: "vllm", source: "probe" },
      slots: { value: 8, source: "config" },
      kvTokens: { value: 32768, source: "probe" },
      servedModelAliases: { value: ["meta/llama", "llama-alias"], source: "probe" },
    });
    expect(hello.endpoints[0]?.models[0]?.engineFacts).toEqual({
      maxModelLen: { value: 131072, source: "probe" },
    });
  });

  it("accepts the 2.4 hello and a custom endpoint.load without waiting", () => {
    const hello = parseRelayClientControlFrame(JSON.stringify(relay24Vector("hello.json")));
    if (hello.type !== "hello") throw new Error("expected hello");
    expect(hello.protocolVersion).toBe("2.4");
    const load = parseRelayClientControlFrame(
      JSON.stringify(relay24Vector("endpoint-load-custom.json")),
    );
    expect(load).toMatchObject({
      type: "endpoint.load",
      source: "custom",
      running: 3,
      kvOccupancy: 0.7,
    });
    if (load.type !== "endpoint.load") throw new Error("expected endpoint.load");
    expect(load.waiting).toBeUndefined();
    expect(() =>
      parseRelayClientControlFrame(
        JSON.stringify({
          type: "endpoint.load",
          endpointSlug: "vllm",
          running: 1,
          source: "vllm-metrics",
          ts: "2026-09-28T12:00:01.000Z",
        }),
      ),
    ).toThrow();
  });

  it("carries each metric source's interval, local sources included", () => {
    const frame = parseRelayClientControlFrame(JSON.stringify(relay24Vector("node-metrics.json")));
    if (frame.type !== "node.metrics") throw new Error("expected node.metrics");
    expect(frame.sources?.map((source) => [source.origin, source.intervalSecs])).toEqual([
      ["remote", 10],
      ["local", 60],
    ]);
    const withSource = (source: Record<string, unknown>) =>
      JSON.stringify({
        type: "node.metrics",
        ts: "2026-09-28T12:00:00.000Z",
        sources: [{ name: "fans", origin: "local", state: "active", ...source }],
      });
    expect(() => parseRelayClientControlFrame(withSource({}))).not.toThrow();
    for (const intervalSecs of [5, 86_400]) {
      expect(() => parseRelayClientControlFrame(withSource({ intervalSecs }))).not.toThrow();
    }
    for (const intervalSecs of [4, 86_401, 1.5, "10"]) {
      expect(() => parseRelayClientControlFrame(withSource({ intervalSecs }))).toThrow();
    }
  });

  it("refuses NUL and unpaired surrogates in stored telemetry text", () => {
    const info = (os: Record<string, unknown>) => JSON.stringify({ type: "node.info", os });
    const disk = (mount: string) =>
      JSON.stringify({ type: "node.metrics", ts: "2026-09-28T12:00:00.000Z", disks: [{ mount }] });
    for (const bad of ["a\u0000b", "a\ud800b", "\udc00"]) {
      expect(() => parseRelayClientControlFrame(info({ name: bad }))).toThrow();
      expect(() => parseRelayClientControlFrame(info({ arch: bad }))).toThrow();
      expect(() => parseRelayClientControlFrame(disk(bad))).toThrow();
      expect(() =>
        parseRelayClientControlFrame(
          JSON.stringify({ type: "node.info", gpus: [{ index: 0, driverVersion: bad }] }),
        ),
      ).toThrow();
    }
    // Paired surrogates, combining marks and ZWJ sequences are ordinary text.
    for (const good of ["😀", "e\u0301", "👩\u200d💻", "Ubuntu"]) {
      expect(() => parseRelayClientControlFrame(info({ name: good }))).not.toThrow();
      expect(() => parseRelayClientControlFrame(disk(`/mnt/${good}`))).not.toThrow();
    }
  });

  it("encodes metrics.sources.set in the shape the CLI parses", () => {
    const vector = relay24Vector("metrics-sources-set.json");
    const sources = remoteMetricSourceSchema.array().parse(vector.sources);
    const message: RelayServerControlMessage = {
      type: "metrics.sources.set",
      id: "sources-1",
      sources,
    };
    expect(JSON.parse(encodeRelayServerControlMessage(message))).toEqual(vector);
    expect(() => remoteMetricSourceSchema.parse({ ...sources[0], intervalSecs: 1 })).toThrow();
    expect(() => remoteMetricSourceSchema.parse({ ...sources[0], name: "bad name" })).toThrow();
    expect(remoteMetricSourcesSchema.parse(sources)).toHaveLength(1);
    expect(() =>
      remoteMetricSourcesSchema.parse(
        Array.from({ length: NODE_METRIC_SOURCES_MAX + 1 }, () => sources[0]),
      ),
    ).toThrow();
  });

  it("rejects extra fields anywhere in a telemetry frame", () => {
    const cases: Array<[string, (frame: Record<string, unknown>) => void]> = [
      ["node-info.json", (frame) => Object.assign(frame, { stderr: "oops" })],
      [
        "node-info.json",
        (frame) => Object.assign(frame.os as Record<string, unknown>, { hostname: "x" }),
      ],
      ["node-metrics.json", (frame) => Object.assign(frame, { prompt: "secret" })],
      [
        "node-metrics.json",
        (frame) =>
          Object.assign((frame.sources as Array<Record<string, unknown>>)[0] ?? {}, {
            stderr: "boom",
          }),
      ],
      [
        "node-metrics.json",
        (frame) =>
          Object.assign((frame.custom as Array<Record<string, unknown>>)[0] ?? {}, {
            text: "not a number",
          }),
      ],
      ["endpoint-load.json", (frame) => Object.assign(frame, { prompt: "secret" })],
      ["endpoint-load.json", (frame) => Object.assign(frame, { slots: [{ prompt: "x" }] })],
    ];
    for (const [name, mutate] of cases) {
      const frame = relay24Vector(name);
      mutate(frame);
      expect(() => parseRelayClientControlFrame(JSON.stringify(frame)), name).toThrow();
    }
  });

  it("rejects missing required fields and out-of-range values", () => {
    const load = relay24Vector("endpoint-load.json");
    for (const field of ["endpointSlug", "running", "waiting", "source", "ts"]) {
      const frame = { ...load };
      delete frame[field];
      expect(() => parseRelayClientControlFrame(JSON.stringify(frame)), field).toThrow();
    }
    for (const patch of [
      { kvUsage: 1.5 },
      { running: -1 },
      { waiting: 1.5 },
      { ts: "yesterday" },
    ]) {
      expect(() => parseRelayClientControlFrame(JSON.stringify({ ...load, ...patch }))).toThrow();
    }
    const metrics = relay24Vector("node-metrics.json");
    const withoutTs = { ...metrics };
    delete withoutTs.ts;
    expect(() => parseRelayClientControlFrame(JSON.stringify(withoutTs))).toThrow();
    for (const custom of [
      [{ source: "s", name: "bad name", value: 1, ts: "2026-09-28T12:00:00.000Z" }],
      [{ source: "s", name: "n", value: "1", ts: "2026-09-28T12:00:00.000Z" }],
      [{ source: "s", name: "n", labels: { k: "v w" }, value: 1, ts: "2026-09-28T12:00:00.000Z" }],
      Array.from({ length: 51 }, (_, index) => ({
        source: "s",
        name: `n${index}`,
        value: index,
        ts: "2026-09-28T12:00:00.000Z",
      })),
    ]) {
      expect(() => parseRelayClientControlFrame(JSON.stringify({ ...metrics, custom }))).toThrow();
    }
    // Only the frame type is required for node.info.
    expect(parseRelayClientControlFrame(JSON.stringify({ type: "node.info" }))).toEqual({
      type: "node.info",
    });
    // nvidia-smi [N/A] may arrive as null.
    expect(
      parseRelayClientControlFrame(
        JSON.stringify({ ...metrics, gpus: [{ index: 0, vramUsedMiB: null, powerW: null }] }),
      ),
    ).toMatchObject({ gpus: [{ index: 0, vramUsedMiB: null, powerW: null }] });
  });

  it("validates engine facts strictly", () => {
    const hello = relay24Vector("hello.json") as {
      endpoints: Array<{ engineFacts?: Record<string, unknown> }>;
    };
    const endpoint = hello.endpoints[0];
    if (!endpoint) throw new Error("vector endpoint");
    for (const facts of [
      { slots: 4 },
      { slots: { value: 4 } },
      { slots: { value: 4, source: "guess" } },
      { slots: { value: 0, source: "probe" } },
      { engine: { value: "tgi", source: "probe" } },
      { slots: { value: 4, source: "probe", extra: true } },
      { unknownFact: { value: 1, source: "probe" } },
    ]) {
      endpoint.engineFacts = facts;
      expect(
        () => parseRelayClientControlFrame(JSON.stringify(hello)),
        JSON.stringify(facts),
      ).toThrow();
    }
  });
});

describe("remoteMetricSourcesSchema (outbound metrics.sources.set)", () => {
  const source = {
    name: "fans",
    command: "sensors -j",
    intervalSecs: 10,
    timeoutSecs: 5,
    format: "json",
  };
  it("caps the list and rejects extra fields", async () => {
    const { remoteMetricSourcesSchema, NODE_METRIC_SOURCES_MAX } = await import("./protocol.js");
    const list = (length: number) =>
      Array.from({ length }, (_, index) => ({ ...source, name: `s${index}` }));
    expect(remoteMetricSourcesSchema.safeParse(list(NODE_METRIC_SOURCES_MAX)).success).toBe(true);
    expect(remoteMetricSourcesSchema.safeParse(list(NODE_METRIC_SOURCES_MAX + 1)).success).toBe(
      false,
    );
    expect(remoteMetricSourcesSchema.safeParse([{ ...source, stderr: "x" }]).success).toBe(false);
  });
});

describe("metrics.sources.set encoding (G2a-3) and reserved label keys (CFc-5)", () => {
  const source = {
    name: "fans",
    command: "sensors -j",
    intervalSecs: 10,
    timeoutSecs: 5,
    format: "json" as const,
  };
  const frame = (sources: unknown[]) =>
    ({ type: "metrics.sources.set", id: "sources-1", sources }) as Parameters<
      typeof encodeRelayServerControlMessage
    >[0];

  it("never frames a source list that fails the wire schema", () => {
    expect(JSON.parse(encodeRelayServerControlMessage(frame([source])))).toMatchObject({
      sources: [source],
    });
    expect(JSON.parse(encodeRelayServerControlMessage(frame([])))).toMatchObject({ sources: [] });
    const tooMany = Array.from({ length: 51 }, (_, index) => ({ ...source, name: `s${index}` }));
    for (const sources of [
      tooMany,
      [{ ...source, stderr: "x" }],
      [{ ...source, intervalSecs: 4 }],
      [{ ...source, name: "bad name" }],
      [{ ...source, command: "" }],
      // The CLI's own definition of a runnable command (bytes, NUL, blank).
      [{ ...source, command: "€".repeat(1509) }],
      [{ ...source, command: "echo\u0000 1" }],
      [{ ...source, command: "   " }],
      [{ ...source, command: "\u0085" }],
    ]) {
      expect(() => encodeRelayServerControlMessage(frame(sources))).toThrow(/wire schema/);
    }
  });

  it("rejects the reserved label key __proto__ and keeps its look-alikes", () => {
    const metrics = relay24Vector("node-metrics.json");
    const series = (labels: unknown) => [
      { source: "s", name: "n", labels, value: 1, ts: "2026-09-28T12:00:00.000Z" },
    ];
    // JSON.parse makes a real own property named __proto__.
    const reserved = JSON.parse('{"__proto__":"v"}');
    expect(Object.keys(reserved)).toEqual(["__proto__"]);
    expect(() =>
      parseRelayClientControlFrame(JSON.stringify({ ...metrics, custom: series(reserved) })),
    ).toThrow();
    for (const key of ["proto", "_proto__", "__proto", "constructor", "__proto__x"]) {
      const parsed = parseRelayClientControlFrame(
        JSON.stringify({ ...metrics, custom: series({ [key]: "v" }) }),
      );
      expect(parsed).toMatchObject({ custom: [{ labels: { [key]: "v" } }] });
    }
    // As a label VALUE it is only a string.
    expect(() =>
      parseRelayClientControlFrame(
        JSON.stringify({ ...metrics, custom: series({ k: "__proto__" }) }),
      ),
    ).not.toThrow();
  });
});
