/**
 * The fixed-value fields (enums and literals) of every frame the server sends, by path, so a
 * release can freeze what its wsmp reads and CI can catch a later server sending a value it
 * cannot (`apps/cli/docs/releasing.md`, "Keeping old nodes updatable").
 */
import type { z } from "zod";
import { serverToNodeBinaryMetadataSchema, serverToNodeControlFrameSchema } from "./frames.js";

type Def = { type: string } & Record<string, unknown>;

function defOf(schema: unknown): Def {
  return (schema as { _zod: { def: Def } })._zod.def;
}

function walk(schema: unknown, path: string, out: Map<string, Set<string>>, depth: number) {
  // Recursive schemas (`z.lazy`) stop here; no frame nests this deep.
  if (depth > 24) return;
  const def = defOf(schema);
  const add = (values: readonly unknown[]) => {
    const set = out.get(path) ?? new Set<string>();
    for (const value of values) set.add(String(value));
    out.set(path, set);
  };
  switch (def.type) {
    case "enum":
      add(Object.values(def.entries as Record<string, string | number>));
      return;
    case "literal":
      add(def.values as readonly unknown[]);
      return;
    case "object":
      for (const [key, field] of Object.entries(def.shape as Record<string, unknown>)) {
        walk(field, `${path}.${key}`, out, depth + 1);
      }
      return;
    case "union":
      for (const option of def.options as readonly unknown[]) walk(option, path, out, depth + 1);
      return;
    case "array":
      walk(def.element, `${path}[]`, out, depth + 1);
      return;
    case "tuple":
      for (const item of def.items as readonly unknown[]) walk(item, `${path}[]`, out, depth + 1);
      return;
    case "record":
      walk(def.valueType, `${path}{}`, out, depth + 1);
      return;
    case "pipe":
      walk(def.in, path, out, depth + 1);
      return;
    case "lazy":
      walk((def.getter as () => unknown)(), path, out, depth + 1);
      return;
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "readonly":
    case "catch":
    case "nonoptional":
      walk(def.innerType, path, out, depth + 1);
      return;
    default:
      return;
  }
}

function framesOf(schema: z.ZodDiscriminatedUnion): z.ZodObject[] {
  return schema.options.flatMap((option) =>
    defOf(option).type === "union"
      ? framesOf(option as z.ZodDiscriminatedUnion)
      : [option as z.ZodObject],
  );
}

/**
 * `<frame type>.<field path>` → its sorted values, for control frames and (prefixed `binary:`)
 * binary metadata. `[]` marks an array element, `{}` a record value; a frame's own `type` is
 * left out.
 */
export function serverToNodeFixedValues(): Record<string, string[]> {
  const out = new Map<string, Set<string>>();
  const sources: Array<[string, z.ZodDiscriminatedUnion]> = [
    ["", serverToNodeControlFrameSchema as unknown as z.ZodDiscriminatedUnion],
    ["binary:", serverToNodeBinaryMetadataSchema as unknown as z.ZodDiscriminatedUnion],
  ];
  for (const [prefix, union] of sources) {
    for (const frame of framesOf(union)) {
      const type = `${prefix}${String((defOf(frame.shape.type).values as readonly unknown[])[0])}`;
      for (const [key, field] of Object.entries(frame.shape)) {
        if (key !== "type") walk(field, `${type}.${key}`, out, 0);
      }
    }
  }
  return Object.fromEntries(
    [...out.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, values]) => [path, [...values].sort()]),
  );
}
