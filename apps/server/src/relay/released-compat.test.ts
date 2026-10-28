/**
 * A released wsmp that can update itself must keep connecting to every later server, or it can
 * never be sent the next update (`apps/cli/docs/releasing.md`, "Keeping old nodes updatable").
 * `apps/cli/tests/fixtures/released/<version>/` freezes what that release sends and the frames it
 * reads; never edit a released copy to make this test pass.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { serverToNodeControlFrameSchema } from "./frames.js";
import { helloCanSelfUpdate, helloNeedsUpgrade, parseRelayClientControlFrame } from "./protocol.js";

const FIXTURES = fileURLToPath(new URL("../../../cli/tests/fixtures/", import.meta.url));
const RELEASES = readdirSync(join(FIXTURES, "released")).sort();

/** The frames wsmp reads with unknown fields dropped (`OPEN_FRAMES` in `apps/cli/src/protocol.rs`). */
const OPEN_FRAMES = [
  "agent.update",
  "agent.update.ack",
  "heartbeat.pong",
  "hello.challenge",
  "hello.ok",
  "protocol.error",
  "trust.lower",
];

/**
 * Fixed-value fields of those frames and the values every released wsmp reads. `protocol.error`'s
 * `code` is left out: wsmp reads a code it does not know as a generic error.
 */
const READ_VALUES: Record<string, Record<string, readonly string[]>> = {
  "hello.ok": { protocolVersion: ["3.0"], definitionSync: ["expect", "none"] },
  "protocol.error": { failure: ["protocol_error"] },
};

function load(dir: string): Array<[string, Record<string, unknown>]> {
  const path = join(FIXTURES, dir);
  return readdirSync(path)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => [name, JSON.parse(readFileSync(join(path, name), "utf8"))]);
}

function outgoingSchema(type: string): z.ZodObject {
  for (const option of serverToNodeControlFrameSchema.options) {
    const objects = option instanceof z.ZodObject ? [option] : option.options;
    for (const object of objects) {
      if (object.shape.type.value === type) return object;
    }
  }
  throw new Error(`the server sends no ${type}`);
}

/** The values a fixed-value field may take, or undefined for a free one. */
function fixedValues(schema: z.ZodType): string[] | undefined {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return fixedValues(schema.unwrap() as z.ZodType);
  }
  if (schema instanceof z.ZodEnum) return schema.options.map(String);
  if (schema instanceof z.ZodLiteral) return [...schema.values].map(String);
  return undefined;
}

describe.each(RELEASES)("wsmp %s keeps connecting", (release) => {
  const frozen = `released/${release}`;

  it.each(load(`${frozen}/node-to-server`))("accepts its %s", (name, frame) => {
    const raw = JSON.stringify(frame);
    const parsed = parseRelayClientControlFrame(raw);
    if (parsed.type === "hello") {
      expect(helloNeedsUpgrade(raw), name).toBe(false);
      expect(helloCanSelfUpdate(parsed), name).toBe(true);
    }
  });

  it("freezes every frame it reads leniently", () => {
    const types = load(`${frozen}/server-to-node`).map(([, frame]) => frame.type);
    expect(types.sort()).toEqual(OPEN_FRAMES);
  });

  it.each(load(`${frozen}/server-to-node`))(
    "still gets the fields it reads in %s",
    (name, frozenFrame) => {
      // Today's frame with the released fields on top: a field the release reads that was
      // removed, renamed or retyped fails the strict schema; a field added since is ignored.
      const current = load("relay-3.0/frames/server-to-node").find(([other]) => other === name);
      expect(current, `relay-3.0 has no ${name}`).toBeDefined();
      const merged = { ...current?.[1], ...frozenFrame };
      const checked = serverToNodeControlFrameSchema.safeParse(merged);
      expect(checked.error?.issues ?? [], name).toEqual([]);
    },
  );

  it("is sent only values it reads", () => {
    for (const [type, fields] of Object.entries(READ_VALUES)) {
      const shape = outgoingSchema(type).shape as Record<string, z.ZodType>;
      for (const [field, readable] of Object.entries(fields)) {
        const fieldSchema = shape[field];
        expect(fieldSchema, `${type}.${field}`).toBeDefined();
        const sent = fieldSchema ? fixedValues(fieldSchema) : undefined;
        expect(sent, `${type}.${field} is no longer a fixed value`).toBeDefined();
        for (const value of sent ?? []) {
          expect(readable, `${type}.${field} = ${value}`).toContain(value);
        }
      }
    }
  });
});
