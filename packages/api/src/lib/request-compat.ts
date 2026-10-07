/**
 * Request compatibility settings of a runtime version (`RuntimeVersion.advanced.compat`) and the
 * one list of SEMANTIC request fields. Pure: no I/O. The server's policy module
 * (`apps/server/src/model-api/compat`) applies these to every request a runtime receives, native
 * or adapted; the runtime contracts validate edits with {@link requestCompatSchema}.
 *
 * Field paths are dotted keys, with `[]` after a key whose value is an array whose every element
 * is meant: `stream_options.include_usage`, `messages[].cache_control`,
 * `tools[].function.strict`.
 */
import { z } from "zod";

// ── Endpoints ──

/** Request families a runtime can receive a JSON body on. */
export const COMPAT_ENDPOINTS = [
  "chat.completions",
  "completions",
  "responses",
  "messages",
  "embeddings",
] as const;
export type CompatEndpoint = (typeof COMPAT_ENDPOINTS)[number];

/** The engine path of each endpoint (OpenAPI descriptions are keyed by it). */
export const COMPAT_ENDPOINT_PATHS: Record<CompatEndpoint, string> = {
  "chat.completions": "/v1/chat/completions",
  completions: "/v1/completions",
  responses: "/v1/responses",
  messages: "/v1/messages",
  embeddings: "/v1/embeddings",
};

export function compatEndpointForFamily(family: string): CompatEndpoint | null {
  return (COMPAT_ENDPOINTS as readonly string[]).includes(family)
    ? (family as CompatEndpoint)
    : null;
}

// ── Model-name aliases ──

/**
 * A model-name alias (`gpt-4o`, `claude-sonnet-4-5`, `meta-llama/Llama-3.1-8B`, `qwen3:8b`):
 * what OpenAI-, Anthropic- and Hugging Face-style ids look like. Shared by the contract and the
 * web form.
 */
export const MODEL_ALIAS_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

/** Why `name` cannot be an alias, or null: the shape, the `:external` variant, a direct test. */
export function modelAliasNameProblem(name: string): "invalid" | "external" | "runtime" | null {
  if (!MODEL_ALIAS_NAME.test(name)) return "invalid";
  if (/:external$/i.test(name)) return "external";
  if (name.startsWith("runtime:")) return "runtime";
  return null;
}

// ── Field paths ──

const SEGMENT = /^[A-Za-z_][A-Za-z0-9_-]{0,63}(\[\])?$/;
/** Keys that reach JavaScript object internals instead of a request field. */
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export const MAX_FIELD_PATH_SEGMENTS = 8;

/** A plain request key: identifier-like and not an object internal. */
export function isFieldKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key) && !RESERVED_KEYS.has(key);
}

export type FieldPathSegment = { key: string; each: boolean };

/** Parses `a.b[].c`; null when it is not a valid field path. */
export function parseFieldPath(path: string): FieldPathSegment[] | null {
  if (path.length === 0 || path.length > 256) return null;
  const parts = path.split(".");
  if (parts.length > MAX_FIELD_PATH_SEGMENTS) return null;
  const segments: FieldPathSegment[] = [];
  for (const part of parts) {
    if (!SEGMENT.test(part)) return null;
    const each = part.endsWith("[]");
    const key = each ? part.slice(0, -2) : part;
    if (RESERVED_KEYS.has(key)) return null;
    segments.push({ key, each });
  }
  return segments;
}

export function formatFieldPath(segments: readonly FieldPathSegment[]): string {
  return segments.map((segment) => `${segment.key}${segment.each ? "[]" : ""}`).join(".");
}

// ── Semantic fields ──

/**
 * Fields that change WHAT the model is asked or how its answer is shaped. They are never dropped
 * automatically (learned or from an engine description): the caller gets a clear 400 naming the
 * field instead, unless the runtime lists the path in `allowDropSemanticFields`. A path is
 * semantic when it is one of these or lies under one (`response_format.json_schema.strict`).
 */
export const SEMANTIC_FIELDS = [
  "model",
  "messages",
  "input",
  "instructions",
  "system",
  "prompt",
  "tools",
  "tool_choice",
  "functions",
  "function_call",
  "response_format",
  "text.format",
  "stream",
  "max_tokens",
  "max_output_tokens",
  "max_completion_tokens",
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "frequency_penalty",
  "presence_penalty",
  "repetition_penalty",
  "parallel_tool_calls",
  "stop",
  "stop_sequences",
  "n",
  "seed",
  "logprobs",
  "top_logprobs",
  "reasoning",
  "reasoning_effort",
  "thinking",
  "prediction",
  "dimensions",
  "encoding_format",
  // Conversation state (Responses).
  "previous_response_id",
  "conversation",
  // Output constraints and template switches: losing one silently changes the answer.
  "logit_bias",
  "guided_json",
  "guided_regex",
  "guided_choice",
  "guided_grammar",
  "structured_outputs",
  "grammar",
  "json_schema",
  "chat_template_kwargs",
] as const;

/**
 * Containers whose metadata keys may be dropped (`messages[].cache_control`) while their
 * meaning-bearing parts stay semantic. Dropping the container itself, or anything under these
 * sub-paths, is semantic.
 */
const SEMANTIC_CONTAINER_PARTS: Readonly<Record<string, readonly string[]>> = {
  messages: ["role", "content", "tool_calls", "tool_call_id", "function_call", "name"],
  input: ["role", "content", "type", "call_id", "output", "arguments", "name"],
  system: ["text", "type"],
  tools: ["type", "function", "name", "description", "parameters", "input_schema", "strict"],
};

/** The path as written, without `[]` markers (`messages.cache_control`). */
function plainKeys(path: string): string[] {
  return path.split(".").map((part) => (part.endsWith("[]") ? part.slice(0, -2) : part));
}

/** Whether dropping `path` (a field path) could change the meaning of the request. */
export function isSemanticPath(path: string): boolean {
  const keys = plainKeys(path);
  const head = keys[0] ?? "";
  const container = Object.hasOwn(SEMANTIC_CONTAINER_PARTS, head)
    ? SEMANTIC_CONTAINER_PARTS[head]
    : undefined;
  if (container) {
    if (keys.length === 1) return true;
    // Content parts and tool definitions are meaning; their metadata keys are not, except the
    // ones listed (`messages[].content[].text`, `tools[].function.parameters`).
    const second = keys[1] ?? "";
    if (!container.includes(second)) return false;
    if (head === "messages" && second === "content" && keys.length > 2)
      return !["cache_control"].includes(keys.at(-1) ?? "");
    if (head === "tools" && second === "function" && keys.length > 2)
      return ["name", "description", "parameters", "strict"].includes(keys[2] ?? "");
    return true;
  }
  const joined = keys.join(".");
  // A field, anything under it, and any object holding one (`text` holds `text.format`).
  return SEMANTIC_FIELDS.some(
    (field) => joined === field || joined.startsWith(`${field}.`) || field.startsWith(`${joined}.`),
  );
}

/**
 * Semantic fields with a same-meaning spelling an engine may want instead. Applied as learned
 * fixes (rename, never drop) when the engine names one as unknown.
 */
export const SEMANTIC_EQUIVALENTS: Readonly<
  Partial<Record<CompatEndpoint, Record<string, string>>>
> = {
  "chat.completions": {
    max_completion_tokens: "max_tokens",
    max_tokens: "max_completion_tokens",
  },
};

// ── Rewrite rules ──

/**
 * Segments a rule may never name: the target (`model`), the proxy's streaming contract
 * (`stream`), and anything credential-like or address-like, so a rule cannot inject credentials
 * or redirect a request.
 */
const FORBIDDEN_FIRST = new Set(["model", "stream"]);
/**
 * A default may not add content or a reference to something: no message, instruction or tool
 * containers, and no adapter, file or media keys (a default could otherwise pick another LoRA
 * adapter or point at someone's upload).
 */
const DEFAULT_FORBIDDEN_FIRST = new Set([
  "messages",
  "input",
  "instructions",
  "system",
  "prompt",
  "tools",
  "tool_choice",
  "functions",
  "function_call",
  "response_format",
  "text",
  "prediction",
  "previous_response_id",
  "conversation",
]);
const DEFAULT_FORBIDDEN_SEGMENT =
  /(lora|adapter|^file|_file$|file_id|image|audio|video|media|path$)/i;
const FORBIDDEN_SEGMENT =
  /(api[_-]?key|apikey|authori[sz]ation|password|passwd|secret|credential|bearer|cookie|token$|^auth$|^headers?$|^extra_headers$|^base_url$|^api_base$|^endpoint$|^url$|private[_-]?key)/i;

/** Null when a rule may name `path`; otherwise why not. */
export function rulePathProblem(path: string): string | null {
  const segments = parseFieldPath(path);
  if (!segments) return "not a field path (a.b[].c)";
  if (FORBIDDEN_FIRST.has(segments[0]!.key)) return `${segments[0]!.key} cannot be rewritten`;
  // `max_tokens` & co. are fine: the credential check looks at whole words ending in "token".
  for (const segment of segments)
    if (FORBIDDEN_SEGMENT.test(segment.key) && !/_tokens$/.test(segment.key))
      return `${segment.key} looks like a credential or an address`;
  return null;
}

export const COMPAT_ROLES = ["system", "developer", "user", "assistant", "tool"] as const;

const fieldPathSchema = z
  .string()
  .max(256)
  .superRefine((path, ctx) => {
    const problem = rulePathProblem(path);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

const endpointSchema = z.enum(COMPAT_ENDPOINTS).optional();

/**
 * Null when a rename may move `path` to the key `to`. The destination gets the default rule's
 * protection too, since a rename could move a value a default created: an object-level move may
 * not land on a content, conversation, adapter, file or media key. Same-meaning spellings
 * (`max_completion_tokens` → `max_tokens`) are always allowed.
 */
export function renameTargetProblem(path: string, to: string): string | null {
  const segments = parseFieldPath(path);
  if (!segments) return "not a field path (a.b[].c)";
  if (
    Object.values(SEMANTIC_EQUIVALENTS).some(
      (map) => map !== undefined && Object.hasOwn(map, path) && map[path] === to,
    )
  )
    return null;
  const destination = formatFieldPath([...segments.slice(0, -1), { key: to, each: false }]);
  const credential = rulePathProblem(destination);
  if (credential) return credential;
  if (DEFAULT_FORBIDDEN_SEGMENT.test(to)) return `${to} names an adapter, file or media reference`;
  if (segments.length === 1 && DEFAULT_FORBIDDEN_FIRST.has(to))
    return `a rename cannot create ${to}`;
  return null;
}

/** Null when a `default` rule may set `path`; otherwise why not. */
export function defaultPathProblem(path: string): string | null {
  const segments = parseFieldPath(path);
  if (!segments) return "not a field path (a.b[].c)";
  if (segments.some((segment) => segment.each)) return "defaults are set on objects, not arrays";
  if (DEFAULT_FORBIDDEN_FIRST.has(segments[0]!.key))
    return `a default cannot add to ${segments[0]!.key}`;
  for (const segment of segments)
    if (DEFAULT_FORBIDDEN_SEGMENT.test(segment.key))
      return `${segment.key} names an adapter, file or media reference`;
  return null;
}

/** A default may not carry a URL, a data URI or a path: letters, digits and simple marks. */
const defaultValueSchema = z.union([
  z
    .string()
    .max(128)
    .regex(/^[A-Za-z0-9 _.,:;=+@-]*$/, "letters, digits, spaces and . , : ; = + @ - only"),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const rewriteRuleSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("rename"),
      endpoint: endpointSchema,
      path: fieldPathSchema,
      /** The new key, in the same object. */
      to: z.string().refine(isFieldKey, "a plain key (letters, digits, _ and -)"),
    })
    .strict()
    .superRefine((rule, ctx) => {
      const problem = renameTargetProblem(rule.path, rule.to);
      if (problem) ctx.addIssue({ code: "custom", path: ["to"], message: problem });
    }),
  z.object({ op: z.literal("drop"), endpoint: endpointSchema, path: fieldPathSchema }).strict(),
  z
    .object({
      op: z.literal("default"),
      endpoint: endpointSchema,
      path: fieldPathSchema.superRefine((path, ctx) => {
        const problem = rulePathProblem(path) ? null : defaultPathProblem(path);
        if (problem) ctx.addIssue({ code: "custom", message: problem });
      }),
      value: defaultValueSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("clamp"),
      endpoint: endpointSchema,
      path: fieldPathSchema,
      min: z.number().finite().optional(),
      max: z.number().finite().optional(),
    })
    .strict()
    .refine((rule) => rule.min !== undefined || rule.max !== undefined, "give min or max")
    .refine(
      (rule) => rule.min === undefined || rule.max === undefined || rule.min <= rule.max,
      "min must not exceed max",
    ),
  z
    .object({
      op: z.literal("mapRole"),
      endpoint: endpointSchema,
      from: z.enum(COMPAT_ROLES),
      to: z.enum(COMPAT_ROLES),
    })
    .strict(),
]);
export type RewriteRule = z.infer<typeof rewriteRuleSchema>;

// ── Headers ──

/**
 * Client headers whose forwarding a runtime may decide. Credentials are never among them: the
 * proxy strips every auth header and the node adds its own upstream credentials.
 */
export const COMPAT_HEADERS = [
  "anthropic-beta",
  "anthropic-version",
  "openai-beta",
  "openai-version",
  "idempotency-key",
  "x-request-id",
  "request-id",
] as const;
export type CompatHeader = (typeof COMPAT_HEADERS)[number];
export type HeaderMode = "forward" | "strip";

// ── The setting ──

export const UNKNOWN_FIELD_POLICIES = ["auto", "forward", "strict"] as const;
export type UnknownFieldPolicy = (typeof UNKNOWN_FIELD_POLICIES)[number];
export const REASONING_FIELD_MODES = ["auto", "reasoning", "reasoning_content", "strip"] as const;
export type ReasoningFieldMode = (typeof REASONING_FIELD_MODES)[number];

export const MAX_REWRITE_RULES = 32;

export const requestCompatSchema = z
  .object({
    /**
     * auto: drop unknown non-semantic fields (from the engine's description or learned from its
     * 400s); forward: send everything as is; strict: refuse unknown fields with a 400.
     */
    unknownFieldPolicy: z.enum(UNKNOWN_FIELD_POLICIES).optional(),
    /** Semantic paths the operator accepts losing when the engine rejects them. */
    allowDropSemanticFields: z.array(fieldPathSchema).max(16).optional(),
    rewriteRules: z.array(rewriteRuleSchema).max(MAX_REWRITE_RULES).optional(),
    /** Per client header: forward or strip (absent: the protocol default, learned from 400s). */
    headers: z.partialRecord(z.enum(COMPAT_HEADERS), z.enum(["forward", "strip"])).optional(),
    /** Fields the proxy adds itself (absent: from the engine and its description). */
    extras: z
      .object({
        streamUsage: z.boolean().optional(),
        topK: z.boolean().optional(),
      })
      .strict()
      .optional(),
    /** Shape responses toward what the caller's protocol expects. */
    response: z
      .object({
        reasoningField: z.enum(REASONING_FIELD_MODES).optional(),
        /** Remove fields outside the caller's protocol (for strict client SDKs). */
        stripNonStandard: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((compat, ctx) => {
    const allowed = new Set(compat.allowDropSemanticFields ?? []);
    compat.rewriteRules?.forEach((rule, index) => {
      if (rule.op !== "drop" && rule.op !== "rename") return;
      if (!isSemanticPath(rule.path) || allowed.has(rule.path)) return;
      // Renaming to the same-meaning spelling keeps the meaning; any other rename of a semantic
      // field hides it from the engine just like a drop.
      const same =
        rule.op === "rename" &&
        Object.values(SEMANTIC_EQUIVALENTS).some(
          (map) => map !== undefined && Object.hasOwn(map, rule.path) && map[rule.path] === rule.to,
        );
      if (!same)
        ctx.addIssue({
          code: "custom",
          path: ["rewriteRules", index, "path"],
          message: `${rule.path} is semantic: list it in allowDropSemanticFields to ${rule.op} it`,
        });
    });
  });
export type RequestCompat = z.infer<typeof requestCompatSchema>;

/** `RuntimeVersion.compat` as stored; an invalid value (never written) reads as automatic. */
export function storedRequestCompat(value: unknown): RequestCompat {
  const parsed = requestCompatSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

// ── Accepted request profile ──

/**
 * What an engine accepts at one point of a request body, from its OpenAPI description (or a
 * future engine-profile catalog). `p`: known keys of an object; `o`: the object also accepts
 * other keys; `i`: array items; `e`: accepted string values; `s`: a scalar. A node with none of
 * these accepts anything below it.
 */
export type AcceptedNode = {
  p?: Record<string, AcceptedNode>;
  o?: 1;
  i?: AcceptedNode;
  e?: string[];
  s?: 1;
};

export type AcceptedProfile = {
  v: 1;
  endpoints: Partial<Record<CompatEndpoint, AcceptedNode>>;
};

/** What the proxy learned from an engine's 400s, per endpoint. Never holds values. */
export type LearnedFix =
  | { kind: "drop"; path: string }
  | { kind: "rename"; path: string; to: string }
  | { kind: "mapRole"; from: string; to: string };

export type LearnedProfile = {
  v: 1;
  fixes: Partial<Record<CompatEndpoint, LearnedFix[]>>;
  /** Client headers the engine rejected. */
  stripHeaders: string[];
};

export const MAX_LEARNED_FIXES_PER_ENDPOINT = 64;

export function emptyLearnedProfile(): LearnedProfile {
  return { v: 1, fixes: {}, stripHeaders: [] };
}

const acceptedNodeSchema: z.ZodType<AcceptedNode> = z.lazy(() =>
  z
    .object({
      p: z.record(z.string(), acceptedNodeSchema).optional(),
      o: z.literal(1).optional(),
      i: acceptedNodeSchema.optional(),
      e: z.array(z.string()).optional(),
      s: z.literal(1).optional(),
    })
    .strict(),
);

const learnedFixSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("drop"), path: z.string() }).strict(),
  z.object({ kind: z.literal("rename"), path: z.string(), to: z.string() }).strict(),
  z.object({ kind: z.literal("mapRole"), from: z.string(), to: z.string() }).strict(),
]);

export function readAcceptedProfile(value: unknown): AcceptedProfile | null {
  const parsed = z
    .object({
      v: z.literal(1),
      endpoints: z.partialRecord(z.enum(COMPAT_ENDPOINTS), acceptedNodeSchema),
    })
    .safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function readLearnedProfile(value: unknown): LearnedProfile {
  const parsed = z
    .object({
      v: z.literal(1),
      fixes: z.partialRecord(
        z.enum(COMPAT_ENDPOINTS),
        z.array(learnedFixSchema).max(MAX_LEARNED_FIXES_PER_ENDPOINT),
      ),
      stripHeaders: z.array(z.string()).max(16),
    })
    .safeParse(value);
  return parsed.success ? parsed.data : emptyLearnedProfile();
}
