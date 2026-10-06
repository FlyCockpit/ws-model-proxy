import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "@ws-model-proxy/api/lib/canonical-json";
import {
  nodeMetricCommandsHash,
  runtimeLaunchHash,
} from "@ws-model-proxy/api/lib/runtime-launch-hash";
import { runtimeSpecSchema } from "@ws-model-proxy/api/lib/runtime-spec";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  NODE_TO_SERVER_CONTROL_TYPES,
  nodeToServerBinaryMetadataSchema,
  nodeToServerControlFrameSchema,
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
    const define = serverToNode.find(([name]) => name === "runtime.define.json")?.[1];
    const put = (define?.put ?? []) as Array<{ launchHash: string; spec: unknown }>;
    expect(put.length).toBeGreaterThan(0);
    for (const envelope of put)
      expect(runtimeLaunchHash(runtimeSpecSchema.parse(envelope.spec))).toBe(envelope.launchHash);
    const node = define?.node as { metricCommands: { hash: string; commands: never[] } };
    expect(nodeMetricCommandsHash(node.metricCommands.commands)).toBe(node.metricCommands.hash);
    const inventory = nodeToServer.find(([name]) => name === "runtime.inventory.json")?.[1];
    for (const entry of (inventory?.alwaysOn ?? []) as Array<{
      launchHash: string;
      spec?: unknown;
    }>)
      if (entry.spec)
        expect(runtimeLaunchHash(runtimeSpecSchema.parse(entry.spec))).toBe(entry.launchHash);
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
