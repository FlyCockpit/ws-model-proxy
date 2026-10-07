/**
 * Accepted request profile from an engine's OpenAPI description (vLLM and SGLang serve
 * `/openapi.json`). Pure and bounded: `$ref` chains, depth and node count are capped, and
 * anything the walker cannot understand reads as "accepts anything" (never as a reason to drop).
 */
import {
  type AcceptedNode,
  type AcceptedProfile,
  COMPAT_ENDPOINT_PATHS,
  COMPAT_ENDPOINTS,
} from "@ws-model-proxy/api/lib/request-compat";

const MAX_DEPTH = 12;
const MAX_NODES = 20_000;
const MAX_ENUM_VALUES = 64;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accepts anything below (no keys, items or enum): never drops. */
const ANY: AcceptedNode = {};

class Budget {
  nodes = 0;
  spend(): boolean {
    this.nodes += 1;
    return this.nodes <= MAX_NODES;
  }
}

function resolveRef(document: Json, ref: string): Json | null {
  if (!ref.startsWith("#/")) return null;
  let current: unknown = document;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isObject(current)) return null;
    current = current[key];
  }
  return isObject(current) ? current : null;
}

function isAny(node: AcceptedNode): boolean {
  return node.p === undefined && node.i === undefined && node.e === undefined && !node.s;
}

/** Accepted if ANY variant accepts: keys and values are unioned, openness wins. */
function union(nodes: AcceptedNode[]): AcceptedNode {
  if (nodes.length === 0 || nodes.some(isAny)) return ANY;
  const out: AcceptedNode = {};
  const props: Record<string, AcceptedNode[]> = {};
  const items: AcceptedNode[] = [];
  const values = new Set<string>();
  let hasProps = false;
  let hasEnum = false;
  let scalarWithoutEnum = false;
  for (const node of nodes) {
    if (node.o) out.o = 1;
    if (node.p) {
      hasProps = true;
      for (const [key, child] of Object.entries(node.p)) {
        const list = props[key] ?? [];
        list.push(child);
        props[key] = list;
      }
    }
    if (node.i) items.push(node.i);
    if (node.e) {
      hasEnum = true;
      for (const value of node.e) values.add(value);
    } else if (node.s) scalarWithoutEnum = true;
  }
  if (hasProps) out.p = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, union(v)]));
  if (items.length > 0) out.i = union(items);
  // A variant that is a plain string accepts every value.
  if (hasEnum && !scalarWithoutEnum && values.size <= MAX_ENUM_VALUES) out.e = [...values].sort();
  else if (hasEnum || scalarWithoutEnum) out.s = 1;
  return out;
}

function walk(
  document: Json,
  schema: unknown,
  depth: number,
  budget: Budget,
  refs: string[],
): AcceptedNode {
  if (!isObject(schema) || depth > MAX_DEPTH || !budget.spend()) return ANY;
  const composed: AcceptedNode[] = [];
  let isComposed = false;
  if (typeof schema.$ref === "string") {
    isComposed = true;
    const target = refs.includes(schema.$ref) ? null : resolveRef(document, schema.$ref);
    composed.push(target ? walk(document, target, depth + 1, budget, [...refs, schema.$ref]) : ANY);
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const variants = schema[key];
    if (!Array.isArray(variants)) continue;
    isComposed = true;
    // `null` variants (Optional[...]) carry no keys: skip them.
    const real = variants.filter((variant) => !(isObject(variant) && variant.type === "null"));
    composed.push(union(real.map((variant) => walk(document, variant, depth + 1, budget, refs))));
  }
  if (Array.isArray(schema.allOf)) {
    isComposed = true;
    // Every part's keys are accepted (inheritance): their union.
    composed.push(union(schema.allOf.map((part) => walk(document, part, depth + 1, budget, refs))));
  }
  const own = walkOwn(document, schema, depth, budget, refs);
  if (!isComposed) return own;
  // Sibling keywords (`properties` next to `$ref` or `anyOf`) add to what the parts accept.
  return isAny(own)
    ? composed.length === 1
      ? composed[0]!
      : union(composed)
    : union([own, ...composed]);
}

/** The schema's own keywords, ignoring `$ref`, `anyOf`, `oneOf` and `allOf`. */
function walkOwn(
  document: Json,
  schema: Json,
  depth: number,
  budget: Budget,
  refs: string[],
): AcceptedNode {
  const enumValues = Array.isArray(schema.enum)
    ? schema.enum.filter((value): value is string => typeof value === "string")
    : typeof schema.const === "string"
      ? [schema.const]
      : null;
  if (enumValues && enumValues.length > 0 && enumValues.length <= MAX_ENUM_VALUES)
    return { e: [...new Set(enumValues)].sort() };
  const properties = schema.properties;
  if (isObject(properties)) {
    const node: AcceptedNode = {
      p: Object.fromEntries(
        Object.entries(properties).map(([key, child]) => [
          key,
          walk(document, child, depth + 1, budget, refs),
        ]),
      ),
    };
    // Only an explicit `additionalProperties: false` (pydantic `extra="forbid"`) closes an
    // object; absent means open in JSON Schema, and such engines ignore extra keys anyway.
    if (schema.additionalProperties !== false) node.o = 1;
    return node;
  }
  if (schema.type === "array" && schema.items !== undefined)
    return { i: walk(document, schema.items, depth + 1, budget, refs) };
  if (
    typeof schema.type === "string" &&
    ["string", "number", "integer", "boolean"].includes(schema.type)
  )
    return { s: 1 };
  return ANY;
}

function requestSchema(document: Json, path: string): unknown {
  const paths = document.paths;
  if (!isObject(paths)) return undefined;
  const operation = paths[path];
  if (!isObject(operation) || !isObject(operation.post)) return undefined;
  const body = operation.post.requestBody;
  const resolved =
    isObject(body) && typeof body.$ref === "string" ? resolveRef(document, body.$ref) : body;
  if (!isObject(resolved) || !isObject(resolved.content)) return undefined;
  const json = resolved.content["application/json"];
  return isObject(json) ? json.schema : undefined;
}

/**
 * The accepted profile an OpenAPI 3 document describes, or null when it describes none of the
 * request endpoints with a schema the walker can read (a FastAPI handler taking a raw `Request`
 * has none).
 */
export function acceptedProfileFromOpenApi(document: unknown): AcceptedProfile | null {
  if (!isObject(document) || typeof document.openapi !== "string") return null;
  const endpoints: AcceptedProfile["endpoints"] = {};
  const budget = new Budget();
  for (const endpoint of COMPAT_ENDPOINTS) {
    const schema = requestSchema(document, COMPAT_ENDPOINT_PATHS[endpoint]);
    if (schema === undefined) continue;
    const node = walk(document, schema, 0, budget, []);
    // Only an object with known keys can tell unknown fields apart.
    if (node.p) endpoints[endpoint] = node;
  }
  return Object.keys(endpoints).length > 0 ? { v: 1, endpoints } : null;
}

/** `info.title` and `info.version` (bounded), for the engine fingerprint. */
export function openApiEngineVersion(document: unknown): string | null {
  if (!isObject(document) || !isObject(document.info)) return null;
  const { title, version } = document.info;
  const parts = [title, version].filter((part): part is string => typeof part === "string");
  if (parts.length === 0) return null;
  return parts
    .join(" ")
    .replace(/[^\x20-\x7e]/g, "")
    .slice(0, 120);
}
