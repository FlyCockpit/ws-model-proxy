import { readFileSync } from "node:fs";
import { coarseCapabilitiesFromOpenAi } from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import { DEPLOYMENT_PROTOCOL_VERSION } from "@ws-model-proxy/config/deployment-protocol";
import { describe, expect, it } from "vitest";
import {
  encodeRelayServerControlMessage,
  type OpenAiCompatibleCapabilities,
  parseRelayClientControlFrame,
  RELAY_PROTOCOL_VERSIONS,
} from "../relay/protocol.js";

const golden: { protocolVersion: string; empty: unknown[]; nonempty: unknown[] } = JSON.parse(
  readFileSync(
    new URL("../../../cli/tests/fixtures/relay-current/deployment-inventory.json", import.meta.url),
    "utf8",
  ),
);

describe("current Rust deployment encoder / Node decoder golden", () => {
  it("accepts the exact production Rust encoder's empty and nonempty snapshots", () => {
    expect(RELAY_PROTOCOL_VERSIONS).toEqual([golden.protocolVersion]);
    expect(DEPLOYMENT_PROTOCOL_VERSION).toBe(golden.protocolVersion);
    for (const input of [...golden.empty, ...golden.nonempty]) {
      expect(parseRelayClientControlFrame(JSON.stringify(input))).toEqual(input);
    }
  });
  it("rejects malformed snapshot identities, unknown fields, and invalid records", () => {
    const input = golden.nonempty[0] as Record<string, unknown>;
    for (const change of [
      { snapshotId: "old" },
      { unknown: true },
      { chunkIndex: -1 },
      { instances: [{ instanceId: "fixture" }] },
    ])
      expect(() => parseRelayClientControlFrame(JSON.stringify({ ...input, ...change }))).toThrow();
  });
  it("encodes only bounded durable acknowledgement identities", () => {
    expect(
      JSON.parse(
        encodeRelayServerControlMessage({
          type: "deployment.instances.ok",
          snapshotId: "A".repeat(32),
        }),
      ),
    ).toEqual({ type: "deployment.instances.ok", snapshotId: "A".repeat(32) });
    expect(() =>
      encodeRelayServerControlMessage({ type: "deployment.instances.ok", snapshotId: "old" }),
    ).toThrow();
  });
});

describe("current Rust transcription endpoint / Node inventory golden", () => {
  const endpoint: { defaultCapabilities: OpenAiCompatibleCapabilities } = JSON.parse(
    readFileSync(
      new URL(
        "../../../cli/tests/fixtures/relay-current/transcription-endpoint.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );

  it("accepts the exact speech-to-text endpoint a transcription recipe advertises", () => {
    const frame = { type: "inventory.update", id: "stt", endpoints: [endpoint] };
    // A rejected inventory would close the whole CLI connection as malformed.
    expect(() => parseRelayClientControlFrame(JSON.stringify(frame))).not.toThrow();
    expect(coarseCapabilitiesFromOpenAi(endpoint.defaultCapabilities)).toEqual(["AUDIO_INPUT"]);
  });
});
