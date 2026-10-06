import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  binaryFrameTarget,
  describeRelayControlParseError,
  encodeRelayBinaryFrame,
  encodeRelayServerControlMessage,
  frameForLog,
  helloNeedsUpgrade,
  parseRelayBinaryFrame,
  parseRelayClientControlFrame,
  parseRelaySubprotocolHeader,
  RELAY_JSON_CONTROL_MAX_BYTES,
  RELAY_PROTOCOL_VERSION,
  RELAY_SUBPROTOCOL,
  RelayProtocolError,
  refusedRelayProtocolReason,
  rejectedHelloFacts,
  type ServerBinaryMetadata,
  type ServerToNodeControlFrame,
} from "./protocol.js";

const FIXTURES = fileURLToPath(new URL("../../../cli/tests/fixtures/relay-3.0/", import.meta.url));

function load(dir: string): Array<[string, Record<string, unknown>]> {
  const path = join(FIXTURES, dir);
  return readdirSync(path)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => [name, JSON.parse(readFileSync(join(path, name), "utf8"))]);
}

/** Every string value of a fixture, to prove an error text echoes none of them. */
function stringValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string" && value.length >= 6) out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringValues(item, out);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) stringValues(item, out);
  return out;
}

function nodeBinaryFrame(metadata: Record<string, unknown>, body: Uint8Array): ArrayBuffer {
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  const frame = new Uint8Array(4 + metadataBytes.byteLength + body.byteLength);
  new DataView(frame.buffer).setUint32(0, metadataBytes.byteLength, false);
  frame.set(metadataBytes, 4);
  frame.set(body, 4 + metadataBytes.byteLength);
  return frame.buffer;
}

describe("relay 3.0 codec", () => {
  it("speaks exactly 3.0 on the v3 subprotocol", () => {
    expect(RELAY_PROTOCOL_VERSION).toBe("3.0");
    expect(RELAY_SUBPROTOCOL).toBe("ws-model-proxy.relay.v3");
    expect(parseRelaySubprotocolHeader("ws-model-proxy.relay.v3").supported).toBe(true);
    expect(parseRelaySubprotocolHeader("ws-model-proxy.relay.v2").supported).toBe(false);
    expect(parseRelaySubprotocolHeader(undefined).ok).toBe(false);
  });

  it("parses every node → server fixture unchanged", () => {
    for (const [name, frame] of load("frames/node-to-server")) {
      expect(parseRelayClientControlFrame(JSON.stringify(frame)), name).toEqual(frame);
    }
  });

  it("encodes every server → node fixture unchanged", () => {
    for (const [name, frame] of load("frames/server-to-node")) {
      const encoded = encodeRelayServerControlMessage(frame as ServerToNodeControlFrame);
      expect(JSON.parse(encoded), name).toEqual(frame);
    }
  });

  it("refuses every invalid node frame, describing paths and codes only", () => {
    for (const [name, frame] of load("invalid/node-to-server")) {
      let thrown: unknown;
      try {
        parseRelayClientControlFrame(JSON.stringify(frame));
      } catch (error) {
        thrown = error;
      }
      expect(thrown, name).toBeDefined();
      const description = JSON.stringify(describeRelayControlParseError(thrown));
      for (const value of stringValues(frame)) {
        if (value === frame.type) continue;
        expect(description.includes(value), `${name} echoes ${value}`).toBe(false);
      }
    }
  });

  it("refuses to encode every invalid server frame without echoing values", () => {
    for (const [name, frame] of load("invalid/server-to-node")) {
      let thrown: unknown;
      try {
        encodeRelayServerControlMessage(frame as ServerToNodeControlFrame);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, name).toBeInstanceOf(RelayProtocolError);
      const message = (thrown as Error).message;
      for (const value of stringValues(frame)) {
        if (value === frame.type) continue;
        expect(message.includes(value), `${name} echoes ${value}`).toBe(false);
      }
    }
  });

  it("caps control frames at 64 KiB", () => {
    const oversize = JSON.stringify({
      type: "heartbeat",
      id: "x".repeat(RELAY_JSON_CONTROL_MAX_BYTES),
    });
    let thrown: unknown;
    try {
      parseRelayClientControlFrame(oversize);
    } catch (error) {
      thrown = error;
    }
    expect(describeRelayControlParseError(thrown)).toEqual({ kind: "oversize" });
    expect(describeRelayControlParseError(new SyntaxError("x"))).toEqual({ kind: "json" });
  });

  it("tells a non-3.0 hello apart and keeps only version-shaped facts", () => {
    const old = JSON.stringify({
      type: "hello",
      id: "h1",
      protocolVersion: "2.9",
      cli: { slug: "box", version: "0.3.9" },
    });
    expect(helloNeedsUpgrade(old)).toBe(true);
    expect(rejectedHelloFacts(old)).toEqual({ protocolVersion: "2.9", cliVersion: "0.3.9" });
    const [, hello] = load("frames/node-to-server").find(([name]) => name === "hello.json") ?? [];
    expect(helloNeedsUpgrade(JSON.stringify(hello))).toBe(false);
    expect(
      rejectedHelloFacts(
        JSON.stringify({ type: "hello", protocolVersion: "evil text", node: { version: "x y" } }),
      ),
    ).toEqual({ protocolVersion: null, cliVersion: null });
    expect(refusedRelayProtocolReason("2.9")).toBe("cli_too_old");
    expect(refusedRelayProtocolReason("3.1")).toBe("cli_too_new");
    expect(refusedRelayProtocolReason("4.0")).toBe("cli_too_new");
    expect(refusedRelayProtocolReason(null)).toBe("cli_too_old");
  });

  it("redacts secret values for logs", () => {
    const [, secret] =
      load("frames/server-to-node").find(([name]) => name === "secret.set.json") ?? [];
    const logged = JSON.stringify(frameForLog(secret as ServerToNodeControlFrame));
    expect(logged.includes(String(secret?.value))).toBe(false);
  });

  it("encodes server binary metadata and parses node binary metadata", () => {
    for (const [name, metadata] of load("binary/server-to-node")) {
      const body = new Uint8Array(metadata.type === "stt.audio" ? 4096 : 3);
      const frame = encodeRelayBinaryFrame(metadata as ServerBinaryMetadata, body);
      const length = new DataView(frame).getUint32(0, false);
      const text = new TextDecoder().decode(new Uint8Array(frame, 4, length));
      expect(JSON.parse(text), name).toEqual(metadata);
    }
    for (const [name, metadata] of load("binary/node-to-server")) {
      const parsed = parseRelayBinaryFrame(nodeBinaryFrame(metadata, new Uint8Array([1, 2])));
      expect(parsed.metadata, name).toEqual(metadata);
      expect([...parsed.body]).toEqual([1, 2]);
    }
  });

  it("refuses server-only binary metadata from a node and still names its target", () => {
    const frame = nodeBinaryFrame(
      { type: "file.body", opId: "aI2y1_whRmuQtdr_JElukw" },
      new Uint8Array(1),
    );
    expect(() => parseRelayBinaryFrame(frame)).toThrow();
    expect(binaryFrameTarget(frame)).toEqual({ type: "file.body", opId: "aI2y1_whRmuQtdr_JElukw" });
    expect(binaryFrameTarget(new ArrayBuffer(2))).toBeNull();
  });
});
