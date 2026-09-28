import {
  type OpenAiCompatibleCapabilities,
  openAiCompatibleCapabilitiesSchema,
} from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import { relayProtocolAtLeast } from "@ws-model-proxy/api/lib/relay-protocol-version";
import { normalizeReportedHostname } from "@ws-model-proxy/config/cli-device-name";
import { z } from "zod";
import { isWellFormedText, stringifyWellFormed } from "./wire-text.js";

export { relayProtocolAtLeast };

/**
 * The only relay protocol this server speaks. 2.7 adds engine facts in the
 * inventory, `node.info`, `node.metrics`, `endpoint.load` and
 * `metrics.sources.set`; it is also the minimum: an older CLI is refused at
 * hello with `RELAY_UPGRADE_REQUIRED_MESSAGE`. 2.8 goes to the MCP node file
 * tools (#103) and 2.9 to model deployments (owner decision on #70).
 */
export const RELAY_PROTOCOL_VERSIONS = ["2.7"] as const;
export type RelayProtocolVersion = (typeof RELAY_PROTOCOL_VERSIONS)[number];
export const RELAY_MIN_PROTOCOL_VERSION: RelayProtocolVersion = "2.7";
/**
 * Sent as `protocol.error` to a CLI whose hello is older than 2.7. Every
 * released wsmp prints `relay protocol error: <message>` and exits, so this
 * text is what the person sees. It names the protocol rather than a wsmp
 * version: the first release that speaks 2.7 is cut separately.
 */
export const RELAY_UPGRADE_REQUIRED_MESSAGE = `This server requires a newer wsmp (relay protocol ${RELAY_MIN_PROTOCOL_VERSION}). Upgrade wsmp and restart it.`;
export const RELAY_SUBPROTOCOL = "ws-model-proxy.relay.v2";

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

const relayFailureSchema = z.enum([
  "transport",
  "timeout",
  "disconnected",
  "upstream_5xx",
  "upstream_4xx",
  "unsupported_capability",
  "not_found",
  "access_denied",
  "rate_limited",
  "request_too_large",
  "cancelled",
  "protocol_error",
  "unknown",
]);
export type RelayFailure = z.infer<typeof relayFailureSchema>;

const requestIdSchema = z.string().trim().min(1).max(128);
const headerNameSchema = z.string().trim().min(1).max(128);
const headerValueSchema = z.string().max(8192);
const headerSchema = z.record(headerNameSchema, headerValueSchema);
const orderedHeadersSchema = z.array(z.tuple([headerNameSchema, headerValueSchema])).max(256);

export { type OpenAiCompatibleCapabilities, openAiCompatibleCapabilitiesSchema };

/** 16 raw bytes, unpadded base64url (22 characters). */
export const base64Url16ByteSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{22}$/)
  .refine((value) => Buffer.from(value, "base64url").length === 16, {
    message: "Expected 16 bytes of base64url.",
  });

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
 * 2.5: the CLI's long-lived identity key and its signature over
 * `lp16("wsmp-term-cli-id-v1") ‖ lp16(cliSlug) ‖ terminalPublicKey`. The relay
 * does not verify it; browsers do, and pin the key per CLI device.
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

const v27FeatureSchema = z
  .object({
    humanTerminal: z.boolean(),
    /** The CLI's own MCP command policy (`wsmp config set-mcp-commands`). */
    mcpCommandMode: mcpCommandModeSchema,
    terminalApproval: z.boolean(),
    terminalSupported: z.boolean(),
    /**
     * 2.7: the CLI accepts remotely defined metric sources
     * (`metrics.sources.set`): its local opt-in is on. False until S-B part 2.
     */
    remoteMetricSources: z.boolean(),
  })
  .strict();

/**
 * 2.6: multi-viewer terminals (server-minted viewer ids, broadcast output),
 * CLI identity proof, and supervised terminals (`term.spawn`). 2.7: node
 * telemetry.
 */
const v27CliCapabilitiesSchema = z
  .object({
    protocolVersion: z.literal("2.7"),
    inventoryAck: z.literal(true),
    inventoryReplace: z.literal(true),
    endpointTargeting: z.literal(true),
    binaryFrames: z.literal(true),
    cancellation: z.literal(true),
    maxBinaryChunkBytes: z.literal(RELAY_BINARY_CHUNK_MAX_BYTES),
    requestBodyStreaming: z.literal(true),
    requestBodyWindowChunks: z.literal(RELAY_REQUEST_BODY_WINDOW_CHUNKS),
    sharedTokenizerTps: z.literal(true),
    standardizedMetrics: z.literal(true),
    terminal: z.literal(true),
    exec: z.literal(true),
    features: v27FeatureSchema,
    terminalPublicKey: uncompressedP256PublicKeySchema,
    terminalViewers: z.literal(true),
    supervisedCommands: z.literal(true),
    /** 2.7: the CLI sends `node.info`, `node.metrics` and `endpoint.load`. */
    nodeTelemetry: z.literal(true),
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
const engineFactSourceSchema = z.enum(["probe", "config"]);

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
export const NODE_METRICS_CUSTOM_MAX = 50;
export const NODE_METRIC_SOURCES_MAX = 50;
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
    executionMechanism: z.enum(["foreground", "systemd", "launchd", "container"]).optional(),
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
    /** How often the source runs; its series are stale after 3× this (S-B part 2). */
    intervalSecs: z.number().int().min(5).max(86_400).optional(),
  })
  .strict();

const customMetricSchema = z
  .object({
    source: metricNameSchema,
    name: metricNameSchema,
    labels: z
      .record(metricNameSchema, metricNameSchema)
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
  })
  .strict();
export type NodeMetricsMessage = z.infer<typeof nodeMetricsSchema>;

const endpointLoadSchema = z
  .object({
    type: z.literal("endpoint.load"),
    endpointSlug: z.string().trim().min(1).max(63),
    modelSlug: z.string().trim().min(1).max(128).optional(),
    running: nonNegativeCountSchema,
    /** 0 from llama.cpp `/slots`, which cannot see the queue. */
    waiting: nonNegativeCountSchema,
    kvUsage: z.number().min(0).max(1).optional(),
    slotsBusy: nonNegativeCountSchema.optional(),
    /** llama.cpp `requests_deferred` (`--metrics`). */
    deferred: nonNegativeCountSchema.optional(),
    prefixCacheHitsDelta: byteCounterSchema.optional(),
    prefixCacheQueriesDelta: byteCounterSchema.optional(),
    source: z.enum(["llama.cpp-slots", "llama.cpp-metrics", "vllm-metrics", "sglang-metrics"]),
    ts: z.string().datetime(),
  })
  .strict();
export type EndpointLoadMessage = z.infer<typeof endpointLoadSchema>;

/** Server to CLI (2.7): a remotely defined custom metric source (S-B part 2). */
export const remoteMetricSourceSchema = z
  .object({
    name: metricNameSchema,
    command: z.string().min(1).max(4096),
    intervalSecs: z.number().int().min(5).max(86_400),
    timeoutSecs: z.number().int().min(1).max(300),
    format: z.enum(["number", "json", "prometheus"]),
  })
  .strict();
export type RemoteMetricSource = z.infer<typeof remoteMetricSourceSchema>;
/** The whole `metrics.sources.set` list, capped like the CLI's reports. */
export const remoteMetricSourcesSchema = z
  .array(remoteMetricSourceSchema)
  .max(NODE_METRIC_SOURCES_MAX);

/** The `metrics.sources.set` payload, bounded like the CLI-side storage. */
export const remoteMetricSourcesSchema = z
  .array(remoteMetricSourceSchema)
  .max(NODE_METRIC_SOURCES_MAX);

const relayClientControlMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("hello"),
      id: requestIdSchema,
      protocolVersion: z.literal("2.7"),
      cli: z
        .object({
          slug: z.string().trim().min(1).max(63),
          // A fact about the machine, stored as CliDevice.reportedHostname.
          // Normalized rather than rejected so an odd hostname never blocks hello.
          hostname: z.string().max(1024).nullish().transform(normalizeReportedHostname),
          version: z.string().trim().max(80).optional(),
          capabilities: v27CliCapabilitiesSchema,
        })
        .strict(),
      endpoints: z.array(endpointInventorySchema).max(100).default([]),
    })
    .strict()
    .refine((message) => message.protocolVersion === message.cli.capabilities.protocolVersion, {
      message: "Relay protocol version must match CLI capabilities.",
    }),
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
      /** Omitted on 2.4 terminals. */
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
    })
    .strict(),
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
    }
  | { type: "relay.cancel"; requestId: string; reason: RelayFailure }
  | { type: "protocol.error"; failure: "protocol_error"; message: string; requestId?: string }
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
    };

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
export function encodeRelayServerControlMessage(message: RelayServerControlMessage): string {
  return stringifyWellFormed(message);
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
 * True for a hello from a CLI older than protocol 2.7: another protocol
 * version, or the pre-naming `cli.label` field. Checked before the strict
 * schema so such a CLI gets `RELAY_UPGRADE_REQUIRED_MESSAGE` instead of an
 * opaque "malformed message".
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
  if (record.protocolVersion !== RELAY_MIN_PROTOCOL_VERSION) return true;
  const cli = record.cli;
  if (!cli || typeof cli !== "object" || Array.isArray(cli)) return false;
  const cliRecord = cli as Record<string, unknown>;
  if ("label" in cliRecord) return true;
  const capabilities = cliRecord.capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    return false;
  }
  return (capabilities as Record<string, unknown>).protocolVersion !== RELAY_MIN_PROTOCOL_VERSION;
}

const REJECTED_VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,32}$/;

function rejectedVersionField(value: unknown): string | null {
  return typeof value === "string" && REJECTED_VERSION_PATTERN.test(value) ? value : null;
}

/**
 * The protocol and CLI versions a refused hello claimed, for the device card
 * ("CLI upgrade required") and the relay log. Anything that is not a short
 * version-shaped string is dropped.
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
      ? rejectedVersionField((cli as Record<string, unknown>).version)
      : null;
  return { protocolVersion: rejectedVersionField(record.protocolVersion), cliVersion };
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
