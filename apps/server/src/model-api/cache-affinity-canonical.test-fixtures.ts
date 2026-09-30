import { MAX_CANONICAL_DEPTH } from "./cache-affinity-layers.js";

export const canonicalKeys = [
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "hasOwnProperty",
  "0",
  "01",
  "",
  "☃😀",
  'quote"\\\n',
  "a.b/c",
];
export const canonicalShapes = ["object", "array", "mixed"] as const;
export const canonicalLocations = ["parameter", "tools", "instructions", "messages"] as const;
export type CanonicalLocation = (typeof canonicalLocations)[number];

// Build wire text without recursively stringifying the 10,000-level fixture.
export function nestedWire(depth: number, shape: (typeof canonicalShapes)[number]): string {
  let wire = "0";
  for (let i = 0; i < depth; i++)
    wire = shape === "array" || (shape === "mixed" && i % 2) ? `[${wire}]` : `{"child":${wire}}`;
  return wire;
}

export function canonicalPayloadWire(
  location: CanonicalLocation,
  value: string,
  surface = "openai-responses",
): string {
  const units = `[{"role":"user","content":${location === "messages" ? value : '"U"'}},{"role":"assistant","content":"A"}]`;
  const content = `${surface === "openai-responses" ? '"input"' : '"messages"'}:${units}`;
  if (location === "messages") return `{${content}}`;
  if (location === "parameter")
    return surface === "openai-responses"
      ? `{${content},"text":{"format":{"schema":${value}}}}`
      : `{${content},"response_format":{"json_schema":{"schema":${value}}}}`;
  if (location === "tools") {
    const tool =
      surface === "openai-chat"
        ? `{"type":"function","function":{"name":"lookup","parameters":${value}}}`
        : surface === "anthropic-messages"
          ? `{"name":"lookup","input_schema":${value}}`
          : `{"type":"function","name":"lookup","parameters":${value}}`;
    return `{${content},"tools":[${tool}]}`;
  }
  if (surface === "openai-chat")
    return `{"messages":[{"role":"system","content":${value}},${units.slice(1)}}`;
  return `{${content},${surface === "anthropic-messages" ? '"system"' : '"instructions"'}:${value}}`;
}

export function depthPayloadWire(
  location: CanonicalLocation,
  depth: number,
  shape: (typeof canonicalShapes)[number],
): string {
  const offset = location === "instructions" ? 1 : 3;
  return canonicalPayloadWire(location, nestedWire(depth - offset, shape));
}

export const depthRows = canonicalLocations.flatMap((location) =>
  canonicalShapes.flatMap((shape) =>
    [MAX_CANONICAL_DEPTH, MAX_CANONICAL_DEPTH + 1, 10_000].map((depth) => ({
      location,
      shape,
      depth,
    })),
  ),
);
