import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "@ws-model-proxy/api/lib/canonical-json";
import {
  nodeFabricsHash,
  nodeMetricCommandsHash,
  runtimeLaunchHash,
} from "@ws-model-proxy/api/lib/runtime-launch-hash";
import {
  canonicalBytes,
  nodeMetricCommandsSchema,
  RUNTIME_SPEC_MAX_BYTES,
  runtimeSpecSchema,
} from "@ws-model-proxy/api/lib/runtime-spec";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  NODE_TO_SERVER_CONTROL_TYPES,
  nodeToServerBinaryMetadataSchema,
  nodeToServerControlFrameSchema,
  REDACTED_SECRET_VALUE,
  RELAY_JSON_CONTROL_MAX_BYTES,
  redactFrameForLog,
  SERVER_TO_NODE_CONTROL_TYPES,
  serverToNodeBinaryMetadataSchema,
  serverToNodeControlFrameSchema,
} from "./frames.js";

const FIXTURES = fileURLToPath(new URL("../../../cli/tests/fixtures/relay-3.0/", import.meta.url));

function load(dir: string): Array<[string, Record<string, unknown>]> {
  const path = join(FIXTURES, dir);
  return readdirSync(path)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => [name, JSON.parse(readFileSync(join(path, name), "utf8"))]);
}

function expectValid(schema: z.ZodType, frames: Array<[string, Record<string, unknown>]>) {
  for (const [name, frame] of frames) {
    const parsed = schema.safeParse(frame);
    expect(parsed.success ? null : { name, issues: parsed.error.issues }).toBeNull();
    // Strict schemas transform nothing: the parsed frame is the fixture.
    if (parsed.success) expect(parsed.data, name).toEqual(frame);
  }
}

describe("relay 3.0 frames", () => {
  const nodeToServer = load("frames/node-to-server");
  const serverToNode = load("frames/server-to-node");

  it("parses every node → server fixture", () => {
    expectValid(nodeToServerControlFrameSchema, nodeToServer);
  });

  it("parses every server → node fixture", () => {
    expectValid(serverToNodeControlFrameSchema, serverToNode);
  });

  it("has a fixture for every frame type", () => {
    const seen = (frames: Array<[string, Record<string, unknown>]>) =>
      new Set(frames.map(([, frame]) => frame.type));
    expect([...NODE_TO_SERVER_CONTROL_TYPES].filter((t) => !seen(nodeToServer).has(t))).toEqual([]);
    expect([...SERVER_TO_NODE_CONTROL_TYPES].filter((t) => !seen(serverToNode).has(t))).toEqual([]);
  });

  it("parses binary metadata in both directions", () => {
    expectValid(serverToNodeBinaryMetadataSchema, load("binary/server-to-node"));
    expectValid(nodeToServerBinaryMetadataSchema, load("binary/node-to-server"));
  });

  it("refuses the invalid fixtures", () => {
    for (const [name, frame] of load("invalid/server-to-node"))
      expect(serverToNodeControlFrameSchema.safeParse(frame).success, name).toBe(false);
    for (const [name, frame] of load("invalid/node-to-server"))
      expect(nodeToServerControlFrameSchema.safeParse(frame).success, name).toBe(false);
  });

  it("names the launch hash of every spec it carries", () => {
    const defines = serverToNode.filter(([, frame]) => frame.type === "runtime.define");
    const put = defines.flatMap(
      ([, frame]) => (frame.put ?? []) as Array<{ launchHash: string; spec: unknown }>,
    );
    expect(put.length).toBeGreaterThan(1);
    for (const envelope of put)
      expect(runtimeLaunchHash(runtimeSpecSchema.parse(envelope.spec))).toBe(envelope.launchHash);
    const node = defines.find(([, frame]) => frame.node)?.[1].node as {
      metricCommands: { hash: string; commands: never[] };
    };
    expect(nodeMetricCommandsHash(node.metricCommands.commands)).toBe(node.metricCommands.hash);
    const inventory = nodeToServer.find(([name]) => name === "runtime.inventory.json")?.[1];
    for (const entry of (inventory?.alwaysOn ?? []) as Array<{
      launchHash: string;
      spec?: unknown;
    }>)
      if (entry.spec)
        expect(runtimeLaunchHash(runtimeSpecSchema.parse(entry.spec))).toBe(entry.launchHash);
  });

  it("never transforms what it parses (the server hashes the parsed spec, the node the raw one)", () => {
    const sets = [
      [nodeToServerControlFrameSchema, nodeToServer],
      [serverToNodeControlFrameSchema, serverToNode],
    ] as const;
    for (const [schema, frames] of sets)
      for (const [name, frame] of frames)
        expect(canonicalJson(schema.parse(frame)), name).toBe(canonicalJson(frame));
    const padded = structuredClone(
      serverToNode.find(([name]) => name === "runtime.define.json")?.[1].put,
    ) as Array<{ spec: { models: Array<{ embeddingContract: { model: string } }> } }>;
    const spec = padded[0]?.spec;
    if (!spec?.models[0]) throw new Error("fixture changed");
    spec.models[0].embeddingContract.model = " BAAI/bge-m3 ";
    expect(runtimeSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("enforces the byte caps one frame relies on", () => {
    const define = serverToNode.find(([name]) => name === "runtime.define-chunk.json")?.[1];
    const put = (define?.put ?? []) as Array<{ spec: unknown }>;
    const spec = structuredClone(put[0]?.spec) as {
      launch: { commands: Array<{ start: string }>; groupSize: number };
      models: Array<{ id: string }>;
    };
    // Fill the spec up to just over 48 KiB with valid model ids.
    spec.models = Array.from({ length: 64 }, (_, index) => ({
      id: `m${index}-${"x".repeat(200)}`,
    }));
    spec.launch.commands = Array.from({ length: 16 }, () => ({
      ...spec.launch.commands[0],
      start: `run ${"y".repeat(4_000)}`,
    })) as typeof spec.launch.commands;
    spec.launch.groupSize = 16;
    const bytes = canonicalBytes(spec) ?? 0;
    expect(bytes).toBeGreaterThan(RUNTIME_SPEC_MAX_BYTES);
    expect(runtimeSpecSchema.safeParse(spec).success).toBe(false);

    const command = {
      name: "c",
      command: `echo ${"z".repeat(4_000)}`,
      intervalSecs: 30,
      timeoutSecs: 5,
      format: "lines",
    };
    const commands = Array.from({ length: 9 }, (_, index) => ({ ...command, name: `c${index}` }));
    expect(nodeMetricCommandsSchema.safeParse(commands).success).toBe(false);
    expect(nodeMetricCommandsSchema.safeParse(commands.slice(0, 7)).success).toBe(true);
  });

  it("fits the largest final define answer in one frame", () => {
    const id = "x".repeat(64);
    const answer = {
      type: "runtime.define.result",
      opId: "o".repeat(128),
      chunkIndex: 128,
      final: true,
      results: Array.from({ length: 64 }, () => ({
        runtimeId: id,
        versionId: id,
        status: "rejected",
        reason: "base_url_not_allowed",
        detail: "d".repeat(128),
      })),
      node: { status: "rejected", reason: "base_url_not_allowed" },
      held: Array.from({ length: 128 }, () => ({
        runtimeId: id,
        versionId: id,
        launchHash: "a".repeat(64),
      })),
      heldMetricCommandsHash: "a".repeat(64),
      heldPortRange: [30000, 30999],
      frozen: false,
    };
    expect(new TextEncoder().encode(JSON.stringify(answer)).byteLength).toBeLessThan(
      RELAY_JSON_CONTROL_MAX_BYTES,
    );
  });

  it("keeps every frame fixture under the 64 KiB control cap", () => {
    for (const [name, frame] of [...nodeToServer, ...serverToNode])
      expect(new TextEncoder().encode(JSON.stringify(frame)).byteLength, name).toBeLessThan(
        RELAY_JSON_CONTROL_MAX_BYTES,
      );
  });
});

describe("canonical JSON vectors", () => {
  const vectors = JSON.parse(readFileSync(join(FIXTURES, "canonical/vectors.json"), "utf8")) as {
    valid: Array<{ name: string; json: string; canonical: string; sha256: string }>;
    invalid: Array<{ name: string; json: string }>;
  };

  it("matches every valid vector", async () => {
    const { createHash } = await import("node:crypto");
    for (const vector of vectors.valid) {
      const canonical = canonicalJson(JSON.parse(vector.json));
      expect(canonical, vector.name).toBe(vector.canonical);
      expect(createHash("sha256").update(canonical, "utf8").digest("hex"), vector.name).toBe(
        vector.sha256,
      );
    }
  });

  it("refuses every invalid vector", () => {
    for (const vector of vectors.invalid)
      expect(() => canonicalJson(JSON.parse(vector.json)), vector.name).toThrow();
  });
});

describe("node secrets and fabrics on the wire", () => {
  const serverToNode = load("frames/server-to-node");
  const secretSet = serverToNode.find(([name]) => name === "secret.set.json")?.[1];

  it("never logs a secret value", () => {
    if (!secretSet) throw new Error("missing secret.set fixture");
    const frame = serverToNodeControlFrameSchema.parse(secretSet);
    const logged = JSON.stringify(redactFrameForLog(frame));
    expect(logged).not.toContain(String(secretSet.value));
    expect(logged).toContain(REDACTED_SECRET_VALUE);
    // A refused parse describes the path, never the value.
    const refused = serverToNodeControlFrameSchema.safeParse({ ...secretSet, name: "HOME" });
    expect(refused.success).toBe(false);
    expect(JSON.stringify(refused.error?.issues)).not.toContain(String(secretSet.value));
    // Other frames pass through unchanged.
    const heartbeat = { type: "heartbeat", id: "hb-1" };
    expect(redactFrameForLog(heartbeat)).toBe(heartbeat);
  });

  it("hashes the fabric sets the define frame carries", () => {
    const define = serverToNode.find(([name]) => name === "runtime.define.json")?.[1];
    const parsed = serverToNodeControlFrameSchema.parse(define);
    if (parsed.type !== "runtime.define" || !parsed.node) throw new Error("no node part");
    expect(nodeFabricsHash(parsed.node.fabrics.sets)).toBe(parsed.node.fabrics.hash);
  });
});

describe("relay.request methods", () => {
  it("relays DELETE (stored Responses objects) as well as GET and POST", () => {
    const frame = JSON.parse(
      readFileSync(join(FIXTURES, "frames/server-to-node/relay.request.json"), "utf8"),
    ) as Record<string, unknown>;
    for (const method of ["GET", "POST", "DELETE"])
      expect(serverToNodeControlFrameSchema.safeParse({ ...frame, method }).success, method).toBe(
        true,
      );
    expect(serverToNodeControlFrameSchema.safeParse({ ...frame, method: "PUT" }).success).toBe(
      false,
    );
  });
});
