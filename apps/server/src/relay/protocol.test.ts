import { describe, expect, it } from "vitest";
import { sanitizeRelayRequestHeaders } from "./headers.js";
import {
  describeRelayControlParseError,
  encodeRelayBinaryFrame,
  encodeRelayServerControlMessage,
  helloNeedsUpgrade,
  parseRelayBinaryFrame,
  parseRelayClientControlFrame,
  parseRelaySubprotocolHeader,
  RELAY_BINARY_CHUNK_MAX_BYTES,
  RELAY_MIN_PROTOCOL_VERSION,
  RELAY_PROTOCOL_VERSIONS,
  RELAY_SUBPROTOCOL,
  RELAY_UPGRADE_REQUIRED_MESSAGE,
  relayProtocolAtLeast,
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

const CAPABILITIES_26 = {
  protocolVersion: "2.6",
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
    mcpCommandMode: "supervised",
    terminalApproval: false,
    terminalSupported: true,
  },
  terminalPublicKey: uncompressedKey(),
  terminalViewers: true,
  supervisedCommands: true,
};

function hello(protocolVersion: string, capabilities: unknown) {
  return JSON.stringify({
    type: "hello",
    id: "hello-id",
    protocolVersion,
    cli: { slug: "desktop", hostname: "desk-01.local", version: "0.4.0", capabilities },
    endpoints: [endpoint()],
  });
}

function helloWithCli(cli: Record<string, unknown>) {
  return JSON.stringify({
    type: "hello",
    id: "hello-id",
    protocolVersion: "2.6",
    cli: {
      slug: "desktop",
      capabilities: CAPABILITIES_26,
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

describe("relay protocol 2.6 minimum", () => {
  it("speaks only 2.6 and names the first wsmp that does in the upgrade message", () => {
    expect(RELAY_PROTOCOL_VERSIONS).toEqual(["2.6"]);
    expect(RELAY_MIN_PROTOCOL_VERSION).toBe("2.6");
    expect(RELAY_UPGRADE_REQUIRED_MESSAGE).toContain("wsmp 0.4.0 or newer");
    expect(RELAY_UPGRADE_REQUIRED_MESSAGE).toContain("Upgrade wsmp");
  });

  it("flags every older hello, and the pre-naming label field, before schema parsing", () => {
    for (const version of ["2.0", "2.3", "2.4", "2.5"]) {
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
    expect(helloNeedsUpgrade(hello("2.6", { ...CAPABILITIES_26, protocolVersion: "2.5" }))).toBe(
      true,
    );
    expect(helloNeedsUpgrade(hello("2.6", CAPABILITIES_26))).toBe(false);
    expect(helloNeedsUpgrade(JSON.stringify({ type: "heartbeat", id: "x" }))).toBe(false);
    expect(helloNeedsUpgrade("not json")).toBe(false);
  });

  it("parses a 2.6 hello and refuses older or loose capability shapes", () => {
    expect(parseRelayClientControlFrame(hello("2.6", CAPABILITIES_26))).toMatchObject({
      type: "hello",
      protocolVersion: "2.6",
      cli: {
        capabilities: {
          supervisedCommands: true,
          features: { mcpCommandMode: "supervised" },
        },
      },
    });
    const withConcurrency = JSON.parse(hello("2.6", CAPABILITIES_26)) as {
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
      { ...CAPABILITIES_26, supervisedCommands: false },
      { ...CAPABILITIES_26, terminalViewers: false },
      { ...CAPABILITIES_26, extra: true },
      { ...CAPABILITIES_26, terminalPublicKey: uncompressedKey(0x02) },
      {
        ...CAPABILITIES_26,
        features: { ...CAPABILITIES_26.features, mcpCommandMode: "always" },
      },
      {
        ...CAPABILITIES_26,
        features: {
          humanTerminal: true,
          mcpCommands: true,
          terminalApproval: false,
          terminalSupported: true,
        },
      },
    ];
    for (const capabilities of bad) {
      expect(() => parseRelayClientControlFrame(hello("2.6", capabilities))).toThrow();
    }
    expect(() =>
      parseRelayClientControlFrame(hello("2.5", { ...CAPABILITIES_26, protocolVersion: "2.5" })),
    ).toThrow();
  });

  it("accepts an optional, strict terminalIdentity", () => {
    const identityKey = Buffer.alloc(65, 3);
    identityKey[0] = 0x04;
    const terminalIdentity = {
      publicKey: identityKey.toString("base64url"),
      signature: Buffer.alloc(64, 7).toString("base64url"),
    };
    expect(
      parseRelayClientControlFrame(hello("2.6", { ...CAPABILITIES_26, terminalIdentity })),
    ).toMatchObject({ cli: { capabilities: { terminalIdentity } } });
    for (const bad of [
      { publicKey: terminalIdentity.publicKey },
      { ...terminalIdentity, signature: Buffer.alloc(63, 7).toString("base64url") },
      { ...terminalIdentity, extra: true },
    ]) {
      expect(() =>
        parseRelayClientControlFrame(hello("2.6", { ...CAPABILITIES_26, terminalIdentity: bad })),
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
