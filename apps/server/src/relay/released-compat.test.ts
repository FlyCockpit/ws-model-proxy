/**
 * A released wsmp keeps working with every later server: the owner's server may run `master`
 * while nodes run the last release, and a node that cannot connect can never be sent the next
 * update (`apps/cli/docs/releasing.md`, "Keeping old nodes updatable").
 * `apps/cli/tests/fixtures/released/<version>/` freezes every frame and binary metadata that
 * release sends and reads, and the fixed values the server sent then
 * (`scripts/freeze-relay-release.ts`). Never edit a released copy to make this test pass.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { serverToNodeFixedValues } from "./fixed-values.js";
import { serverToNodeBinaryMetadataSchema, serverToNodeControlFrameSchema } from "./frames.js";
import {
  helloCanSelfUpdate,
  helloNeedsUpgrade,
  parseRelayBinaryFrame,
  parseRelayClientControlFrame,
} from "./protocol.js";

const FIXTURES = fileURLToPath(new URL("../../../cli/tests/fixtures/", import.meta.url));
const RELEASES = readdirSync(join(FIXTURES, "released")).sort();

/**
 * Fixed-value fields a released wsmp reads leniently (an unknown value becomes a generic one),
 * and runtime definitions, which it refuses part by part without ending the session.
 */
const NEW_VALUES_ALLOWED = [
  "protocol.error.code",
  "protocol.error.failure",
  "relay.cancel.reason",
  "stt.close.reason",
  "runtime.job.operator.commandAuthor",
  "runtime.define.put[].",
  "runtime.define.node.",
];

function load(dir: string): Array<[string, Record<string, unknown>]> {
  const path = join(FIXTURES, dir);
  return readdirSync(path)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => [name, JSON.parse(readFileSync(join(path, name), "utf8"))]);
}

function binaryFrame(metadata: Record<string, unknown>): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify(metadata));
  const frame = new Uint8Array(4 + bytes.byteLength + 1);
  new DataView(frame.buffer).setUint32(0, bytes.byteLength, false);
  frame.set(bytes, 4);
  return frame.buffer;
}

describe.each(RELEASES)("wsmp %s keeps working", (release) => {
  const frozen = `released/${release}`;

  it.each(load(`${frozen}/frames/node-to-server`))("accepts its %s", (name, frame) => {
    const raw = JSON.stringify(frame);
    const parsed = parseRelayClientControlFrame(raw);
    if (parsed.type === "hello") {
      expect(helloNeedsUpgrade(raw), name).toBe(false);
      expect(helloCanSelfUpdate(parsed), name).toBe(true);
    }
  });

  it.each(load(`${frozen}/binary/node-to-server`))("accepts its binary %s", (_, metadata) => {
    expect(parseRelayBinaryFrame(binaryFrame(metadata)).metadata).toEqual(metadata);
  });

  // Today's frame with the released fields on top: a field the release reads that was removed,
  // renamed or retyped fails the strict schema; a field added since is ignored by the node.
  it.each(load(`${frozen}/frames/server-to-node`))(
    "still sends the fields it reads in %s",
    (name, frozenFrame) => {
      const current = load("relay-3.0/frames/server-to-node").find(([other]) => other === name);
      expect(current, `relay-3.0 has no ${name}`).toBeDefined();
      const checked = serverToNodeControlFrameSchema.safeParse({ ...current?.[1], ...frozenFrame });
      expect(checked.error?.issues ?? [], name).toEqual([]);
    },
  );

  it.each(load(`${frozen}/binary/server-to-node`))(
    "still sends the fields it reads in binary %s",
    (name, frozenMetadata) => {
      const current = load("relay-3.0/binary/server-to-node").find(([other]) => other === name);
      expect(current, `relay-3.0 has no binary ${name}`).toBeDefined();
      const checked = serverToNodeBinaryMetadataSchema.safeParse({
        ...current?.[1],
        ...frozenMetadata,
      });
      expect(checked.error?.issues ?? [], name).toEqual([]);
    },
  );

  it("is sent only values it reads", () => {
    const readable = JSON.parse(
      readFileSync(join(FIXTURES, frozen, "server-to-node-values.json"), "utf8"),
    ) as Record<string, string[]>;
    const sent = serverToNodeFixedValues();
    const unreadable: string[] = [];
    for (const [path, values] of Object.entries(readable)) {
      if (NEW_VALUES_ALLOWED.some((allowed) => path === allowed || path.startsWith(allowed)))
        continue;
      // A field removed since is the merge tests' finding.
      for (const value of sent[path] ?? []) {
        if (!values.includes(value)) unreadable.push(`${path} = ${value}`);
      }
    }
    expect(unreadable).toEqual([]);
  });
});
