/**
 * The ONE generator for every MCP tool's advertised `inputSchema` (#117).
 *
 * Procedure-backed tools advertise the JSON Schema of their REAL oRPC input
 * (`z.toJSONSchema(schema, { io: "input", unrepresentable: "any" })`), merged
 * with the small set of MCP-owned overlays declared on the tool spec:
 *
 *   - `confirm`: the exact literal, derived from the spec's `confirmation`;
 *   - `forbiddenInputs`: human-only / dedicated-tool fields, advertised as
 *     `{ not: {}, description }` naming the tool to use instead;
 *   - `emptyArrayInputs`: fields that must be omitted or `[]`;
 *   - `isoDateFields`: `z.date()` procedure inputs that JSON carries as
 *     RFC 3339 UTC strings (the spec's adapter converts them).
 *
 * Extracted-core tools have no procedure: their MCP-owned `coreShape` is the
 * input schema. Nobody sets `inputSchema` by hand; `buildDescriptor` is the
 * only place a descriptor's `inputSchema` is created, so a new tool (or a
 * tool from another branch) gets the generated schema by declaring a spec.
 *
 * RUNTIME VALIDATION is unchanged: the schema the SDK validates with is a
 * loose object (size bound + overlay rules only) whose extra keys pass to
 * the oRPC procedure, which stays the single validation authority. The
 * generated JSON Schema is advisory metadata for clients.
 */

import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { appRouter } from "@ws-model-proxy/api/routers/index";
import { z } from "zod";

/** MCP-owned input rules merged over the procedure's own input schema. */
export interface McpInputOverlay {
  /** Field -> message naming the tool to use instead. Any value is rejected. */
  forbiddenInputs?: Readonly<Record<string, string>>;
  /** Field -> message. Only omitted or `[]` is accepted. */
  emptyArrayInputs?: Readonly<Record<string, string>>;
  /** `z.date()` procedure fields carried as RFC 3339 UTC strings. */
  isoDateFields?: readonly string[];
  /**
   * Extracted-core tools only: the MCP-owned argument shape (there is no
   * procedure schema to generate from).
   */
  coreShape?: z.ZodRawShape;
  /**
   * Override of the first-stage input size bound ({@link MCP_TOOL_INPUT_MAX_BYTES})
   * for a tool whose legitimate input is larger (a file write carries up to
   * 1 MiB of content). The raw request body stays capped by the /mcp body cap.
   */
  maxInputBytes?: number;
}

export interface McpInputSchemaSpec extends McpInputOverlay {
  /** Dotted `appRouter` path, or `core:` for extracted cores. */
  target: string;
  /** Confirmation literal; advertised and required as `confirm` when set. */
  confirmation: "DELETE" | "RUN" | null;
}

type JsonObject = Record<string, unknown>;

/** First-stage bound on tool INPUT size (see `withInputSizeBound`). */
export const MCP_TOOL_INPUT_MAX_BYTES = 64 * 1024;

function inputByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : new TextEncoder().encode(serialized).length;
}

/**
 * The FIRST schema stage (G5 pass 4): measures the JSON encoding of the
 * incoming value and adds ONE custom issue when it exceeds the bound. Piped
 * ahead of the object schema so it always runs and child parsing never
 * executes for an oversized input (bounding the SDK's issue echo).
 */
function inputSizeGuard(maxBytes: number) {
  return z.transform((value, ctx) => {
    if (inputByteLength(value) > maxBytes) {
      ctx.addIssue({
        code: "custom",
        message: `input exceeds the maximum size of ${maxBytes} bytes`,
        input: value,
        path: [],
      });
    }
    return value;
  });
}

const INPUT_SIZE_GUARD = inputSizeGuard(MCP_TOOL_INPUT_MAX_BYTES);

function withInputSizeBound<T extends z.ZodType>(schema: T, maxBytes?: number) {
  const guard = maxBytes === undefined ? INPUT_SIZE_GUARD : inputSizeGuard(maxBytes);
  return z.pipe(guard, schema as z.ZodType);
}

/**
 * The schema the SDK validates arguments with: loose object, overlay rules
 * only. Every other argument is left for the oRPC procedure to validate.
 */
function buildValidator(spec: McpInputSchemaSpec): z.ZodType {
  const shape: { -readonly [K in string]: z.core.$ZodType } = { ...spec.coreShape };
  for (const [field, message] of Object.entries(spec.emptyArrayInputs ?? {})) {
    shape[field] = z.array(z.unknown()).max(0, message).optional();
  }
  for (const [field, message] of Object.entries(spec.forbiddenInputs ?? {})) {
    shape[field] = z.never(message).optional();
  }
  if (spec.confirmation !== null) shape.confirm = z.literal(spec.confirmation);
  return withInputSizeBound(z.looseObject(shape), spec.maxInputBytes);
}

/** Resolve a dotted `appRouter` target to its procedure's zod input schema. */
function resolveProcedureInput(target: string): z.ZodType | undefined {
  let node: unknown = appRouter;
  for (const segment of target.split(".")) {
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, segment)) {
      throw new Error(`MCP tool target ${target} does not resolve against appRouter`);
    }
    node = Reflect.get(node, segment);
  }
  if (node === null || typeof node !== "object" || !Object.hasOwn(node, "~orpc")) {
    throw new Error(`MCP tool target ${target} is not a procedure`);
  }
  const definition: unknown = Reflect.get(node, "~orpc");
  const input: unknown =
    definition !== null && typeof definition === "object"
      ? Reflect.get(definition, "inputSchema")
      : undefined;
  if (input === undefined) return undefined;
  if (input === null || typeof input !== "object" || !("_zod" in input)) {
    throw new Error(`MCP tool target ${target} does not have a zod input schema`);
  }
  return input as z.ZodType;
}

/** Stage 1 of the generator: the procedure input as JSON Schema. */
export function toInputJsonSchema(schema: z.ZodType): JsonObject {
  return z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonObject;
}

function objectOf(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

/** Base JSON Schema before overlays: the procedure's real input, or `{}` args. */
function baseJsonSchema(spec: McpInputSchemaSpec): JsonObject {
  if (spec.coreShape !== undefined) return toInputJsonSchema(z.looseObject(spec.coreShape));
  const input = resolveProcedureInput(spec.target);
  if (input === undefined) return toInputJsonSchema(z.looseObject({}));
  return toInputJsonSchema(input);
}

/** Merge the MCP-owned overlays into a generated JSON Schema (pure). */
export function applyInputOverlay(base: JsonObject, spec: McpInputSchemaSpec): JsonObject {
  // Union roots (`oneOf`/`anyOf`) carry no root `properties`; the overlay
  // properties sit beside the branches, which is valid JSON Schema.
  if (base.type !== undefined && base.type !== "object") {
    throw new Error(`MCP tool ${spec.target}: input schema root must be an object schema`);
  }
  const properties: JsonObject = { ...objectOf(base.properties) };
  let required = Array.isArray(base.required) ? [...(base.required as string[])] : [];

  for (const field of spec.isoDateFields ?? []) {
    properties[field] = {
      type: "string",
      format: "date-time",
      description:
        "RFC 3339 UTC timestamp in the exact form YYYY-MM-DDTHH:MM:SS[.fff]Z (no offsets).",
    };
  }
  for (const [field, message] of Object.entries(spec.emptyArrayInputs ?? {})) {
    // The item shape is irrelevant (only `[]` passes): drop it to save size.
    properties[field] = { type: "array", maxItems: 0, description: message };
  }
  for (const [field, message] of Object.entries(spec.forbiddenInputs ?? {})) {
    properties[field] = { not: {}, description: message };
    required = required.filter((name) => name !== field);
  }
  if (spec.confirmation !== null) {
    properties.confirm = {
      type: "string",
      const: spec.confirmation,
      description: `Must be exactly "${spec.confirmation}" to confirm this call.`,
    };
    if (!required.includes("confirm")) required.push("confirm");
  }
  const { required: _drop, ...rest } = base;
  return {
    ...rest,
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/**
 * The advertised JSON Schema for one spec. Exported for the drift tests;
 * the SDK reaches it through `buildInputSchema`.
 */
export function advertisedInputJsonSchema(spec: McpInputSchemaSpec): JsonObject {
  return applyInputOverlay(baseJsonSchema(spec), spec);
}

/**
 * Build the descriptor's `inputSchema`: the loose validator plus the
 * generated JSON Schema, computed lazily (first `tools/list`) and cached so
 * importing the manifest never has to walk the router.
 */
export function buildInputSchema(spec: McpInputSchemaSpec): StandardSchemaWithJSON {
  const validator = buildValidator(spec);
  let cached: JsonObject | undefined;
  const json = (): JsonObject => {
    cached ??= advertisedInputJsonSchema(spec);
    return structuredClone(cached);
  };
  return {
    "~standard": {
      ...validator["~standard"],
      jsonSchema: { input: json, output: json },
    },
  };
}
