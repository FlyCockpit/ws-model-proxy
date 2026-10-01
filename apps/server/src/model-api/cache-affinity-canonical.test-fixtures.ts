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

export const instructionPlacementRows = ["openai-chat", "openai-responses"].flatMap((surface) =>
  ["system", "developer", " SyStEm ", " DeVeLoPeR "].map((role) => ({ surface, role })),
);

export function orderedHistoryPayload(surface: string, units: unknown[]) {
  return surface === "openai-responses" ? { input: units } : { messages: units };
}

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

export function embeddedArgumentsRequest(surface: string, argumentsText: string, model = "m") {
  const tool = { name: "lookup", parameters: { type: "object" } };
  const common = { model, max_output_tokens: 16, parallel_tool_calls: false };
  if (surface === "openai-responses")
    return {
      ...common,
      tools: [{ type: "function", ...tool }],
      input: [
        { role: "user", content: "start" },
        { type: "function_call", call_id: "call-1", name: "lookup", arguments: argumentsText },
      ],
    };
  return {
    model,
    max_tokens: 16,
    parallel_tool_calls: false,
    tools: [{ type: "function", function: tool }],
    messages: [
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "lookup", arguments: argumentsText },
          },
        ],
      },
    ],
  };
}

export const numericOverflowRows = [
  "openai-chat",
  "anthropic-messages",
  "openai-responses",
].flatMap((surface) => ["scalar", "object", "array"].map((shape) => ({ surface, shape })));

export function numericOverflowPayload(surface: string, shape: string, value: string | undefined) {
  const extension =
    value === undefined
      ? ""
      : `,"vendor_extension":${shape === "object" ? `{"field":${value}}` : shape === "array" ? `[${value}]` : value}`;
  const units = '[{"role":"user","content":"U"},{"role":"assistant","content":"A"}]';
  return JSON.parse(
    `{${surface === "openai-responses" ? '"input"' : '"messages"'}:${units}${extension}}`,
  );
}
