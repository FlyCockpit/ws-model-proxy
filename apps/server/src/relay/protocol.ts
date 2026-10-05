import {
  type OpenAiCompatibleCapabilities,
  openAiCompatibleCapabilitiesSchema,
} from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import {
  RELAY_MIN_PROTOCOL_VERSION,
  RELAY_PROTOCOL_VERSIONS,
  type RelayProtocolVersion,
  refusedRelayProtocolReason,
  relayProtocolAtLeast,
} from "@ws-model-proxy/api/lib/relay-protocol-version";
import { adapterRouteIsValid } from "@ws-model-proxy/api/lib/remote-engine-adapters";
import { normalizeReportedHostname } from "@ws-model-proxy/config/cli-device-name";
import {
  deploymentJobOperatorValid,
  isCanonicalBase64Url16,
} from "@ws-model-proxy/config/deployment-job-wire";
import {
  DEPLOYMENT_OPERATOR_RESULT_STATUSES,
  type DeploymentJob,
  deploymentOperatorResultStatus,
} from "@ws-model-proxy/config/deployment-protocol";
import { z } from "zod";
import {
  FILE_BODY_MAX_BYTES,
  type FileOp,
  type FileOpFrame,
  fileBodyMetadataSchema,
  fileDataMetadataSchema,
  fileRejectedFrameSchema,
  fileResultFrameSchema,
  fileSpawnSpecSchema,
  supervisedFileErrorSchema,
  supervisedFileResultSchema,
} from "./file-protocol.js";
import { type RelayFailure, relayFailureSchema } from "./relay-failure.js";
import {
  STT_AUDIO_FRAME_MAX_BYTES,
  type SttServerControlMessage,
  sttAudioBodyValid,
  sttAudioMetadataSchema,
  sttClientControlSchemas,
  sttServerControlSchema,
} from "./stt-protocol.js";
import { isWellFormedText, stringifyWellFormed } from "./wire-text.js";

export {
  RELAY_MIN_PROTOCOL_VERSION,
  RELAY_PROTOCOL_VERSIONS,
  type RelayFailure,
  type RelayProtocolVersion,
  refusedRelayProtocolReason,
  relayProtocolAtLeast,
};

type FileSpawnSpec = z.infer<typeof fileSpawnSpecSchema>;

/**
 * Sent as `protocol.error` to a CLI whose hello is older than 2.4. Every
 * released wsmp prints `relay protocol error: <message>` and exits, so this
 * text is what the person sees. It names the protocol rather than a wsmp
 * version: the first release that speaks 2.4 is cut separately.
 */
export const RELAY_UPGRADE_REQUIRED_MESSAGE = `This server requires a newer wsmp (relay protocol ${RELAY_MIN_PROTOCOL_VERSION}). Upgrade wsmp and restart it.`;
export const RELAY_SERVER_UPGRADE_REQUIRED_MESSAGE =
  "This wsmp speaks a newer relay protocol than the server. Upgrade WS Model Proxy and restart the CLI.";
export const RELAY_SUBPROTOCOL = "ws-model-proxy.relay.v2";

export const RELAY_PROTOCOL_ERROR_CODES = [
  "upgrade_cli",
  "upgrade_server",
  "identity_mismatch",
  "access_denied",
  "malformed",
  "internal",
] as const;
export type RelayProtocolErrorCode = (typeof RELAY_PROTOCOL_ERROR_CODES)[number];

const RELAY_JSON_CONTROL_MAX_BYTES = 64 * 1024;
export const RELAY_BINARY_CHUNK_MAX_BYTES = 1024 * 1024;
/** 4-byte metadata length + 64 KiB metadata + 1 MiB body. Shared by both sockets. */
export const RELAY_WS_MAX_PAYLOAD_BYTES =
  4 + RELAY_JSON_CONTROL_MAX_BYTES + RELAY_BINARY_CHUNK_MAX_BYTES;
// Request-body flow control window. The server may have at most this many
// request-body chunks in flight toward a CLI before it must wait for the CLI to
// acknowledge consumed chunks (`relay.request.body.ack`). It bounds CLI-side
// buffering to `RELAY_REQUEST_BODY_WINDOW_CHUNKS * RELAY_BINARY_CHUNK_MAX_BYTES`
// per request so large request bodies stream without full buffering while one
// slow upstream cannot stall sibling requests multiplexed on the same socket.
export const RELAY_REQUEST_BODY_WINDOW_CHUNKS = 16;
export const RELAY_STALE_AFTER_MS = 60_000;
export const RELAY_UNREGISTERED_STALE_AFTER_MS = 10_000;

/** CLI sends a numeric Unix signal. Names are accepted too. */
const relayExitSignalSchema = z.preprocess(
  (value) => (typeof value === "number" ? String(value) : value),
  z
    .string()
    .regex(/^[A-Za-z0-9_+.-]{1,32}$/)
    .optional(),
);

const requestIdSchema = z.string().trim().min(1).max(128);
const headerNameSchema = z.string().trim().min(1).max(128);
const headerValueSchema = z.string().max(8192);
const headerSchema = z.record(headerNameSchema, headerValueSchema);
const orderedHeadersSchema = z.array(z.tuple([headerNameSchema, headerValueSchema])).max(256);

export { type OpenAiCompatibleCapabilities, openAiCompatibleCapabilitiesSchema };

/** 16 raw bytes, canonical unpadded base64url (22 characters, zero trailing bits). */
export const base64Url16ByteSchema = z
  .string()
  .refine(isCanonicalBase64Url16, { message: "Expected 16 bytes of canonical base64url." });

/** Uncompressed P-256 point: 65 bytes, leading 0x04, unpadded base64url (87 characters). */
export const uncompressedP256PublicKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{87}$/)
  .refine((value) => {
    const bytes = Buffer.from(value, "base64url");
    return bytes.length === 65 && bytes[0] === 0x04;
  }, "Expected a 65-byte uncompressed P-256 public key.");

/** IEEE P1363 P-256 signature: 64 bytes, unpadded base64url (86 characters). */
export const p256SignatureSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{86}$/)
  .refine((value) => Buffer.from(value, "base64url").length === 64, {
    message: "Expected a 64-byte P-256 signature.",
  });

/**
 * The CLI's long-lived identity key and its signature over
 * `lp16("wsmp-term-cli-id-v1") ‖ lp16(cliSlug) ‖ terminalPublicKey`. The relay
 * does not verify this ECDH proof; browsers do, and pin the key per CLI device.
 * Hello also signs a server nonce with the same key (`cli.identitySignature`).
 */
export const cliTerminalIdentitySchema = z
  .object({
    publicKey: uncompressedP256PublicKeySchema,
    signature: p256SignatureSchema,
  })
  .strict();

export type CliTerminalIdentity = z.infer<typeof cliTerminalIdentitySchema>;

/** Server-minted per attachment (2.5). Same shape as a terminal id. */
const viewerIdSchema = base64Url16ByteSchema;

const base64UrlTextSchema = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/);
const terminalIdentitySchema = z
  .object({
    publicKey: base64UrlTextSchema,
    signature: base64UrlTextSchema.optional(),
  })
  .strict();

const mcpCommandModeSchema = z.enum(["off", "supervised", "unsupervised"]);

const cliFeatureSchema = z
  .object({
    humanTerminal: z.boolean(),
    /** The CLI's own MCP command policy (`wsmp config set-mcp-commands`). */
    mcpCommandMode: mcpCommandModeSchema,
    terminalApproval: z.boolean(),
    terminalSupported: z.boolean(),
    /** The CLI accepts remotely defined metric sources (`metrics.sources.set`). */
    remoteMetricSources: z.boolean(),
    /** The CLI accepts remotely defined engine adapters (`engine.adapters.set`). */
    remoteEngineAdapters: z.boolean(),
    /** The CLI's read-only file grant (`wsmp config set-file-read`). */
    mcpFileRead: z.boolean(),
    /** The CLI has `fileRoots` configured (mandatory for the read grant). */
    fileRootsConfigured: z.boolean(),
    /** `wsmp config set-file-tools-as-root on` (default off). */
    allowFileToolsAsRoot: z.boolean(),
    deployments: z.boolean().optional().default(false),
    /**
     * The CLI can run interactive deployment commands in an operator terminal. Counts only
     * with `deployments` (`deploymentOperatorSupported`).
     */
    deploymentOperator: z.boolean().optional().default(false),
  })
  .strict();

/**
 * Hello capabilities: only fields that vary per CLI. Protocol 2.4 always
 * implements inventory, binary frames, terminals, exec, node telemetry,
 * file ops, and context.count.
 */
const cliCapabilitiesSchema = z
  .object({
    features: cliFeatureSchema,
    terminalPublicKey: uncompressedP256PublicKeySchema,
    /** Absent when the CLI could not load its identity; browsers then refuse it. */
    terminalIdentity: cliTerminalIdentitySchema.optional(),
  })
  .strict();

export const ENGINE_KINDS = [
  "generic",
  "llama.cpp",
  "vllm",
  "sglang",
  "ollama",
  "lm-studio",
] as const;
const engineFactSourceSchema = z.enum(["probe", "config", "custom"]);
const engineLoadSignalSchema = z.enum([
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
]);

function engineFact<T extends z.ZodType>(value: T) {
  return z.object({ value, source: engineFactSourceSchema }).strict();
}

const TOKEN_COUNT_MAX = 1_000_000_000_000;
const engineTokenCountSchema = z.number().int().min(1).max(TOKEN_COUNT_MAX);

/**
 * 2.7 static engine facts, per endpoint and per model (a model's fields
 * override its endpoint's). Every fact names its source. Digest-excluded,
 * like `concurrencyLimit`.
 */
export const engineFactsSchema = z
  .object({
    engine: engineFact(z.enum(ENGINE_KINDS)).optional(),
    /** Concurrent sequences: llama.cpp `total_slots`, SGLang `max_running_requests`. */
    slots: engineFact(z.number().int().min(1).max(10_000)).optional(),
    ctxPerSlot: engineFact(engineTokenCountSchema).optional(),
    /** Total KV capacity in tokens (vLLM blocks × block size, SGLang max tokens). */
    kvTokens: engineFact(engineTokenCountSchema).optional(),
    maxModelLen: engineFact(engineTokenCountSchema).optional(),
    /** llama.cpp `--cache-ram`. */
    hostPromptCacheMiB: engineFact(z.number().int().min(0).max(100_000_000)).optional(),
    /** Model ids one engine process serves. */
    servedModelAliases: engineFact(
      z.array(z.string().trim().min(1).max(512)).min(1).max(64),
    ).optional(),
    /** 2.9: a custom engine adapter is configured. Always source `config`. */
    loadAdapter: z
      .object({
        value: z
          .object({
            input: z.enum(["route", "command"]),
            signals: z.array(engineLoadSignalSchema).max(16),
          })
          .strict(),
        source: z.literal("config"),
      })
      .strict()
      .optional(),
    /** Chat Completions tokenize fact recorded at probe time. */
    countContext: engineFact(
      z.enum([
        "unsupported",
        "vllm_tokenize",
        "tgi_chat_tokenize",
        "llama_apply_template",
        "llama_input_tokens",
        "adapter_count",
      ]),
    ).optional(),
  })
  .strict();

const discoveredModelSchema = z
  .object({
    slug: z.string().trim().min(1).max(128).optional(),
    upstreamModelId: z.string().trim().min(1).max(512),
    capabilities: openAiCompatibleCapabilitiesSchema.optional(),
    capabilityOverrideMode: z.enum(["inherit", "override"]).default("inherit"),
    probeSuggestions: openAiCompatibleCapabilitiesSchema.optional(),
    // Optional per-model hard concurrency. Absent means the registration
    // default. Omitted from the inventory digest: an existing capacity is kept.
    concurrencyLimit: z.number().int().min(1).max(10_000).optional(),
    engineFacts: engineFactsSchema.optional(),
  })
  .strict();

const endpointInventorySchema = z
  .object({
    slug: z.string().trim().min(1).max(63),
    deploymentInstanceId: z.string().min(1).max(128).optional(),
    label: z.string().trim().min(1).max(160),
    kind: z.enum(["openai-compatible", "anthropic-compatible"]),
    status: z.enum(["unknown", "online", "degraded", "offline"]).default("unknown"),
    defaultCapabilities: openAiCompatibleCapabilitiesSchema,
    probeSuggestions: openAiCompatibleCapabilitiesSchema.optional(),
    models: z.array(discoveredModelSchema).max(1000).default([]),
    engineFacts: engineFactsSchema.optional(),
  })
  .strict()
  .superRefine((endpoint, context) => {
    const expected = endpoint.kind;
    const profiles = [
      endpoint.defaultCapabilities,
      endpoint.probeSuggestions,
      ...endpoint.models.flatMap((model) => [model.capabilities, model.probeSuggestions]),
    ];
    for (const profile of profiles) {
      if ((profile?.version === 3 || profile?.version === 4) && profile.protocol !== expected) {
        context.addIssue({
          code: "custom",
          path: ["defaultCapabilities", "protocol"],
          message: "Capability protocol must match endpoint kind.",
        });
        return;
      }
      if (profile && profile.version < 3 && expected !== "openai-compatible") {
        context.addIssue({
          code: "custom",
          path: ["defaultCapabilities", "version"],
          message: "Anthropic-compatible endpoints require capability inventory version 3.",
        });
        return;
      }
    }
  });

export type EndpointInventory = z.infer<typeof endpointInventorySchema>;

/** Custom metric names, label keys and label values (S-B part 2). */
export const METRIC_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const metricNameSchema = z.string().regex(METRIC_NAME_PATTERN);
/**
 * A label key becomes an object key, and `__proto__` matches the pattern but
 * zod's record drops it silently (before any key schema runs). Reject it
 * up front, on the input, as the CLI does (`is_label_key`), so both sides
 * agree on what a series is.
 */
export const RESERVED_LABEL_KEYS = ["__proto__"] as const;
const labelsSchema = z
  .custom<Record<string, string>>(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      !RESERVED_LABEL_KEYS.some((key) => Object.hasOwn(value, key)),
    { message: "A label key is reserved." },
  )
  .pipe(z.record(metricNameSchema, metricNameSchema));
export const NODE_METRICS_CUSTOM_MAX = 50;
export const NODE_METRIC_SOURCES_MAX = 50;
export const NODE_ENGINE_ADAPTERS_MAX = 64;
const MIB_MAX = 1_000_000_000;
const mibSchema = z.number().int().min(0).max(MIB_MAX);
/**
 * Free text stored in the `CliDevice` JSON snapshot. PostgreSQL JSONB cannot
 * hold NUL or an unpaired UTF-16 surrogate, so such text is refused here,
 * before any rate-limit slot is spent (the write would fail after it).
 */
function storedTextSchema(max: number, trim = true) {
  return (trim ? z.string().trim() : z.string())
    .min(1)
    .max(max)
    .refine((value) => !value.includes("\u0000") && isWellFormedText(value), {
      message: "Text must not contain NUL or unpaired surrogates.",
    });
}
const shortTextSchema = storedTextSchema(256);
const percentSchema = z.number().min(0).max(100);
const nonNegativeCountSchema = z.number().int().min(0).max(1_000_000);
const byteCounterSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const finiteNumberSchema = z.number().finite();
/** nvidia-smi `[N/A]` becomes an omitted field or null. */
const gpuReadingSchema = (schema: z.ZodNumber) => schema.nullable().optional();
const interfaceNameSchema = z.string().regex(/^[A-Za-z0-9_.:@-]{1,64}$/);

const nodeInfoSchema = z
  .object({
    type: z.literal("node.info"),
    os: z
      .object({
        name: shortTextSchema.optional(),
        version: shortTextSchema.optional(),
        kernel: shortTextSchema.optional(),
        arch: storedTextSchema(32).optional(),
      })
      .strict()
      .optional(),
    cpu: z
      .object({
        model: shortTextSchema.optional(),
        cores: z.number().int().min(1).max(65_536).optional(),
      })
      .strict()
      .optional(),
    memoryTotalMiB: mibSchema.optional(),
    gpus: z
      .array(
        z
          .object({
            index: z.number().int().min(0).max(255),
            name: shortTextSchema.optional(),
            uuid: storedTextSchema(128).optional(),
            driverVersion: storedTextSchema(64).optional(),
            vramTotalMiB: mibSchema.nullable().optional(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    unifiedMemory: z.boolean().optional(),
    nodeKind: z.enum(["unified", "discrete", "cpu"]).optional(),
    interfaces: z
      .array(
        z
          .object({
            name: interfaceNameSchema,
            addresses: z.array(storedTextSchema(64)).max(16).optional(),
            linkSpeedMbps: z.number().int().min(0).max(10_000_000).optional(),
            mtu: z.number().int().min(0).max(1_000_000).optional(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    executionMechanism: z
      .enum([
        "foreground",
        "systemd",
        "launchd",
        "container",
        "systemd+linger",
        "systemd-no-linger",
        "macos",
        "unsupported",
      ])
      .optional(),
    cliVersion: storedTextSchema(80).optional(),
  })
  .strict();
export type NodeInfoMessage = z.infer<typeof nodeInfoSchema>;

const metricSourceStatusSchema = z
  .object({
    name: metricNameSchema,
    origin: z.enum(["local", "remote"]),
    state: z.enum(["active", "pending_approval", "refused", "unsupported", "disabled", "failing"]),
    commandSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    /**
     * The source's run interval. Local sources exist only in the CLI config,
     * so this is how the server learns their cadence: a source's series are
     * stale after 3x this (S-B part 2). Absent for a source with no schedule.
     */
    intervalSecs: z.number().int().min(5).max(86_400).optional(),
    /** A reason code only: command output and stderr never leave the CLI. */
    error: z.enum(["spawn", "timeout", "exit_status", "output_too_large", "parse"]).optional(),
  })
  .strict();

const customMetricSchema = z
  .object({
    source: metricNameSchema,
    name: metricNameSchema,
    labels: labelsSchema
      .refine((labels) => Object.keys(labels).length <= 16, {
        message: "At most 16 labels per series.",
      })
      .optional(),
    value: finiteNumberSchema,
    ts: z.string().datetime(),
  })
  .strict();

const nodeMetricsSchema = z
  .object({
    type: z.literal("node.metrics"),
    ts: z.string().datetime(),
    cpu: z
      .object({
        usagePercent: percentSchema.optional(),
        load1: z.number().min(0).max(1_000_000).optional(),
        load5: z.number().min(0).max(1_000_000).optional(),
        load15: z.number().min(0).max(1_000_000).optional(),
      })
      .strict()
      .optional(),
    memory: z
      .object({
        totalMiB: mibSchema.optional(),
        availableMiB: mibSchema.optional(),
        swapTotalMiB: mibSchema.optional(),
        swapFreeMiB: mibSchema.optional(),
      })
      .strict()
      .optional(),
    disks: z
      .array(
        z
          .object({
            mount: storedTextSchema(256, false),
            totalMiB: mibSchema.optional(),
            freeMiB: mibSchema.optional(),
          })
          .strict(),
      )
      .max(16)
      .optional(),
    gpus: z
      .array(
        z
          .object({
            index: z.number().int().min(0).max(255),
            vramUsedMiB: gpuReadingSchema(mibSchema),
            vramTotalMiB: gpuReadingSchema(mibSchema),
            utilizationPercent: gpuReadingSchema(percentSchema),
            temperatureC: gpuReadingSchema(z.number().min(-100).max(300)),
            powerW: gpuReadingSchema(z.number().min(0).max(100_000)),
            smClockMHz: gpuReadingSchema(z.number().min(0).max(100_000)),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    interfaces: z
      .array(
        z
          .object({
            name: interfaceNameSchema,
            rxBytes: byteCounterSchema,
            txBytes: byteCounterSchema,
          })
          .strict(),
      )
      .max(32)
      .optional(),
    /** S-B part 2 custom series. */
    custom: z.array(customMetricSchema).max(NODE_METRICS_CUSTOM_MAX).optional(),
    /** Per-source status, local and remote (S-B part 2). */
    sources: z.array(metricSourceStatusSchema).max(NODE_METRIC_SOURCES_MAX).optional(),
    /** 2.9: custom engine adapter status. No command text, output, or hash. */
    engineAdapters: z
      .array(
        z
          .object({
            endpointSlug: z.string().trim().min(1).max(63),
            input: z.enum(["route", "command"]),
            state: z.enum(["active", "failing", "disabled", "pending_approval", "refused"]),
            error: z
              .enum([
                "spawn",
                "timeout",
                "exit_status",
                "output_too_large",
                "parse",
                "http",
                "out_of_range",
                "unmapped",
              ])
              .optional(),
          })
          .strict(),
      )
      .max(NODE_ENGINE_ADAPTERS_MAX)
      .optional(),
    /** Abandoned `.wsmp-recover-*` directories indexed by this CLI. Omitted when zero. */
    abandonedRecovery: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();
export type NodeMetricsMessage = z.infer<typeof nodeMetricsSchema>;

const endpointLoadSchema = z
  .object({
    type: z.literal("endpoint.load"),
    endpointSlug: z.string().trim().min(1).max(63),
    modelSlug: z.string().trim().min(1).max(128).optional(),
    running: nonNegativeCountSchema,
    /** 0 from llama.cpp `/slots`, which cannot see the queue. Optional for custom. */
    waiting: nonNegativeCountSchema.optional(),
    kvUsage: z.number().min(0).max(1).optional(),
    /** Active plus idle cached prefixes. Display only. */
    kvOccupancy: z.number().min(0).max(1).optional(),
    slotsBusy: nonNegativeCountSchema.optional(),
    /** llama.cpp `requests_deferred` (`--metrics`). */
    deferred: nonNegativeCountSchema.optional(),
    prefixCacheHitsDelta: byteCounterSchema.optional(),
    prefixCacheQueriesDelta: byteCounterSchema.optional(),
    /** Engine prefix-cache counters dropped (restart / flush). Not a delta. */
    prefixCacheReset: z.literal(true).optional(),
    /**
     * Monotonic per-endpoint counter generation. The CLI bumps it when prefix
     * counters drop or the engine identity changes, and always sends
     * `prefixCacheReset` on a bump. Required on 2.4; the server resets
     * KV-eviction state only when this value changes, including the first
     * frame after a replica or reboot that stored a different epoch.
     */
    counterEpoch: z.number().int().min(0).max(4_294_967_295),
    source: z.enum([
      "llama.cpp-slots",
      "llama.cpp-metrics",
      "vllm-metrics",
      "sglang-metrics",
      "custom",
    ]),
    ts: z.string().datetime(),
  })
  .strict()
  .superRefine((load, ctx) => {
    if (load.source !== "custom" && load.waiting === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "waiting is required for built-in load sources.",
        path: ["waiting"],
      });
    }
  });
export type EndpointLoadMessage = z.infer<typeof endpointLoadSchema>;

/** Blank as the CLI's `str::trim().is_empty()` sees it (Unicode White_Space; not JS `trim()`). */
const BLANK_COMMAND = /^\p{White_Space}*$/u;

/** Server to CLI (2.7): a remotely defined custom metric source (S-B part 2). */
export const remoteMetricSourceSchema = z
  .object({
    name: metricNameSchema,
    // One definition of a runnable command on every side (the CLI's
    // `validate_command`): non-blank, at most 4096 BYTES, no NUL.
    command: z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (command) =>
          !BLANK_COMMAND.test(command) &&
          !command.includes("\u0000") &&
          new TextEncoder().encode(command).length <= 4096,
        { message: "command must be non-blank, at most 4096 bytes and contain no NUL" },
      ),
    intervalSecs: z.number().int().min(5).max(86_400),
    timeoutSecs: z.number().int().min(1).max(300),
    format: z.enum(["number", "json", "prometheus"]),
  })
  .strict();
export type RemoteMetricSource = z.infer<typeof remoteMetricSourceSchema>;
/** The `metrics.sources.set` payload, bounded like the CLI-side storage. */
export const remoteMetricSourcesSchema = z
  .array(remoteMetricSourceSchema)
  .max(NODE_METRIC_SOURCES_MAX);

const adapterRouteSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((route) => adapterRouteIsValid(route), {
    message:
      "adapter route must start with / and stay on the endpoint origin (no scheme, host, whitespace, .., query, or fragment)",
  });

const remoteEngineAdapterInputSchema = z.union([
  z.object({ route: adapterRouteSchema }).strict(),
  z
    .object({
      command: z
        .string()
        .min(1)
        .max(4096)
        .refine(
          (command) =>
            !BLANK_COMMAND.test(command) &&
            !command.includes("\u0000") &&
            new TextEncoder().encode(command).length <= 4096,
          { message: "command must be non-blank, at most 4096 bytes and contain no NUL" },
        ),
    })
    .strict(),
]);

/** Server to CLI (2.9): a remotely defined engine adapter. */
export const remoteEngineAdapterSchema = z
  .object({
    endpointSlug: z
      .string()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    input: remoteEngineAdapterInputSchema,
    format: z.enum(["json", "prometheus"]),
    intervalSecs: z.number().int().min(2).max(5),
    timeoutSecs: z.number().int().min(1).max(4),
    map: z
      .partialRecord(
        z.enum([
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
        ]),
        z
          .object({
            series: z.string().trim().min(1).max(256),
            labels: z.record(z.string().min(1).max(64), z.string().min(1).max(64)).optional(),
            aggregate: z.enum(["sum", "max", "first"]).optional(),
            scale: z.number().finite().optional(),
          })
          .strict(),
      )
      .optional(),
    countRoute: adapterRouteSchema.optional(),
  })
  .strict();
export type RemoteEngineAdapter = z.infer<typeof remoteEngineAdapterSchema>;
export const remoteEngineAdaptersSchema = z
  .array(remoteEngineAdapterSchema)
  .max(NODE_ENGINE_ADAPTERS_MAX);

const relayClientControlMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("deployment.job.result"),
      stepId: requestIdSchema,
      instanceId: requestIdSchema,
      rank: z.number().int().min(0).max(63),
      intentHash: z.string().regex(/^[a-f0-9]{64}$/),
      ownerEpoch: requestIdSchema,
      status: z.enum(["succeeded", "failed", "running", ...DEPLOYMENT_OPERATOR_RESULT_STATUSES]),
      stopped: z.boolean(),
      error: z
        .string()
        .regex(/^[a-z0-9_]{1,64}$/)
        .optional(),
      /**
       * The job's `operator.terminalId`. Required on operator progress; also on every
       * final (`succeeded`/`failed`) of an interactive job, which binds it to its dispatch.
       */
      terminalId: base64Url16ByteSchema.optional(),
      /** `operator_closed`: the last attempt's exit code. */
      exitCode: z.number().int().min(0).max(255).optional(),
    })
    .strict()
    .superRefine((result, ctx) => {
      const operator = deploymentOperatorResultStatus(result.status);
      if (
        operator
          ? result.terminalId === undefined
          : result.status === "running" && result.terminalId !== undefined
      )
        ctx.addIssue({
          code: "custom",
          path: ["terminalId"],
          message: "terminalId is present on operator statuses and interactive finals only.",
        });
      if (result.exitCode !== undefined && result.status !== "operator_closed")
        ctx.addIssue({
          code: "custom",
          path: ["exitCode"],
          message: "Only operator_closed carries an exit code.",
        });
      if (operator && result.stopped)
        ctx.addIssue({
          code: "custom",
          path: ["stopped"],
          message: "Operator progress never reports a stop.",
        });
    }),
  z
    .object({
      type: z.literal("deployment.instances"),
      snapshotId: z.string().regex(/^[a-zA-Z0-9]{32}$/),
      chunkIndex: z.number().int().min(0).max(131071),
      final: z.boolean(),
      instances: z
        .array(
          z
            .object({
              instanceId: requestIdSchema,
              revisionId: requestIdSchema,
              rank: z.number().int().min(0).max(63),
              intentHash: z.string().regex(/^[a-f0-9]{64}$/),
              stepId: requestIdSchema.optional(),
              phase: z.enum(["starting", "ready", "unhealthy", "stopping", "stopped", "unknown"]),
              unitName: z
                .string()
                .regex(/^wsmp-i-[a-zA-Z0-9]+-r[0-9]+$/)
                .max(160),
              port: z.number().int().min(1).max(65535),
              endpointSlug: z.string().min(1).max(63),
              models: z.array(z.string().min(1).max(256)).max(64),
              contextWindow: z.number().int().positive().nullable(),
            })
            .strict(),
        )
        .max(512),
    })
    .strict(),
  z
    .object({
      type: z.literal("hello"),
      id: requestIdSchema,
      protocolVersion: z.enum(RELAY_PROTOCOL_VERSIONS),
      cli: z
        .object({
          slug: z.string().trim().min(1).max(63),
          // A display label, stored as CliDevice.reportedHostname. Spoofable
          // (`hostnamectl`); not what a device credential is bound to.
          // Normalized rather than rejected so an odd hostname never blocks hello.
          hostname: z.string().max(1024).nullish().transform(normalizeReportedHostname),
          version: z.string().trim().max(80).optional(),
          // Persistent P-256 identity public key. Login and CLI-token TOFU bind
          // to this key; hello must prove possession with `identitySignature`.
          identityPublicKey: uncompressedP256PublicKeySchema,
          // Signature over the server nonce from `hello.challenge`.
          identitySignature: p256SignatureSchema,
          capabilities: cliCapabilitiesSchema,
        })
        .strict()
        .refine(
          (cli) =>
            cli.capabilities.terminalIdentity === undefined ||
            cli.capabilities.terminalIdentity.publicKey === cli.identityPublicKey,
          { message: "terminalIdentity.publicKey must match identityPublicKey." },
        ),
      endpoints: z.array(endpointInventorySchema).max(100).default([]),
    })
    .strict(),
  z
    .object({
      type: z.literal("inventory.update"),
      id: requestIdSchema,
      endpoints: z.array(endpointInventorySchema).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("heartbeat"),
      id: requestIdSchema,
      sentAt: z.string().datetime().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("relay.request.body.ack"),
      requestId: requestIdSchema,
      credits: z.number().int().min(1).max(RELAY_REQUEST_BODY_WINDOW_CHUNKS),
    })
    .strict(),
  z
    .object({
      type: z.literal("relay.response.headers"),
      requestId: requestIdSchema,
      status: z.number().int().min(100).max(599),
      headers: z.union([headerSchema, orderedHeadersSchema]).default({}),
    })
    .strict(),
  z
    .object({
      type: z.literal("relay.complete"),
      requestId: requestIdSchema,
      usage: z
        .object({
          promptTokens: z.number().int().min(0).optional(),
          completionTokens: z.number().int().min(0).optional(),
          totalTokens: z.number().int().min(0).optional(),
        })
        .strict()
        .optional(),
      metrics: z
        .object({
          completionTokens: z.number().int().min(0),
          tokenizer: z.literal("cl100k_base"),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("relay.error"),
      requestId: requestIdSchema,
      failure: relayFailureSchema,
      message: z.string().max(1000).optional(),
      upstreamStatusCode: z.number().int().min(100).max(599).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("relay.cancelled"),
      requestId: requestIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("context.count.result"),
      requestId: requestIdSchema,
      tokens: z.number().int().min(0).max(TOKEN_COUNT_MAX),
      method: z.enum([
        "vllm_tokenize",
        "tgi_chat_tokenize",
        "llama_apply_template",
        "llama_input_tokens",
        "adapter_count",
      ]),
    })
    .strict(),
  z
    .object({
      type: z.literal("context.count.error"),
      requestId: requestIdSchema,
      failure: relayFailureSchema,
      message: z.string().max(1000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("term.pending"),
      terminalId: base64Url16ByteSchema,
      viewerId: viewerIdSchema.optional(),
      cliNonce: base64Url16ByteSchema,
      approvalCode: z
        .string()
        .regex(/^[A-Z2-7]{8}$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("term.opened"),
      terminalId: base64Url16ByteSchema,
      viewerId: viewerIdSchema.optional(),
      cliNonce: base64Url16ByteSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("term.attached"),
      terminalId: base64Url16ByteSchema,
      viewerId: viewerIdSchema.optional(),
      cliNonce: base64Url16ByteSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("term.rejected"),
      terminalId: base64Url16ByteSchema,
      viewerId: viewerIdSchema.optional(),
      reason: z.string().min(1).max(64),
      approvalCode: z
        .string()
        .regex(/^[A-Z2-7]{8}$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("term.writer"),
      terminalId: base64Url16ByteSchema,
      /** Omitted when no viewer is the writer. */
      viewerId: viewerIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      /** The CLI's input queue for this viewer was full. Sent once per run of drops. */
      type: z.literal("term.input_dropped"),
      terminalId: base64Url16ByteSchema,
      /** Omitted only when the CLI has no viewer id for the drop. */
      viewerId: viewerIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("term.exit"),
      terminalId: base64Url16ByteSchema,
      exitCode: z.number().int().min(0).max(255).optional(),
      signal: relayExitSignalSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("term.spawned"),
      terminalId: base64Url16ByteSchema,
      commandId: base64Url16ByteSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("supervised.rejected"),
      commandId: base64Url16ByteSchema,
      reason: z.string().min(1).max(64),
    })
    .strict(),
  z
    .object({
      type: z.literal("supervised.accepted"),
      commandId: base64Url16ByteSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("supervised.declined"),
      commandId: base64Url16ByteSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("supervised.done"),
      commandId: base64Url16ByteSchema,
      exitCode: z.number().int().min(0).max(255).optional(),
      signal: relayExitSignalSchema,
      /** True: output was held for review in the browser and none was sent. */
      review: z.boolean(),
      /** Total output bytes after Enter; present only when output frames were sent. */
      outputBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      /** 2.8: metadata only; the CLI screen owns the diff. */
      fileResult: supervisedFileResultSchema.optional(),
      fileError: supervisedFileErrorSchema.optional(),
    })
    .strict()
    .refine(
      (frame) => !(frame.fileResult && frame.fileError),
      "File result and error are exclusive.",
    )
    .refine(
      (frame) =>
        !(frame.fileResult || frame.fileError) ||
        (!frame.review &&
          frame.exitCode === undefined &&
          frame.signal === undefined &&
          frame.outputBytes === undefined),
      "File completion contains no command output.",
    ),
  z
    .object({
      type: z.literal("exec.started"),
      commandId: base64Url16ByteSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("exec.rejected"),
      commandId: base64Url16ByteSchema,
      reason: z.string().min(1).max(64),
    })
    .strict(),
  z
    .object({
      type: z.literal("exec.done"),
      commandId: base64Url16ByteSchema,
      exitCode: z.number().int().min(0).max(255).optional(),
      signal: relayExitSignalSchema,
      timedOut: z.boolean(),
    })
    .strict(),
  nodeInfoSchema,
  nodeMetricsSchema,
  endpointLoadSchema,
  fileResultFrameSchema,
  fileRejectedFrameSchema,
  ...sttClientControlSchemas,
]);
export type RelayClientControlMessage = z.infer<typeof relayClientControlMessageSchema>;

export type InventoryRevision = {
  inventorySeq: number;
  inventoryDigest: string;
  inventoryAcknowledgedAt: string;
};

export type DesiredModelCapability = {
  endpointSlug: string;
  upstreamModelId: string;
  capabilityOverrideMode: "override";
  capabilities: OpenAiCompatibleCapabilities;
};

export type TerminalHandshakeIdentity = z.infer<typeof terminalIdentitySchema>;

export type RelayServerControlMessage =
  | DeploymentJob
  | { type: "deployment.instances.ok"; snapshotId: string }
  | {
      type: "hello.ok";
      id: string;
      protocolVersion: RelayProtocolVersion;
      revision: InventoryRevision;
      desiredCapabilities?: DesiredModelCapability[];
    }
  | {
      type: "inventory.ok";
      id: string;
      revision: InventoryRevision;
      desiredCapabilities?: DesiredModelCapability[];
    }
  | { type: "inventory.error"; id: string; message: string }
  | { type: "heartbeat.pong"; id: string; receivedAt: string }
  | {
      type: "relay.request";
      requestId: string;
      family:
        | "chat.completions"
        | "embeddings"
        | "responses"
        | "messages"
        | "audio"
        | "images"
        | "generic";
      method: string;
      path: string;
      headers: Record<string, string>;
      timeoutMs: number;
      endpointSlug: string;
      // Whether the CLI should expect streamed `relay.request.body` frames for
      // this request (true when the request carries a body). When false the CLI
      // forwards the request to upstream immediately with an empty body.
      expectBody: boolean;
      /**
       * Near-ceiling Chat Completions: the CLI tokenizes this body first, then
       * either forwards it upstream or returns `relay.error` `request_too_large`.
       * The body crosses the websocket once. Omit or false for every other family.
       */
      countFirst?: boolean;
      /** Inclusive token ceiling the CLI uses when `countFirst` is true. */
      countCeiling?: number;
    }
  | { type: "relay.cancel"; requestId: string; reason: RelayFailure }
  | {
      type: "protocol.error";
      failure: "protocol_error";
      code: RelayProtocolErrorCode;
      message: string;
      supportedVersions: readonly RelayProtocolVersion[];
      requestId?: string;
    }
  | {
      type: "hello.challenge";
      nonce: string;
      /** Canonical public origin mixed into the hello identity statement. */
      origin: string;
    }
  | {
      type: "term.open";
      terminalId: string;
      /** 2.5 only. */
      viewerId?: string;
      cols: number;
      rows: number;
      browserPublicKey: string;
      browserNonce: string;
      identity?: TerminalHandshakeIdentity;
    }
  | {
      type: "term.attach";
      terminalId: string;
      /** 2.5 only. */
      viewerId?: string;
      browserPublicKey: string;
      browserNonce: string;
      identity?: TerminalHandshakeIdentity;
    }
  | { type: "term.detach"; terminalId: string; viewerId?: string }
  | { type: "term.close"; terminalId: string }
  | { type: "term.auth"; terminalId: string; viewerId?: string; signature: string }
  | { type: "exec.start"; commandId: string; command: string; cwd?: string }
  | { type: "exec.cancel"; commandId: string }
  | {
      /** 2.6: a supervised (agent-requested) terminal with a confirm screen. */
      type: "term.spawn";
      terminalId: string;
      commandId: string;
      command: string;
      cwd?: string;
      reason?: string;
      /** Server-asserted: the requesting MCP token's name. */
      requester: string;
      shareOutput: boolean;
      /** 2.8: `"file"` carries a strict mutation and out-of-band write body. */
      kind?: "command" | "file";
      fileOp?: FileSpawnSpec;
      bodyBytes?: number;
    }
  | {
      type: "supervised.cancel";
      commandId: string;
      /**
       * Absent: end the terminal in whatever state. `expire` (confirm
       * deadline) or `decline` (from the browser): a request the CLI decides;
       * it declines a request still waiting, and an Enter it took first wins.
       */
      reason?: "expire" | "decline";
    }
  | {
      /**
       * 2.7: replace the CLI's remotely defined metric sources. The CLI may
       * refuse (local opt-in off, hash not approved) and reports each
       * source's state in `node.metrics.sources`.
       */
      type: "metrics.sources.set";
      id: string;
      sources: RemoteMetricSource[];
    }
  | {
      /**
       * 2.9: replace the CLI's remotely defined engine adapters. The CLI may
       * refuse (separate local opt-in off, hash not approved) and reports
       * each adapter's state in `node.metrics.engineAdapters`.
       */
      type: "engine.adapters.set";
      id: string;
      adapters: RemoteEngineAdapter[];
    }
  | {
      /**
       * 2.8: run one node file op. `mode` and `readGrant` are the server's
       * admission verdict, re-checked by the CLI against its own startup
       * config; write content follows as one `file.body` binary frame.
       */
      type: "file.op";
      opId: string;
      op: FileOp;
      args: FileOpFrame["args"];
      bodyBytes?: number;
      mode: FileOpFrame["mode"];
      readGrant: boolean;
    }
  | { type: "file.cancel"; opId: string }
  /** 2.11: live speech-to-text (`stt-protocol.ts`). */
  | SttServerControlMessage;

const relayBodyMetadataFields = {
  requestId: requestIdSchema,
  chunkId: z.string().trim().min(1).max(128),
  final: z.boolean().optional(),
};
const sealedSeqSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sealedEpochSchema = z.number().int().min(1).max(0xffff_ffff);

const relayBinaryFrameMetadataSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("relay.request.body"), ...relayBodyMetadataFields }).strict(),
  z.object({ type: z.literal("relay.response.body"), ...relayBodyMetadataFields }).strict(),
  z
    .object({
      type: z.literal("term.sealed"),
      terminalId: base64Url16ByteSchema,
      seq: sealedSeqSchema,
      /**
       * 2.5 only. Server to CLI: the sending attachment, stamped by the server.
       * CLI to server: a unicast frame for this viewer.
       */
      viewerId: viewerIdSchema.optional(),
      /** 2.5 only. CLI to server and server to browser: a broadcast frame under this output-key epoch. */
      epoch: sealedEpochSchema.optional(),
    })
    .strict()
    .refine((metadata) => metadata.viewerId === undefined || metadata.epoch === undefined, {
      message: "A sealed frame is either unicast or broadcast.",
    }),
  z
    .object({
      type: z.literal("exec.stdout"),
      commandId: base64Url16ByteSchema,
      seq: sealedSeqSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("exec.stderr"),
      commandId: base64Url16ByteSchema,
      seq: sealedSeqSchema,
    })
    .strict(),
  z
    .object({
      /** 2.6: shared supervised output, sent once at exit (never while review is on). */
      type: z.literal("supervised.output"),
      commandId: base64Url16ByteSchema,
      part: z.enum(["head", "tail"]),
      seq: sealedSeqSchema,
    })
    .strict(),
  /** 2.8: write content, server to CLI, one frame of at most 1 MiB. */
  fileBodyMetadataSchema,
  /** 2.8: a `file.result` text field above the inline 48 KiB, CLI to server. */
  fileDataMetadataSchema,
  /** 2.11: live speech-to-text PCM, server to CLI. */
  sttAudioMetadataSchema,
]);

export type RelayBinaryFrameMetadata = z.infer<typeof relayBinaryFrameMetadataSchema>;
export type TerminalSealedMetadata = Extract<RelayBinaryFrameMetadata, { type: "term.sealed" }>;
export type RelayResponseBodyMetadata = Extract<
  RelayBinaryFrameMetadata,
  { type: "relay.response.body" }
>;

export function parseRelaySubprotocolHeader(header: string | undefined): {
  ok: boolean;
  supported: boolean;
  requestedMajorVersions: number[];
} {
  const requested = (header ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const requestedMajorVersions = requested
    .map((part) => /^ws-model-proxy\.relay\.v(\d+)$/.exec(part)?.[1])
    .filter((part): part is string => Boolean(part))
    .map((part) => Number.parseInt(part, 10));
  return {
    ok: requested.length > 0,
    supported: requested.includes(RELAY_SUBPROTOCOL),
    requestedMajorVersions,
  };
}

/**
 * Throws `RelayWireTextError` (and sends nothing) when any string in the
 * message is not well-formed Unicode: the CLI cannot read such a frame.
 */
const termSpawnEnvelope = {
  type: z.literal("term.spawn"),
  terminalId: base64Url16ByteSchema,
  commandId: base64Url16ByteSchema,
  command: z
    .string()
    .min(1)
    .refine((text) => utf8Length(text) <= 4096 && !text.includes("\0")),
  reason: z.string().max(500).optional(),
  requester: z.string().min(1).max(200),
};
export const fileTermSpawnSchema = z
  .object({
    ...termSpawnEnvelope,
    kind: z.literal("file"),
    fileOp: fileSpawnSpecSchema,
    bodyBytes: z.number().int().min(0).max(FILE_BODY_MAX_BYTES).optional(),
    shareOutput: z.literal(false),
  })
  .strict()
  .refine(
    (frame) => (frame.fileOp.op === "write") === (frame.bodyBytes !== undefined),
    "Only write requires bodyBytes.",
  );

export function protocolErrorMessage(input: {
  code: RelayProtocolErrorCode;
  message: string;
  requestId?: string;
}): Extract<RelayServerControlMessage, { type: "protocol.error" }> {
  return {
    type: "protocol.error",
    failure: "protocol_error",
    code: input.code,
    message: input.message,
    supportedVersions: RELAY_PROTOCOL_VERSIONS,
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
  };
}

export function encodeRelayServerControlMessage(message: RelayServerControlMessage): string {
  if (message.type === "deployment.instances.ok" && !/^[a-zA-Z0-9]{32}$/.test(message.snapshotId)) {
    throw new RelayProtocolError("Invalid deployment inventory acknowledgement.");
  }
  // The one enforcement point for the only outbound message whose payload is
  // built from stored, user-authored data: a source list that fails the wire
  // schema is never framed (callers send an empty list instead).
  if (
    message.type === "metrics.sources.set" &&
    !remoteMetricSourcesSchema.safeParse(message.sources).success
  ) {
    throw new RelayProtocolError(
      "metrics.sources.set carries a source list that fails the wire schema.",
    );
  }
  if (
    message.type === "engine.adapters.set" &&
    !remoteEngineAdaptersSchema.safeParse(message.adapters).success
  ) {
    throw new RelayProtocolError(
      "engine.adapters.set carries an adapter list that fails the wire schema.",
    );
  }
  // File spawns fail closed even if a caller bypasses the TypeScript type.
  if (message.type === "term.spawn") {
    if (message.kind === "file") fileTermSpawnSchema.parse(message);
    else if (message.kind !== undefined && message.kind !== "command") {
      throw new RelayProtocolError("Unknown supervised request kind.");
    } else if (message.fileOp !== undefined || message.bodyBytes !== undefined) {
      throw new RelayProtocolError("File fields require kind file.");
    }
  }
  // An operator terminal accompanies exactly the interactive jobs.
  if (
    message.type === "deployment.job" &&
    (message.interactive === true) !==
      (message.operator !== undefined && deploymentJobOperatorValid(message.operator))
  ) {
    throw new RelayProtocolError(
      "deployment.job operator must accompany exactly interactive jobs.",
    );
  }
  // 2.11 live speech-to-text frames fail closed against the shared golden contract.
  if (message.type.startsWith("stt.") && !sttServerControlSchema.safeParse(message).success) {
    throw new RelayProtocolError(`${message.type} fails the wire schema.`);
  }
  const encoded = stringifyWellFormed(message);
  // Both carry user-authored commands; the CLI drops larger control frames undecoded.
  // Deployment admission bounds jobs first, so this only backstops a bypass.
  if (
    (message.type === "term.spawn" || message.type === "deployment.job") &&
    utf8Length(encoded) > RELAY_JSON_CONTROL_MAX_BYTES
  ) {
    throw new RelayProtocolError("JSON control frame exceeds 64 KiB.");
  }
  return encoded;
}

export function parseRelayClientControlFrame(frame: string): RelayClientControlMessage {
  const bytes = new TextEncoder().encode(frame).byteLength;
  if (bytes > RELAY_JSON_CONTROL_MAX_BYTES) {
    throw new RelayProtocolError("JSON control frame exceeds 64 KiB.");
  }
  const parsed: unknown = JSON.parse(frame);
  return relayClientControlMessageSchema.parse(parsed);
}

/**
 * True for a hello that is not a protocol this server speaks: older than 2.4,
 * newer than the newest listed version, or the pre-naming `cli.label` field.
 * Checked before the strict schema so such a CLI gets a coded `protocol.error`
 * instead of an opaque "malformed message".
 */
export function helloNeedsUpgrade(frame: string): boolean {
  if (utf8Length(frame) > RELAY_JSON_CONTROL_MAX_BYTES) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  if (record.type !== "hello") return false;
  const accepted = (value: unknown): value is RelayProtocolVersion =>
    RELAY_PROTOCOL_VERSIONS.includes(value as RelayProtocolVersion);
  if (!accepted(record.protocolVersion)) return true;
  const cli = record.cli;
  if (!cli || typeof cli !== "object" || Array.isArray(cli)) return false;
  return "label" in (cli as Record<string, unknown>);
}

/** `major.minor`, the only shape `relayProtocolAtLeast` and the card's newer/older split read. */
const REJECTED_PROTOCOL_PATTERN = /^\d{1,4}\.\d{1,4}$/;
/** Semver (`1.2.3`, `1.2.3-rc.1+build`), at most 32 characters. */
const REJECTED_CLI_VERSION_PATTERN =
  /^(?=.{1,32}$)\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function rejectedVersionField(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

/**
 * The protocol and CLI versions a refused hello claimed, for the device card
 * ("CLI upgrade required", or "Server upgrade required" when the claimed
 * protocol is newer than this server speaks) and the relay log. Anything that
 * is not a short version-shaped string is dropped.
 */
export function rejectedHelloFacts(frame: string): {
  protocolVersion: string | null;
  cliVersion: string | null;
} {
  const none = { protocolVersion: null, cliVersion: null };
  if (utf8Length(frame) > RELAY_JSON_CONTROL_MAX_BYTES) return none;
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame);
  } catch {
    return none;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return none;
  const record = parsed as Record<string, unknown>;
  const cli = record.cli;
  const cliVersion =
    cli && typeof cli === "object" && !Array.isArray(cli)
      ? rejectedVersionField((cli as Record<string, unknown>).version, REJECTED_CLI_VERSION_PATTERN)
      : null;
  return {
    protocolVersion: rejectedVersionField(record.protocolVersion, REJECTED_PROTOCOL_PATTERN),
    cliVersion,
  };
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

const RELAY_CONTROL_PARSE_ISSUE_LIMIT = 20;

export type RelayControlParseErrorDescription =
  | { kind: "oversize" }
  | { kind: "json" }
  | {
      kind: "schema";
      issues: Array<{ path: string; code: string; message: string }>;
    }
  | { kind: "unknown"; name: string };

export function describeRelayControlParseError(error: unknown): RelayControlParseErrorDescription {
  if (error instanceof RelayProtocolError) {
    if (error.message === "JSON control frame exceeds 64 KiB.") {
      return { kind: "oversize" };
    }
    return { kind: "unknown", name: error.name };
  }
  if (error instanceof SyntaxError) {
    return { kind: "json" };
  }
  if (error instanceof z.ZodError) {
    return {
      kind: "schema",
      issues: error.issues.slice(0, RELAY_CONTROL_PARSE_ISSUE_LIMIT).map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    };
  }
  if (error instanceof Error) {
    return { kind: "unknown", name: error.name };
  }
  return { kind: "unknown", name: "Error" };
}

class RelayProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayProtocolError";
  }
}

export function encodeRelayBinaryFrame(
  metadata: RelayBinaryFrameMetadata,
  body: Uint8Array,
): ArrayBuffer {
  if (body.byteLength > RELAY_BINARY_CHUNK_MAX_BYTES) {
    throw new RelayProtocolError("Binary body chunk exceeds 1 MiB.");
  }
  if (metadata.type === "stt.audio") {
    if (!sttAudioMetadataSchema.safeParse(metadata).success) {
      throw new RelayProtocolError("stt.audio metadata fails the wire schema.");
    }
    if (!sttAudioBodyValid(body.byteLength)) {
      throw new RelayProtocolError(
        `stt.audio carries 1 to ${STT_AUDIO_FRAME_MAX_BYTES} bytes of whole samples.`,
      );
    }
  }
  const metadataBytes = new TextEncoder().encode(stringifyWellFormed(metadata));
  if (metadataBytes.byteLength > RELAY_JSON_CONTROL_MAX_BYTES) {
    throw new RelayProtocolError("Binary frame metadata exceeds 64 KiB.");
  }
  const frame = new Uint8Array(4 + metadataBytes.byteLength + body.byteLength);
  new DataView(frame.buffer).setUint32(0, metadataBytes.byteLength, false);
  frame.set(metadataBytes, 4);
  frame.set(body, 4 + metadataBytes.byteLength);
  return frame.buffer;
}

export function parseRelayBinaryFrame(frame: ArrayBuffer): {
  metadata: RelayBinaryFrameMetadata;
  body: Uint8Array;
} {
  if (frame.byteLength < 4) {
    throw new RelayProtocolError("Binary frame is missing metadata length.");
  }
  const metadataLength = new DataView(frame).getUint32(0, false);
  if (metadataLength > RELAY_JSON_CONTROL_MAX_BYTES) {
    throw new RelayProtocolError("Binary frame metadata exceeds 64 KiB.");
  }
  const bodyLength = frame.byteLength - 4 - metadataLength;
  if (bodyLength < 0) {
    throw new RelayProtocolError("Binary frame metadata length is invalid.");
  }
  if (bodyLength > RELAY_BINARY_CHUNK_MAX_BYTES) {
    throw new RelayProtocolError("Binary body chunk exceeds 1 MiB.");
  }
  const metadataBytes = new Uint8Array(frame, 4, metadataLength);
  const metadataText = new TextDecoder().decode(metadataBytes);
  const metadata = relayBinaryFrameMetadataSchema.parse(JSON.parse(metadataText));
  const body = new Uint8Array(frame, 4 + metadataLength, bodyLength);
  return { metadata, body };
}
