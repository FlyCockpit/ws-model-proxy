/**
 * 0.4.0 runtime definition (`RuntimeVersion.spec`, relay 3.0 `runtime.define`).
 *
 * One schema for both runtime kinds: an ALWAYS_ON spec has `address` and no `launch`; a
 * STARTABLE spec has `launch` and no `address`. The kind is derived from that and must equal
 * `Runtime.kind` / the define envelope's `kind`.
 *
 * The server and the node validate the same rules. The Rust mirror is
 * `apps/cli/src/protocol/runtime_spec.rs`; shared fixtures live in
 * `apps/cli/tests/fixtures/relay-3.0/`. `launchHash = sha256(canonicalJson(spec))`
 * (`runtime-launch-hash.ts`) is the only definition identity a node sees.
 *
 * Pure module (no Node built-ins): the web Definition form validates with it too.
 */
import { z } from "zod";
import { canonicalJson } from "./canonical-json";
import { isFabricIp, isUrlIpHost } from "./ip-literal";
import { transcriptionProfileSchema } from "./transcription-profile";

// ── Vocabularies (wire values; Prisma enums are the upper-case forms) ──

export const RUNTIME_APIS = ["openai", "anthropic"] as const;
export type RuntimeApiWire = (typeof RUNTIME_APIS)[number];

export const ENGINES = ["vllm", "sglang", "llama_cpp", "ollama", "lm_studio", "other"] as const;
export type EngineWire = (typeof ENGINES)[number];

/** 0.5.0 adds generation types here (and nowhere else in the spec). */
export const MODEL_TYPES = ["llm", "embeddings", "transcription"] as const;
export type ModelTypeWire = (typeof MODEL_TYPES)[number];

export const MODEL_CAPABILITIES = [
  "text_generation",
  "vision_input",
  "video_input",
  "embedding",
  "audio_input",
  "audio_output",
  "responses_api",
] as const;
export type ModelCapabilityWire = (typeof MODEL_CAPABILITIES)[number];

export const RUNTIME_KINDS = ["always_on", "startable"] as const;
export type RuntimeKindWire = (typeof RUNTIME_KINDS)[number];

/** Signals a metrics reader may produce (same set as the 2.x engine adapters). */
export const READER_SIGNALS = [
  "running",
  "waiting",
  "kvUsage",
  "kvOccupancy",
  "slotsBusy",
  "deferred",
  "prefixCacheHitsTotal",
  "prefixCacheQueriesTotal",
  "kvTokens",
  "slots",
  "maxModelLen",
  "ctxPerSlot",
] as const;
export type ReaderSignal = (typeof READER_SIGNALS)[number];

/**
 * Placeholders a command may use; the node types every value (§4.6). `head_addr` is the head
 * node's IP on the instance's fabric (server-sent). The `fabric_*` values are NODE-derived from
 * the node's own IP on that fabric (`/sys/class/net`, the InfiniBand device mapping): the
 * server never sends interface or device names.
 */
export const RUNTIME_PLACEHOLDERS = [
  "node_rank",
  "nnodes",
  "port",
  "dist_port",
  "memory_gb",
  "gpu_ids",
  "vram_gb",
  "memory_fraction",
  "head_addr",
  "fabric_ip",
  "fabric_iface",
  "fabric_rdma_device",
] as const;
export type RuntimePlaceholder = (typeof RUNTIME_PLACEHOLDERS)[number];

// ── Limits shared with the node (`runtime_spec.rs` mirrors every one) ──

/** UTF-8 bytes of one command, saved and after placeholder substitution. */
export const RUNTIME_COMMAND_MAX_BYTES = 4096;
/**
 * UTF-8 bytes of one canonical spec. Below the 64 KiB control-frame cap so one define envelope
 * always fits in one `runtime.define` chunk.
 */
export const RUNTIME_SPEC_MAX_BYTES = 48 * 1024;
/** Server-origin definition VERSIONS one node holds (current, pinned and running ones). */
export const RUNTIME_DEFINITIONS_MAX = 128;
export const RUNTIME_GROUP_SIZE_MAX = 64;
export const RUNTIME_MODELS_MAX = 64;
export const RUNTIME_LABELS_MAX = 32;
export const RUNTIME_LABEL_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
export const RUNTIME_SLUG_PATTERN = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,40}$/;
/**
 * Node-local named secrets (owner decision round 3): one namespace, set only on the node
 * (`wsmp secret set NAME`, on a TTY), never sent to the server. Definitions reference them by
 * name (address auth/headers, `launch.secrets` for the commands' environment); agents can
 * reference names but never read values. The node reports names only.
 */
export const NODE_SECRET_PATTERN = /^WSMP_SECRET_[A-Z0-9_]{1,64}$/;
export const NODE_SECRETS_MAX = 64;
/**
 * Node commands (owner decision round 3): the longest lifetime one command may have
 * (`Node.commandMaxMs`, part of the node definition), the default per-call lifetime, the tail
 * of output one poll returns, and how long `node_command_run` waits before it answers
 * "running".
 */
export const NODE_COMMAND_MAX_MS = 86_400_000;
export const NODE_COMMAND_MIN_MS = 60_000;
export const NODE_COMMAND_DEFAULT_TIMEOUT_MS = 3_600_000;
export const NODE_COMMAND_TAIL_MAX_BYTES = 64 * 1024;
export const NODE_COMMAND_RUN_WAIT_MS = 15_000;
export const NODE_COMMAND_GET_WAIT_MAX_MS = 30_000;
export const NODE_COMMAND_STATES = [
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
  "unknown",
] as const;
export type NodeCommandStateWire = (typeof NODE_COMMAND_STATES)[number];
/** UTF-8 bytes of one secret value (set remotely at Full control, or `wsmp secret set`). */
export const NODE_SECRET_VALUE_MAX_BYTES = 16 * 1024;
/** Fabric names (owner decision round 3): like labels. */
export const FABRIC_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
/** Fabrics one node belongs to. */
export const NODE_FABRICS_MAX = 16;
/** Members of one fabric (a switch fabric of DGX-class nodes fits well inside). */
export const FABRIC_MEMBERS_MAX = 64;
/** Step deadlines in seconds (§2.12). Model downloads belong in `prepare`. */
export const RUNTIME_TIMEOUTS_SEC = {
  prepare: { max: 86_400, default: 3_600 },
  start: { max: 3_600, default: 900 },
  afterJoin: { max: 3_600, default: 900 },
  stop: { max: 3_600, default: 300 },
  status: { max: 3_600, default: 60 },
} as const;
export const NODE_METRIC_COMMANDS_MAX = 16;
/** Canonical UTF-8 bytes of all node metric commands (leaves room in one define frame). */
export const NODE_METRIC_COMMANDS_MAX_BYTES = 32 * 1024;
export const NODE_METRIC_COMMAND_NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
/** Custom series names a reader or metric command maps to. */
export const METRIC_SERIES_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

// ── Text rules (ported unchanged from the 0.3 recipe rules) ──

/**
 * Code points that are invisible, reorder text, or look like a plain space: controls (except
 * TAB and LF), format characters, default-ignorables and non-ASCII spaces. Reviewed text must
 * not display differently from what runs.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zs}\p{Zl}\p{Zp}⠀]/u;
export function isHiddenCodePoint(codePoint: number): boolean {
  if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x20) return false;
  return HIDDEN.test(String.fromCodePoint(codePoint));
}
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
/** Text stored and shown for human review: well-formed, no hidden or reordering characters. */
export function runtimeTextIssue(value: string): string | null {
  if (LONE_SURROGATE.test(value)) return "Text must be valid Unicode.";
  for (const char of value)
    if (isHiddenCodePoint(char.codePointAt(0) ?? 0))
      return "Text must not contain control or bidirectional formatting characters.";
  return null;
}
export const runtimeTextSchema = (maxBytes: number) =>
  z
    .string()
    .max(maxBytes)
    .superRefine((value, ctx) => {
      const issue = runtimeTextIssue(value);
      if (issue) ctx.addIssue({ code: "custom", message: issue });
      else if (utf8Bytes(value) > maxBytes)
        ctx.addIssue({ code: "custom", message: `Text must be at most ${maxBytes} bytes.` });
    });

// ── Hash-safe values ──
//
// `launchHash` is computed by the server over the parsed spec and by the node over the spec as
// received, so nothing in this file may transform a value (no .trim(), .default(), coercion):
// a schema only accepts or refuses. `apps/server/src/relay/frames.test.ts` checks parse(x) is canonically equal to x.

/** Text with no surrounding whitespace (refused, never trimmed). */
export const exactTextSchema = (maxBytes: number) =>
  runtimeTextSchema(maxBytes).refine(
    (value) => value.length > 0 && value.trim() === value,
    "Text must not be blank or have leading or trailing spaces.",
  );

/** A number canonical JSON can hash: a safe integer, or 1e-6 ≤ |x| < 1e15. */
export function isCanonicalNumber(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (Number.isInteger(value)) return Number.isSafeInteger(value);
  const magnitude = Math.abs(value);
  return magnitude >= 1e-6 && magnitude < 1e15;
}
export const canonicalNumberSchema = z
  .number()
  .refine(isCanonicalNumber, "Use a whole number or a decimal between 0.000001 and 1e15.");

const PLACEHOLDER = /\{\{([a-z_]+)\}\}/g;
export const runtimeCommandSchema = runtimeTextSchema(RUNTIME_COMMAND_MAX_BYTES)
  .refine((value) => value.trim().length > 0, "Command must not be blank.")
  .superRefine((value, ctx) => {
    for (const [, key] of value.matchAll(PLACEHOLDER))
      if (!(RUNTIME_PLACEHOLDERS as readonly string[]).includes(key ?? ""))
        ctx.addIssue({ code: "custom", message: `Unknown placeholder {{${key}}}.` });
  });

/** A served model id exactly as the relay normalizes it: trimmed, single line, ≤ 256 bytes. */
export const servedModelIdSchema = runtimeTextSchema(256)
  .refine((value) => value.length > 0 && value.trim() === value, {
    message: "Model ids must not be blank or have leading or trailing spaces.",
  })
  .refine((value) => !/[\n\t]/.test(value), "Model ids must be a single line.");

/** An origin-relative path: one leading slash, no `//`, `..`, `#`, `?`, backslash or `%2e`/`%2f`. */
export const runtimeRouteSchema = runtimeTextSchema(1024).refine(
  (value) =>
    /^\/(?!\/)[^\s#?\\]*$/.test(value) &&
    !value.split("/").includes("..") &&
    !/%2[ef]/i.test(value),
  "A route must start with a single / and contain no .., //, ?, #, backslash or encoded . or /.",
);

export const runtimeLabelsSchema = z
  .array(z.string().regex(RUNTIME_LABEL_PATTERN))
  .max(RUNTIME_LABELS_MAX)
  .refine((labels) => new Set(labels).size === labels.length, "Labels must be unique.");

// ── Models ──

/** Identity of a vector space (validate-only copy of `embedding-contract.ts` for hashing). */
export const specEmbeddingContractSchema = z
  .object({
    model: exactTextSchema(256),
    revision: exactTextSchema(256),
    dimensions: z.number().int().positive().max(1_000_000),
    normalization: z.enum(["none", "l2"]),
    vectorSpace: exactTextSchema(256),
  })
  .strict();

export const runtimeSpecModelSchema = z
  .object({
    id: servedModelIdSchema,
    capabilities: z.array(z.enum(MODEL_CAPABILITIES)).max(MODEL_CAPABILITIES.length).optional(),
    embeddingContract: specEmbeddingContractSchema.optional(),
    transcription: transcriptionProfileSchema.optional(),
  })
  .strict();
export type RuntimeSpecModel = z.infer<typeof runtimeSpecModelSchema>;

// ── Address (ALWAYS_ON) ──

export const nodeSecretNameSchema = z.string().regex(NODE_SECRET_PATTERN);
const envRefSchema = nodeSecretNameSchema;

/**
 * `http(s)://host[:port][/prefix]`, no userinfo, query or fragment. The host is `localhost` or
 * an IP literal; hostnames are refused so DNS rebinding cannot redirect a node (§4.3). Whether
 * a non-loopback IP is allowed is the node's decision (`config.json` `runtimeHosts`).
 */
export const runtimeBaseUrlSchema = z
  .string()
  .max(2048)
  .superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "Expected an http(s) URL." });
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      ctx.addIssue({ code: "custom", message: "Only http and https are allowed." });
    if (url.username || url.password || url.search || url.hash || value.includes("#"))
      ctx.addIssue({ code: "custom", message: "No user info, query or fragment." });
    if (url.hostname !== "localhost" && !isUrlIpHost(url.hostname))
      ctx.addIssue({ code: "custom", message: "The host must be localhost or an IP literal." });
    // The stored text is the normalized form, so TS and Rust URL parsers cannot disagree
    // (`http://2130706433/`, `/v1/../x`, upper-case schemes are refused, not normalized).
    const normalized = url.pathname === "/" ? url.origin : `${url.origin}${url.pathname}`;
    if (value !== normalized)
      ctx.addIssue({ code: "custom", message: `Write the address as ${normalized}.` });
    if (url.pathname !== "/" && !/^(\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+$/.test(url.pathname))
      ctx.addIssue({ code: "custom", message: "The API prefix must be a plain path." });
  });

export const runtimeAddressSchema = z
  .object({
    baseUrl: runtimeBaseUrlSchema,
    auth: z
      .object({
        mode: z.enum(["bearer", "header"]),
        header: z
          .string()
          .regex(/^[A-Za-z0-9-]{1,64}$/)
          .optional(),
        env: envRefSchema,
      })
      .strict()
      .refine((auth) => (auth.mode === "header") === (auth.header !== undefined), {
        message: "A header name is required exactly for mode header.",
        path: ["header"],
      })
      .optional(),
    headers: z
      .array(
        z
          .object({
            name: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
            env: envRefSchema,
          })
          .strict(),
      )
      .max(16)
      .optional(),
  })
  .strict();
export type RuntimeAddress = z.infer<typeof runtimeAddressSchema>;

// ── Launch (STARTABLE) ──

/** GiB (2^30 bytes), like node budgets. */
const gib = canonicalNumberSchema.refine(
  (value) => value > 0 && value <= 1_000_000,
  "0 < GiB ≤ 1e6.",
);
export const GPU_VENDORS = ["nvidia", "amd", "intel", "apple", "other"] as const;
export type GpuVendor = (typeof GPU_VENDORS)[number];

export const runtimeResourceSchema = z.discriminatedUnion("kind", [
  /** Takes no node memory budget (a quick service wrap; F6). */
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("unified"), memoryGb: gib }).strict(),
  z.object({ kind: z.literal("cpu"), ramGb: gib }).strict(),
  z
    .object({
      kind: z.literal("discrete"),
      gpuCount: z.number().int().min(1).max(256),
      vramGb: gib,
      ramGb: gib.optional(),
      vendor: z.enum(GPU_VENDORS).optional(),
    })
    .strict(),
]);
export type RuntimeResource = z.infer<typeof runtimeResourceSchema>;

const interactiveSchema = z
  .object({
    start: z.literal(true).optional(),
    stop: z.literal(true).optional(),
    prepare: z.literal(true).optional(),
    afterJoin: z.literal(true).optional(),
  })
  .strict();

const timeoutsSchema = z
  .object({
    prepare: z.number().int().min(1).max(RUNTIME_TIMEOUTS_SEC.prepare.max).optional(),
    start: z.number().int().min(1).max(RUNTIME_TIMEOUTS_SEC.start.max).optional(),
    afterJoin: z.number().int().min(1).max(RUNTIME_TIMEOUTS_SEC.afterJoin.max).optional(),
    stop: z.number().int().min(1).max(RUNTIME_TIMEOUTS_SEC.stop.max).optional(),
    status: z.number().int().min(1).max(RUNTIME_TIMEOUTS_SEC.status.max).optional(),
  })
  .strict();

export const runtimeCommandsSchema = z
  .object({
    start: runtimeCommandSchema,
    stop: runtimeCommandSchema,
    prepare: runtimeCommandSchema.optional(),
    afterJoin: runtimeCommandSchema.optional(),
    status: runtimeCommandSchema.optional(),
    health: runtimeCommandSchema.optional(),
    interactive: interactiveSchema.optional(),
    timeoutsSec: timeoutsSchema.optional(),
  })
  .strict();
export type RuntimeCommands = z.infer<typeof runtimeCommandsSchema>;

export const runtimeLaunchSchema = z
  .object({
    /** `process`: the node owns the unit (was ownedProcess); `service`: stop/status prove it. */
    management: z.enum(["process", "service"]),
    groupSize: z.number().int().min(1).max(RUNTIME_GROUP_SIZE_MAX),
    resources: z.array(runtimeResourceSchema).min(1).max(RUNTIME_GROUP_SIZE_MAX),
    labels: runtimeLabelsSchema,
    port: z
      // Ports below 1024 are refused here as on the node (§4.6), never only at dispatch.
      .object({ fixed: z.number().int().min(1024).max(65_535) })
      .strict()
      .optional(),
    /**
     * Multi-node only: the fabric every rank must share (by name). Absent: any fabric shared by
     * enough free nodes. Placement never splits an instance across fabrics (`no_shared_fabric`).
     */
    fabric: z.string().regex(FABRIC_NAME_PATTERN).optional(),
    commands: z.array(runtimeCommandsSchema).min(1).max(RUNTIME_GROUP_SIZE_MAX),
    /** Node secrets exported (by name) to every command of this runtime. */
    secrets: z.array(nodeSecretNameSchema).max(NODE_SECRETS_MAX).optional(),
    /**
     * HTTP readiness on the instance port. Required when the runtime serves models; a service
     * (no models) may instead prove readiness and health with `status`/`health` commands.
     */
    readiness: z
      .object({
        path: runtimeRouteSchema,
        expectedStatus: z.number().int().min(200).max(399),
        timeoutMs: z.number().int().min(1_000).max(3_600_000),
      })
      .strict()
      .optional(),
    health: z
      .object({
        intervalMs: z.number().int().min(5_000).max(300_000),
        failureThreshold: z.number().int().min(1).max(20),
        successThreshold: z.number().int().min(1).max(20),
      })
      .strict(),
  })
  .strict()
  .superRefine((launch, ctx) => {
    for (const key of ["resources", "commands"] as const)
      if (launch[key].length !== 1 && launch[key].length !== launch.groupSize)
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Provide one entry for every rank or exactly one per rank.",
        });
    if (launch.fabric && launch.groupSize === 1)
      ctx.addIssue({
        code: "custom",
        path: ["fabric"],
        message: "Only a multi-node runtime names a fabric.",
      });
    if (launch.port && launch.groupSize !== 1)
      ctx.addIssue({
        code: "custom",
        path: ["port"],
        message: "A fixed port needs groupSize 1.",
      });
    launch.commands.forEach((commands, index) => {
      const path = ["commands", index];
      const interactive = commands.interactive;
      const anyInteractive = !!interactive && Object.values(interactive).some(Boolean);
      if (launch.management === "service" && !commands.status?.trim())
        ctx.addIssue({
          code: "custom",
          path: [...path, "status"],
          message: "Service runtimes need a status command (exit 0 alive, exit 3 stopped).",
        });
      if (anyInteractive && !commands.status?.trim())
        ctx.addIssue({
          code: "custom",
          path: [...path, "status"],
          message: "Interactive commands need a status command.",
        });
      if ((interactive?.start || interactive?.afterJoin) && launch.management !== "service")
        ctx.addIssue({
          code: "custom",
          path: ["management"],
          message: "An interactive start or afterJoin needs management service.",
        });
      for (const field of ["prepare", "afterJoin"] as const)
        if (interactive?.[field] && !commands[field])
          ctx.addIssue({
            code: "custom",
            path: [...path, "interactive", field],
            message: `An interactive ${field} needs a ${field} command.`,
          });
    });
  });
export type RuntimeLaunch = z.infer<typeof runtimeLaunchSchema>;

// ── Metrics reader ──

export const readerMapEntrySchema = z
  .object({
    /** A Prometheus series name or an RFC 6901 JSON pointer. */
    series: exactTextSchema(256),
    labels: z
      .record(z.string().regex(METRIC_SERIES_NAME_PATTERN), z.string().min(1).max(64))
      .refine((labels) => Object.keys(labels).length <= 16, "At most 16 labels.")
      .optional(),
    aggregate: z.enum(["sum", "max", "first"]).optional(),
    scale: canonicalNumberSchema.optional(),
    /** Divide by this other series (same syntax), e.g. used/total. */
    divideBy: exactTextSchema(256).optional(),
  })
  .strict();
export const readerMapSchema = z.partialRecord(z.enum(READER_SIGNALS), readerMapEntrySchema);
export type ReaderMap = z.infer<typeof readerMapSchema>;

const readerIntervalSchema = z.number().int().min(2).max(60);
export const metricsReaderSchema = z.discriminatedUnion("kind", [
  /** By engine: vLLM/SGLang `/metrics`, llama.cpp `/slots`. */
  z.object({ kind: z.literal("builtin") }).strict(),
  z
    .object({
      kind: z.literal("route"),
      route: runtimeRouteSchema,
      format: z.enum(["json", "prometheus"]),
      intervalSecs: readerIntervalSchema.optional(),
      map: readerMapSchema,
      /** POST route that counts a Chat Completions body's tokens. */
      countRoute: runtimeRouteSchema.optional(),
    })
    .strict(),
  /** Runs on the node: needs Full control when defined (frozen at Relay only). */
  z
    .object({
      kind: z.literal("command"),
      command: runtimeCommandSchema,
      format: z.enum(["json", "prometheus"]),
      intervalSecs: readerIntervalSchema.optional(),
      map: readerMapSchema,
    })
    .strict(),
]);
export type MetricsReader = z.infer<typeof metricsReaderSchema>;

// ── The spec ──

/**
 * A runtime that serves models has `api`, `engine`, `modelType` and `models`; a SERVICE (owner
 * decision round 3: "no proxying", e.g. another project's node agent) has none of them. A
 * service is startable only, claims its declared resources (it may claim a whole node), is
 * never a pool member and never appears on the Models page.
 */
export const runtimeSpecSchema = z
  .object({
    api: z.enum(RUNTIME_APIS).optional(),
    engine: z.enum(ENGINES).optional(),
    modelType: z.enum(MODEL_TYPES).optional(),
    models: z.array(runtimeSpecModelSchema).min(1).max(RUNTIME_MODELS_MAX).optional(),
    address: runtimeAddressSchema.optional(),
    launch: runtimeLaunchSchema.optional(),
    metricsReader: metricsReaderSchema.optional(),
    expandMedia: z.boolean().optional(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const bytes = canonicalBytes(spec);
    if (bytes === null || bytes > RUNTIME_SPEC_MAX_BYTES)
      ctx.addIssue({
        code: "custom",
        message: `A runtime definition is at most ${RUNTIME_SPEC_MAX_BYTES} bytes as canonical JSON.`,
      });
    if ((spec.address === undefined) === (spec.launch === undefined))
      ctx.addIssue({
        code: "custom",
        message: "A runtime has exactly one of address (always-on) or launch (startable).",
      });
    // An always-on runtime always serves (its models may be discovered); a startable one
    // serves exactly when it lists models.
    const serves = spec.address !== undefined || spec.models !== undefined;
    for (const key of ["api", "engine", "modelType"] as const)
      if ((spec[key] !== undefined) !== serves)
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: serves
            ? "A runtime that serves models declares api, engine and modelType."
            : "A service (no models) has no api, engine or modelType.",
        });
    if (!serves && (spec.metricsReader || spec.expandMedia !== undefined))
      ctx.addIssue({
        code: "custom",
        message: "A service has no metrics reader or media expansion.",
      });
    if (spec.launch && serves && !spec.launch.readiness)
      ctx.addIssue({
        code: "custom",
        path: ["launch", "readiness"],
        message: "A runtime that serves models needs an HTTP readiness check.",
      });
    if (
      spec.launch &&
      !serves &&
      !spec.launch.readiness &&
      !spec.launch.commands.every((commands) => commands.status || commands.health)
    )
      ctx.addIssue({
        code: "custom",
        path: ["launch", "readiness"],
        message: "A service needs an HTTP readiness check or a status/health command per rank.",
      });
    const ids = new Set<string>();
    spec.models?.forEach((model, index) => {
      if (ids.has(model.id))
        ctx.addIssue({ code: "custom", path: ["models", index, "id"], message: "Duplicate id." });
      ids.add(model.id);
      if (model.embeddingContract && spec.modelType !== "embeddings")
        ctx.addIssue({
          code: "custom",
          path: ["models", index, "embeddingContract"],
          message: "Embedding contracts need modelType embeddings.",
        });
      if (model.transcription && spec.modelType !== "transcription")
        ctx.addIssue({
          code: "custom",
          path: ["models", index, "transcription"],
          message: "A transcription profile needs modelType transcription.",
        });
    });
    if (spec.api === "anthropic" && spec.modelType !== "llm")
      ctx.addIssue({
        code: "custom",
        path: ["modelType"],
        message: "Anthropic runtimes serve LLMs only.",
      });
  });
export type RuntimeSpec = z.infer<typeof runtimeSpecSchema>;

export function runtimeSpecKind(spec: Pick<RuntimeSpec, "launch">): RuntimeKindWire {
  return spec.launch ? "startable" : "always_on";
}

/** A service: startable, no models, never proxied. */
export function runtimeSpecIsService(spec: Pick<RuntimeSpec, "models" | "address">): boolean {
  return spec.models === undefined && spec.address === undefined;
}

// ── Node definition parts (pushed with `runtime.define.node`) ──

export const nodeMetricCommandSchema = z
  .object({
    name: z.string().regex(NODE_METRIC_COMMAND_NAME_PATTERN),
    command: runtimeCommandSchema,
    intervalSecs: z.number().int().min(5).max(3_600),
    timeoutSecs: z.number().int().min(1).max(60),
    /**
     * `lines`: `<metric> <value>` per line. `json` / `prometheus` without `map`: one number
     * (top-level JSON number / first sample) recorded as `name`.
     */
    format: z.enum(["json", "prometheus", "lines"]),
    /** Metric name → where to read it. */
    map: z
      .record(z.string().regex(METRIC_SERIES_NAME_PATTERN), readerMapEntrySchema)
      .refine((map) => Object.keys(map).length <= 16, "At most 16 metrics per command.")
      .optional(),
  })
  .strict();
export type NodeMetricCommand = z.infer<typeof nodeMetricCommandSchema>;

/** Canonical UTF-8 size, or null when the value cannot be hashed (other issues report why). */
export function canonicalBytes(value: unknown): number | null {
  try {
    return utf8Bytes(canonicalJson(value));
  } catch {
    return null;
  }
}

export const nodeMetricCommandsSchema = z
  .array(nodeMetricCommandSchema)
  .max(NODE_METRIC_COMMANDS_MAX)
  .refine(
    (commands) => new Set(commands.map((command) => command.name)).size === commands.length,
    "Metric command names must be unique.",
  )
  .refine((commands) => {
    const bytes = canonicalBytes(commands);
    return bytes !== null && bytes <= NODE_METRIC_COMMANDS_MAX_BYTES;
  }, `Node metric commands are at most ${NODE_METRIC_COMMANDS_MAX_BYTES} bytes together.`);

// ── Fabrics (part of the node definition; frozen at Relay only) ──

export const fabricNameSchema = z.string().regex(FABRIC_NAME_PATTERN);
/**
 * The node's address on a fabric: a canonical IP literal, never unspecified, loopback or
 * IPv4-mapped (`ip-literal.ts`; the node and the database apply the same rule).
 */
export const fabricIpSchema = z
  .string()
  .max(39)
  .refine(isFabricIp, "Expected the node's IP address on this fabric (e.g. 10.0.0.5 or fd00::5).");

/** A node's memberships as people and agents edit them (`nodes.update`). */
export const nodeFabricMembershipsSchema = z
  .array(z.object({ name: fabricNameSchema, ip: fabricIpSchema }).strict())
  .max(NODE_FABRICS_MAX)
  .refine(
    (fabrics) => new Set(fabrics.map((fabric) => fabric.name)).size === fabrics.length,
    "A node joins each fabric once.",
  );

/**
 * The fabric part of a node's definition, as pushed in `runtime.define` (node part) and frozen
 * at Relay only: every fabric the node is in, with its own IP and every member's IP. Sorted by
 * fabricId; `memberIps` sorted and including `selfIp`. Its hash is `nodeFabricsHash`.
 */
export const nodeFabricSetsSchema = z
  .array(
    z
      .object({
        fabricId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        name: fabricNameSchema,
        selfIp: fabricIpSchema,
        memberIps: z.array(fabricIpSchema).min(1).max(FABRIC_MEMBERS_MAX),
      })
      .strict()
      .refine((set) => set.memberIps.includes(set.selfIp), "memberIps includes selfIp."),
  )
  .max(NODE_FABRICS_MAX);
export type NodeFabricSets = z.infer<typeof nodeFabricSetsSchema>;

// ── Definition warnings (never refusals) ──

export const RUNTIME_SPEC_WARNINGS = ["binds_all_interfaces"] as const;
export type RuntimeSpecWarning = (typeof RUNTIME_SPEC_WARNINGS)[number];

const ALL_INTERFACES = /(?:^|[\s=:'"(,/])(?:0\.0\.0\.0|\[::\]|::)(?=$|[\s:'"/),\]])/;
/** `vllm serve` binds every interface unless told otherwise. */
const VLLM_SERVE_WITHOUT_HOST = /(?:^|[\s;&|])vllm\s+serve\b(?![^;&|]*--host[\s=])/;

/**
 * Warnings for a valid spec. `binds_all_interfaces`: a command or address binds 0.0.0.0 or
 * `::` (also `vllm serve` without `--host`, whose default is every interface), which exposes
 * the server beyond the node (single-node presets bind 127.0.0.1; a
 * multi-node runtime binds the fabric with `{{fabric_ip}}`).
 */
export function runtimeSpecWarnings(spec: RuntimeSpec): RuntimeSpecWarning[] {
  const texts: string[] = [];
  if (spec.address) texts.push(spec.address.baseUrl);
  for (const commands of spec.launch?.commands ?? [])
    for (const value of Object.values(commands)) if (typeof value === "string") texts.push(value);
  return texts.some((text) => ALL_INTERFACES.test(text) || VLLM_SERVE_WITHOUT_HOST.test(text))
    ? ["binds_all_interfaces"]
    : [];
}

/** `[start, end]`, 1024 ≤ start ≤ end ≤ 65535. */
export const portRangeSchema = z
  .tuple([z.number().int().min(1024).max(65_535), z.number().int().min(1024).max(65_535)])
  .refine(([start, end]) => start <= end, "The port range must not be reversed.");

// ── Declared hardware (browser `Node.declaredResources`, node `config.json` `hardware`) ──

const gpuKeySchema = z
  .string()
  .regex(/^(?:[A-Za-z0-9-]{1,64}|(?:nvidia|amd|intel|apple|other):[0-9]{1,3})$/);
export const declaredHardwareSchema = z
  .object({
    kind: z.enum(["cpu", "discrete", "unified"]).optional(),
    memoryGb: gib.optional(),
    acceleratorMemoryGb: gib.optional(),
    /** Used by things outside wsmp (always-on servers, the desktop). */
    reservedMemoryGb: canonicalNumberSchema
      .refine((value) => value >= 0 && value <= 1_000_000)
      .optional(),
    reservedVramGb: z
      .record(
        gpuKeySchema,
        canonicalNumberSchema.refine((value) => value >= 0 && value <= 1_000_000),
      )
      .refine((map) => Object.keys(map).length <= 256, "At most 256 GPUs.")
      .optional(),
    gpus: z
      .array(
        z
          .object({
            vendor: z.enum(GPU_VENDORS),
            index: z.number().int().min(0).max(255),
            name: exactTextSchema(256).optional(),
            vramGb: gib,
          })
          .strict(),
      )
      .max(32)
      .optional(),
  })
  .strict();
export type DeclaredHardware = z.infer<typeof declaredHardwareSchema>;

/** The node-side declaration also carries labels (config.json `hardware.labels`). */
export const nodeDeclaredHardwareSchema = declaredHardwareSchema
  .extend({ labels: runtimeLabelsSchema.optional() })
  .strict();
export type NodeDeclaredHardware = z.infer<typeof nodeDeclaredHardwareSchema>;

// ── Node features (hello / node.state; evidence only, never a setting) ──

export const nodeFeaturesSchema = z
  .object({
    terminals: z
      .object({
        supported: z.boolean(),
        max: z.number().int().min(0).max(64),
        approvalRequired: z.boolean(),
      })
      .strict(),
    operatorTerminals: z.boolean(),
    files: z
      .object({
        roots: z.array(z.string().min(1).max(4096)).max(64).nullable(),
        asRoot: z.boolean(),
      })
      .strict(),
    /** `ip[:port]` entries from config.json. */
    runtimeHosts: z
      .array(z.string().regex(/^(?:[0-9.]{7,15}|\[[0-9A-Fa-f:.]{2,45}\])(?::[0-9]{1,5})?$/))
      .max(64),
    mediaExpand: z.boolean(),
    liveStt: z.boolean(),
    /** The node's secrets: names and when they were last set (never values). */
    secrets: z
      .array(z.object({ name: nodeSecretNameSchema, updatedAt: z.iso.datetime() }).strict())
      .max(NODE_SECRETS_MAX),
  })
  .strict();
export type NodeFeatures = z.infer<typeof nodeFeaturesSchema>;
