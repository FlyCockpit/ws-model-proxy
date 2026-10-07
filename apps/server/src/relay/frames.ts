/**
 * Relay protocol 3.0: every frame, both directions, as strict zod schemas.
 *
 * This is the S0 contract. `protocol.ts` becomes the codec around these schemas in S0b
 * (encode/parse, subprotocol header, parse-error descriptions); session code consumes the
 * inferred types. The Rust mirror is `apps/cli/src/protocol/frames.rs`; every fixture in
 * `apps/cli/tests/fixtures/relay-3.0/` parses on both sides (`frames.test.ts`, Rust
 * `protocol::frames::tests`).
 *
 * One clean bump from 2.4 (spec §4): the server accepts exactly `3.0`, there are no capability
 * flags, and later 0.4.0 work extends 3.0 in place.
 *
 * Kept frames (relay.*, context.count.*, term.*, exec.*, file.*, stt.*) keep their 2.4 shapes
 * with two deliberate renames: `endpointSlug` → `handle` (relay.request, stt.open) and
 * `file.op` drops `mode`/`readGrant` (the node's trust decides).
 */

import { embeddingContractSchema } from "@ws-model-proxy/api/lib/embedding-contract";
import {
  ENGINES,
  fabricIpSchema,
  MODEL_CAPABILITIES,
  NODE_COMMAND_MAX_MS,
  NODE_COMMAND_MIN_MS,
  NODE_COMMAND_STATES,
  NODE_COMMAND_TAIL_MAX_BYTES,
  NODE_SECRET_VALUE_MAX_BYTES,
  nodeDeclaredHardwareSchema,
  nodeFabricSetsSchema,
  nodeFeaturesSchema,
  nodeMetricCommandsSchema,
  nodeSecretNameSchema,
  portRangeSchema,
  READER_SIGNALS,
  RUNTIME_APIS,
  RUNTIME_DEFINITIONS_MAX,
  RUNTIME_KINDS,
  RUNTIME_SLUG_PATTERN,
  runtimeSpecSchema,
} from "@ws-model-proxy/api/lib/runtime-spec";
import {
  REALTIME_MAX_ITEM_SECONDS_MAX,
  REALTIME_MAX_ITEM_SECONDS_MIN,
  REALTIME_SEGMENTED_MAX_ITEM_SECONDS_MAX,
  REALTIME_TRANSCRIPTION_ADAPTERS,
  transcriptionProfileSchema,
} from "@ws-model-proxy/api/lib/transcription-profile";
import { z } from "zod";
import {
  deleteArgsSchema,
  editArgsSchema,
  FILE_BODY_MAX_BYTES,
  FILE_ERROR_CODES,
  fileBodyMetadataSchema,
  fileDataMetadataSchema,
  fileRejectDetailSchema,
  fileResultFrameSchema,
  listArgsSchema,
  mkdirArgsSchema,
  readArgsSchema,
  renameArgsSchema,
  searchArgsSchema,
  statArgsSchema,
  writeRelayArgsSchema,
} from "./file-protocol.js";
import { relayFailureSchema } from "./relay-failure.js";
import {
  STT_AUDIO_FRAME_MAX_BYTES,
  STT_AUDIO_WINDOW_MAX_BYTES,
  STT_ITEM_SEQ_MAX,
  STT_MAX_SESSION_MS_MAX,
  STT_MAX_SESSION_MS_MIN,
  STT_MODEL_MAX_BYTES,
  sttAudioMetadataSchema,
  sttClientControlSchemas,
  sttConfigSchema,
  sttHandleSchema,
  sttSessionIdSchema,
} from "./stt-protocol.js";

// ── Version and transport constants ──

export const RELAY_PROTOCOL_VERSION = "3.0";
export const RELAY_SUBPROTOCOL = "ws-model-proxy.relay.v3";
export const RELAY_JSON_CONTROL_MAX_BYTES = 64 * 1024;
export const RELAY_BINARY_CHUNK_MAX_BYTES = 1024 * 1024;
export const RELAY_REQUEST_BODY_WINDOW_CHUNKS = 16;
/** Entry bound of one `runtime.inventory` chunk (both lists together). */
export const RUNTIME_INVENTORY_CHUNK_MAX = 512;
/**
 * Byte budget a sender fills a chunked frame (`runtime.define`, its result, `runtime.inventory`)
 * up to before starting the next chunk; leaves room under the 64 KiB control cap for the
 * envelope. Every frame of 3.0 must encode within `RELAY_JSON_CONTROL_MAX_BYTES`.
 */
export const CHUNK_BUDGET_BYTES = 60 * 1024;
/** Versions one define chunk names (put + keep + remove), so its answer fits one frame. */
export const DEFINE_CHUNK_MAX_VERSIONS = 64;
/** Server accepts at most one `node.info` per this window. */
export const NODE_INFO_MIN_INTERVAL_MS = 5_000;

// ── Shared field schemas ──

export const relayIdSchema = z.string().trim().min(1).max(128);
/** Row ids (cuid2) and step ids. */
/** Row ids (cuid2) and step ids; 64 chars bound the chunked frames. */
export const rowIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
/** 16 raw bytes as canonical unpadded base64url (22 chars, zero trailing bits). */
export const base64Url16Schema = z.string().regex(/^[A-Za-z0-9_-]{21}[AQgw]$/);
/** Uncompressed P-256 point (65 bytes, leading 0x04), unpadded base64url. */
export const p256PublicKeySchema = z
  .string()
  .regex(/^B[A-Za-z0-9_-]{85}[AEIMQUYcgkosw048]$/)
  .refine((value) => {
    const bytes = Buffer.from(value, "base64url");
    return bytes.length === 65 && bytes[0] === 0x04;
  }, "Expected a 65-byte uncompressed P-256 public key.");
/** IEEE P1363 P-256 signature, unpadded base64url (64 bytes). */
export const p256SignatureSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{85}[AQgw]$/)
  .refine((value) => Buffer.from(value, "base64url").length === 64, "Expected 64 bytes.");
const isoTimeSchema = z.string().datetime();
/** Shape only (3–63); enrollment refuses reserved names and the node row is authoritative. */
const nodeSlugSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}$/);
/**
 * What the node routes by: the runtime slug (always-on) or `i-<id12>` (startable instance).
 * Runtime slugs that look like an instance handle are refused at creation.
 */
export const runtimeHandleSchema = z.string().regex(RUNTIME_SLUG_PATTERN);
export const INSTANCE_HANDLE_PATTERN = /^i-[a-z0-9]{12}$/;
/** Deterministic unit name (§3.5, L3): `wsmp-<handle>-r<rank>`. */
export const UNIT_NAME_PATTERN = /^wsmp-[a-z0-9-]{1,41}-r[0-9]{1,2}$/;
export function runtimeUnitName(handle: string, rank: number): string {
  return `wsmp-${handle}-r${rank}`;
}
const rankSchema = z.number().int().min(0).max(63);
const portSchema = z.number().int().min(1).max(65_535);
const nonNegativeCount = z.number().int().min(0).max(1_000_000);
const byteCounter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const TOKEN_COUNT_MAX = 1_000_000_000_000;
const tokenCount = z.number().int().min(1).max(TOKEN_COUNT_MAX);
const exitSignalSchema = z
  .string()
  .regex(/^[A-Za-z0-9_+.-]{1,32}$/)
  .optional();
const headerName = z.string().trim().min(1).max(128);
const headerValue = z.string().max(8192);
const shortText = z.string().trim().min(1).max(256);
const mib = z.number().int().min(0).max(1_000_000_000);
const percent = z.number().min(0).max(100);
const metricName = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);

// ── Trust ──

export const NODE_TRUST_VALUES = ["full", "relay"] as const;
export type NodeTrustWire = (typeof NODE_TRUST_VALUES)[number];

export const nodeTrustStateSchema = z
  .object({
    value: z.enum(NODE_TRUST_VALUES),
    /** True exactly while `value` is relay: held definitions and metric commands are frozen. */
    frozen: z.boolean(),
  })
  .strict()
  .refine((trust) => trust.frozen === (trust.value === "relay"), {
    message: "frozen is true exactly at relay.",
  });

/**
 * One held server-origin definition VERSION. A node holds every version the server pushed and
 * did not remove (current, profile-pinned, running), keyed by `versionId`; several versions of
 * one runtime are normal. The frozen copy (Relay only) is the same set.
 */
export const heldDefinitionSchema = z
  .object({ runtimeId: rowIdSchema, versionId: rowIdSchema, launchHash: sha256HexSchema })
  .strict();
export type HeldDefinition = z.infer<typeof heldDefinitionSchema>;

// ── Engine facts and always-on inventory ──

const factSource = z.enum(["probe", "config", "reader"]);
function fact<T extends z.ZodType>(value: T) {
  return z.object({ value, source: factSource }).strict();
}
export const ENGINE_COUNT_CONTEXTS = [
  "unsupported",
  "vllm_tokenize",
  "tgi_chat_tokenize",
  "llama_apply_template",
  "llama_input_tokens",
  "reader_count",
] as const;
export const engineFactsSchema = z
  .object({
    engine: fact(z.enum(ENGINES)).optional(),
    slots: fact(z.number().int().min(1).max(10_000)).optional(),
    ctxPerSlot: fact(tokenCount).optional(),
    kvTokens: fact(tokenCount).optional(),
    maxModelLen: fact(tokenCount).optional(),
    hostPromptCacheMiB: fact(z.number().int().min(0).max(100_000_000)).optional(),
    /** The runtime's metrics reader (route or command) and the signals it maps. */
    loadReader: z
      .object({
        value: z
          .object({
            input: z.enum(["route", "command"]),
            signals: z.array(z.enum(READER_SIGNALS)).max(READER_SIGNALS.length),
          })
          .strict(),
        source: z.literal("config"),
      })
      .strict()
      .optional(),
    countContext: fact(z.enum(ENGINE_COUNT_CONTEXTS)).optional(),
  })
  .strict();
export type EngineFactsWire = z.infer<typeof engineFactsSchema>;

export const inventoryModelSchema = z
  .object({
    id: z.string().min(1).max(256),
    /** Probe result; the server stores it as `RuntimeModel.detectedCapabilities`. */
    capabilities: z.array(z.enum(MODEL_CAPABILITIES)).max(MODEL_CAPABILITIES.length),
    embeddingContract: embeddingContractSchema.optional(),
    transcription: transcriptionProfileSchema.optional(),
    engineFacts: engineFactsSchema.optional(),
  })
  .strict();

/** One always-on runtime the node holds (server-origin or added with `wsmp runtime add`). */
export const alwaysOnInventorySchema = z
  .object({
    slug: runtimeHandleSchema,
    origin: z.enum(["node", "server"]),
    /** Server-origin only. */
    runtimeId: rowIdSchema.optional(),
    versionId: rowIdSchema.optional(),
    launchHash: sha256HexSchema,
    /** Node-origin only: the server creates or versions the Runtime from it. */
    spec: runtimeSpecSchema.optional(),
    status: z.enum(["unknown", "online", "degraded", "offline"]),
    models: z.array(inventoryModelSchema).max(1000),
    engineFacts: engineFactsSchema.optional(),
    /**
     * One entry must fit one chunk: the node first drops per-model engine facts, then models,
     * and says so here (the server keeps the models it already knows).
     */
    truncated: z.literal(true).optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const server = entry.origin === "server";
    if (server !== (entry.runtimeId !== undefined && entry.versionId !== undefined))
      ctx.addIssue({ code: "custom", message: "runtimeId/versionId exactly for server origin." });
    if (server === (entry.spec !== undefined))
      ctx.addIssue({ code: "custom", message: "spec exactly for node origin." });
  });
export type AlwaysOnInventory = z.infer<typeof alwaysOnInventorySchema>;

/** One rank of a startable instance the node runs (from `runtime-instances.json`). */
export const instanceRecordSchema = z
  .object({
    instanceId: rowIdSchema,
    launchVersionId: rowIdSchema,
    launchHash: sha256HexSchema,
    rank: rankSchema,
    intentHash: sha256HexSchema,
    stepId: rowIdSchema.optional(),
    phase: z.enum(["starting", "ready", "unhealthy", "stopping", "stopped", "unknown"]),
    unitName: z.string().regex(UNIT_NAME_PATTERN),
    port: portSchema,
    handle: z.string().regex(INSTANCE_HANDLE_PATTERN),
    /**
     * The ids the launch version's spec lists, echoed (never probed). A startable runtime
     * serves exactly the models its spec lists; one that lists none is a service and serves
     * none, so there is nothing to detect.
     */
    models: z.array(z.string().min(1).max(256)).max(64),
    engineFacts: engineFactsSchema.optional(),
  })
  .strict();
export type InstanceRecord = z.infer<typeof instanceRecordSchema>;

// ── node.info / node.metrics ──

export const nodeInfoFrameSchema = z
  .object({
    type: z.literal("node.info"),
    os: z
      .object({
        name: shortText.optional(),
        version: shortText.optional(),
        kernel: shortText.optional(),
        arch: z.string().trim().min(1).max(32).optional(),
      })
      .strict()
      .optional(),
    cpu: z
      .object({
        model: shortText.optional(),
        cores: z.number().int().min(1).max(65_536).optional(),
      })
      .strict()
      .optional(),
    memoryTotalMiB: mib.optional(),
    /** Unified-memory pool the accelerator can use (APU/Apple). */
    unifiedMemoryMiB: mib.optional(),
    acceleratorMemoryMiB: mib.optional(),
    gpus: z
      .array(
        z
          .object({
            vendor: z.enum(["nvidia", "amd", "intel", "apple", "other"]),
            index: z.number().int().min(0).max(255),
            name: shortText.optional(),
            uuid: z.string().trim().min(1).max(128).optional(),
            driverVersion: z.string().trim().min(1).max(64).optional(),
            vramTotalMiB: mib.nullable().optional(),
            gttTotalMiB: mib.optional(),
            gfxTarget: z
              .string()
              .regex(/^gfx[0-9a-f]{3,5}$/)
              .optional(),
            apu: z.boolean().optional(),
            pciId: z
              .string()
              .regex(/^[0-9a-fA-F]{4}:[0-9a-fA-F]{4}$/)
              .optional(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    nodeKind: z.enum(["unified", "discrete", "cpu"]).optional(),
    interfaces: z
      .array(
        z
          .object({
            name: z.string().regex(/^[A-Za-z0-9_.:@-]{1,64}$/),
            addresses: z.array(z.string().min(1).max(64)).max(16).optional(),
            linkSpeedMbps: z.number().int().min(0).max(10_000_000).optional(),
            mtu: z.number().int().min(0).max(1_000_000).optional(),
            /** An RDMA device is bound to this interface (fabric suggestions only). */
            rdma: z.boolean().optional(),
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
    version: z.string().trim().min(1).max(80).optional(),
    /** The node-side hardware declaration (config.json `hardware`), incl. reserved memory. */
    declared: nodeDeclaredHardwareSchema.optional(),
  })
  .strict();

export const nodeMetricsFrameSchema = z
  .object({
    type: z.literal("node.metrics"),
    ts: isoTimeSchema,
    cpu: z
      .object({
        usagePercent: percent.optional(),
        load1: z.number().min(0).max(1_000_000).optional(),
        load5: z.number().min(0).max(1_000_000).optional(),
        load15: z.number().min(0).max(1_000_000).optional(),
      })
      .strict()
      .optional(),
    memory: z
      .object({
        totalMiB: mib.optional(),
        availableMiB: mib.optional(),
        swapTotalMiB: mib.optional(),
        swapFreeMiB: mib.optional(),
      })
      .strict()
      .optional(),
    disks: z
      .array(
        z
          .object({
            mount: z.string().min(1).max(256),
            totalMiB: mib.optional(),
            freeMiB: mib.optional(),
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
            vramUsedMiB: mib.nullable().optional(),
            vramTotalMiB: mib.nullable().optional(),
            gttUsedMiB: mib.nullable().optional(),
            utilizationPercent: percent.nullable().optional(),
            temperatureC: z.number().min(-100).max(300).nullable().optional(),
            powerW: z.number().min(0).max(100_000).nullable().optional(),
            smClockMHz: z.number().min(0).max(100_000).nullable().optional(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    interfaces: z
      .array(
        z
          .object({
            name: z.string().regex(/^[A-Za-z0-9_.:@-]{1,64}$/),
            rxBytes: byteCounter,
            txBytes: byteCounter,
          })
          .strict(),
      )
      .max(32)
      .optional(),
    /** Values from the node metric commands (`runtime.define.node.metricCommands`). */
    custom: z
      .array(
        z
          .object({
            name: metricName,
            /** Label values are free text (GPU names have spaces), no control characters. */
            labels: z
              .record(metricName, z.string().regex(/^[^\p{Cc}]{1,128}$/u))
              .refine((labels) => Object.keys(labels).length <= 16)
              .optional(),
            value: z.number().finite(),
            ts: isoTimeSchema,
          })
          .strict(),
      )
      /** 16 metric commands × 16 metrics each. */
      .max(256)
      .optional(),
    /** Per metric command status. Command text and output never leave the node. */
    metricCommands: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
            state: z.enum(["active", "failing"]),
            error: z
              .enum(["spawn", "timeout", "exit_status", "output_too_large", "parse"])
              .optional(),
          })
          .strict(),
      )
      .max(16)
      .optional(),
    abandonedRecovery: z.number().int().min(0).max(10_000).optional(),
  })
  .strict()
  // The node drops custom values (last command first) until the frame fits the budget.
  .refine(
    (frame) => new TextEncoder().encode(JSON.stringify(frame)).byteLength <= CHUNK_BUDGET_BYTES,
    { message: "node.metrics stays within the chunk budget." },
  );

// ── runtime.load ──

export const runtimeLoadFrameSchema = z
  .object({
    type: z.literal("runtime.load"),
    handle: runtimeHandleSchema,
    model: z.string().min(1).max(256).optional(),
    running: nonNegativeCount,
    waiting: nonNegativeCount.optional(),
    kvUsage: z.number().min(0).max(1).optional(),
    kvOccupancy: z.number().min(0).max(1).optional(),
    slotsBusy: nonNegativeCount.optional(),
    deferred: nonNegativeCount.optional(),
    prefixCacheHitsDelta: byteCounter.optional(),
    prefixCacheQueriesDelta: byteCounter.optional(),
    prefixCacheReset: z.literal(true).optional(),
    counterEpoch: z.number().int().min(0).max(4_294_967_295),
    source: z.enum(["builtin", "route", "command"]),
    ts: isoTimeSchema,
  })
  .strict()
  .refine((load) => load.source !== "builtin" || load.waiting !== undefined, {
    message: "waiting is required for the built-in reader.",
    path: ["waiting"],
  });

// ── runtime.define ──

export const definitionEnvelopeSchema = z
  .object({
    runtimeId: rowIdSchema,
    versionId: rowIdSchema,
    /** sha256(canonical(spec)); the node recomputes it and refuses `hash_mismatch`. */
    launchHash: sha256HexSchema,
    kind: z.enum(RUNTIME_KINDS),
    slug: runtimeHandleSchema,
    spec: runtimeSpecSchema,
  })
  .strict()
  .refine((envelope) => (envelope.kind === "startable") === !!envelope.spec.launch, {
    message: "kind must match the spec (launch ⇔ startable).",
  });
export type DefinitionEnvelope = z.infer<typeof definitionEnvelopeSchema>;

/**
 * One chunk of a define operation. The server splits an operation by bytes
 * (`CHUNK_BUDGET_BYTES`; one envelope always fits, see `RUNTIME_SPEC_MAX_BYTES`); the node
 * applies the operation once, after the `final` chunk, and answers every chunk.
 */
export const runtimeDefineFrameSchema = z
  .object({
    type: z.literal("runtime.define"),
    opId: relayIdSchema,
    chunkIndex: z.number().int().min(0).max(RUNTIME_DEFINITIONS_MAX),
    final: z.boolean(),
    /** New versions to hold. */
    put: z.array(definitionEnvelopeSchema).max(RUNTIME_DEFINITIONS_MAX).optional(),
    /** `complete` only: versions the node already holds and keeps (no re-send). */
    keep: z.array(rowIdSchema).max(RUNTIME_DEFINITIONS_MAX).optional(),
    /** Incremental only: versions to drop. */
    remove: z.array(rowIdSchema).max(RUNTIME_DEFINITIONS_MAX).optional(),
    /**
     * Same on every chunk of the operation. true: the operation carries the WHOLE server-origin
     * set; after the final chunk the node holds exactly `put` ∪ `keep` (over all chunks) and drops
     * every other server-origin version. false/absent: apply `put` and `remove` only. The server
     * never omits a version a running instance launched from.
     */
    complete: z.boolean().optional(),
    /** The node's own definition, at most once per operation; frozen with the rest at Relay only. */
    node: z
      .object({
        portRange: portRangeSchema,
        metricCommands: z
          .object({ hash: sha256HexSchema, commands: nodeMetricCommandsSchema })
          .strict(),
        /**
         * The fabrics this node is in (owner decision round 3): its own IP and every member's
         * IP per fabric. At Relay only the node keeps its frozen copy, and a multi-node job is
         * refused unless the head address is a member of the job's fabric in that copy.
         */
        fabrics: z.object({ hash: sha256HexSchema, sets: nodeFabricSetsSchema }).strict(),
        /** The longest lifetime of one node command. */
        commandMaxMs: z.number().int().min(NODE_COMMAND_MIN_MS).max(NODE_COMMAND_MAX_MS),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((frame) => !frame.complete || frame.remove === undefined, {
    message: "A complete operation lists put and keep, never remove.",
  })
  .refine((frame) => frame.complete || frame.keep === undefined, {
    message: "keep belongs to complete operations.",
  })
  .refine(
    (frame) =>
      (frame.put?.length ?? 0) + (frame.keep?.length ?? 0) + (frame.remove?.length ?? 0) <=
      DEFINE_CHUNK_MAX_VERSIONS,
    { message: "One chunk names at most 64 versions (so its answer fits one frame)." },
  );

export const DEFINE_REJECT_REASONS = [
  "trust_relay",
  "hash_mismatch",
  "invalid",
  "base_url_not_allowed",
  "env_not_allowed",
  "conflict",
  "limit",
] as const;
/** Answers one define chunk; the final answer also carries the node's whole held state. */
const encodedBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

export const runtimeDefineResultFrameSchema = z
  .object({
    type: z.literal("runtime.define.result"),
    opId: relayIdSchema,
    chunkIndex: z.number().int().min(0).max(RUNTIME_DEFINITIONS_MAX),
    final: z.boolean(),
    /**
     * One entry per `put`, and one per `remove` of a version the node held (at most 64
     * together). A `remove` naming a version the node does not hold is a no-op with no entry
     * (it has no runtimeId to report). Versions a complete operation drops implicitly are not
     * listed either: the final `held` set is authoritative.
     */
    results: z
      .array(
        z
          .object({
            runtimeId: rowIdSchema,
            versionId: rowIdSchema,
            status: z.enum(["applied", "unchanged", "removed", "rejected"]),
            reason: z.enum(DEFINE_REJECT_REASONS).optional(),
            /** For `invalid`: the JSON path (never spec text). */
            detail: z
              .string()
              .regex(/^[A-Za-z0-9_.$[\]-]{1,128}$/)
              .optional(),
          })
          .strict()
          .refine((result) => (result.status === "rejected") === (result.reason !== undefined), {
            message: "reason exactly for rejected entries.",
          }),
      )
      .max(DEFINE_CHUNK_MAX_VERSIONS),
    node: z
      .object({
        status: z.enum(["applied", "unchanged", "rejected"]),
        reason: z.enum(DEFINE_REJECT_REASONS).optional(),
      })
      .strict()
      .optional(),
    /** Final only: the node's complete held set (replaces Node.heldDefinitions). */
    held: z.array(heldDefinitionSchema).max(RUNTIME_DEFINITIONS_MAX).optional(),
    /** Final only: hash of the metric commands the node holds (null: none received yet). */
    heldMetricCommandsHash: sha256HexSchema.nullable().optional(),
    heldPortRange: portRangeSchema.nullable().optional(),
    /** Final only: hash of the fabric sets the node holds (null: none received yet). */
    heldFabricsHash: sha256HexSchema.nullable().optional(),
    frozen: z.boolean().optional(),
  })
  .strict()
  .refine(
    (frame) =>
      [
        frame.held,
        frame.heldMetricCommandsHash,
        frame.heldPortRange,
        frame.heldFabricsHash,
        frame.frozen,
      ].every((field) => (field !== undefined) === frame.final),
    {
      message:
        "held, heldMetricCommandsHash, heldPortRange, heldFabricsHash and frozen exactly on the final answer.",
    },
  )
  .refine((frame) => encodedBytes(frame) <= CHUNK_BUDGET_BYTES, {
    message: "A define answer stays within the chunk budget.",
  });

// ── runtime.job ──

export const RUNTIME_JOB_PHASES = [
  "prepare",
  "start",
  "after_join",
  "readiness",
  "health",
  "stop",
  "status",
] as const;
/** Canonical decimal, sent as a JSON string and substituted verbatim (§4.6). */
export const canonicalDecimalSchema = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/);
export const jobPlaceholdersSchema = z
  .object({
    port: z.number().int().min(1024).max(65_535),
    dist_port: z.number().int().min(1024).max(65_535).optional(),
    /** The head's IP on the instance's fabric (`fabricIpSchema`, as the node checks it). */
    head_addr: fabricIpSchema.optional(),
    gpu_ids: z
      .string()
      .regex(/^[0-9]{1,3}(?:,[0-9]{1,3}){0,255}$/)
      .optional(),
    memory_gb: canonicalDecimalSchema.optional(),
    vram_gb: canonicalDecimalSchema.optional(),
    memory_fraction: canonicalDecimalSchema.optional(),
  })
  .strict();
export type JobPlaceholders = z.infer<typeof jobPlaceholdersSchema>;

export const runtimeJobFrameSchema = z
  .object({
    type: z.literal("runtime.job"),
    stepId: rowIdSchema,
    instanceId: rowIdSchema,
    runtimeId: rowIdSchema,
    /** The version the node launched (B1); rendered from the held/frozen copy with this hash. */
    launchVersionId: rowIdSchema,
    launchHash: sha256HexSchema,
    generation: z.number().int().min(0).max(1_000_000),
    rank: rankSchema,
    /** Must equal the held/frozen definition's `launch.groupSize` (node-checked). */
    nnodes: z.number().int().min(1).max(64),
    phase: z.enum(RUNTIME_JOB_PHASES),
    handle: z.string().regex(INSTANCE_HANDLE_PATTERN),
    unitName: z.string().regex(UNIT_NAME_PATTERN),
    placeholders: jobPlaceholdersSchema,
    /**
     * Multi-node only: the fabric the instance runs in. The node resolves `fabric_ip`,
     * `fabric_iface` and `fabric_rdma_device` from its own IP on it; `head_addr` is the head's
     * IP on it.
     */
    fabricId: rowIdSchema.optional(),
    /** Relative step deadline (the server keeps the absolute `InstanceStep.deadline`). */
    timeoutMs: z.number().int().min(1_000).max(86_400_000),
    ownerEpoch: z.string().regex(/^[A-Za-z0-9_:-]{1,128}$/),
    intentHash: sha256HexSchema,
    /** Present exactly for an interactive step: the operator terminal minted for this dispatch. */
    operator: z
      .object({
        terminalId: base64Url16Schema,
        commandAuthor: z.enum(["user", "agent", "unknown"]),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((job) => job.rank < job.nnodes, { message: "rank must be below nnodes." })
  .refine(
    (job) =>
      job.nnodes > 1 === (job.fabricId !== undefined) &&
      job.nnodes > 1 === (job.placeholders.head_addr !== undefined),
    { message: "fabricId and head_addr exactly for multi-node jobs." },
  )
  .refine((job) => job.unitName === runtimeUnitName(job.handle, job.rank), {
    message: "unitName must be wsmp-<handle>-r<rank>.",
  });
export type RuntimeJobFrame = z.infer<typeof runtimeJobFrameSchema>;

/**
 * Pre-admission codes prove the rank never ran this step, so the server may auto-release its
 * claim (§3.5). Other codes are stored as `InstanceStep.errorCode`.
 */
export const RUNTIME_JOB_PRE_ADMISSION_ERRORS = [
  "execution_mechanism_unavailable",
  "bad_job",
  "interactive_unsupported",
  "operator_terminals_disabled",
  "trust_relay",
  "definition_missing",
  "definition_frozen",
  "local_config_unavailable",
  "session_disconnected",
] as const;
export const RUNTIME_JOB_ERRORS = [
  ...RUNTIME_JOB_PRE_ADMISSION_ERRORS,
  "instance_unknown",
  "owned_launch_unconfirmed",
  "launch_unconfirmed",
  "command_failed",
  "readiness_failed",
  "health_failed",
  "job_deadline",
] as const;
/**
 * Why a status probe (stop proof) answered not stopped, in its `detail`: a process of the
 * rank's units still runs, the status command says running (or could not tell), the port is
 * still in use, or the service runs outside the node's units and has no status command.
 */
export const STOP_PROOF_FAILURES = [
  "process_alive",
  "status_running",
  "status_unknown",
  "port_in_use",
  "unowned_service",
] as const;
export const RUNTIME_JOB_OPERATOR_STATUSES = [
  "awaiting_operator",
  "operator_running",
  "operator_closed",
] as const;

export const runtimeJobResultFrameSchema = z
  .object({
    type: z.literal("runtime.job.result"),
    stepId: rowIdSchema,
    instanceId: rowIdSchema,
    rank: rankSchema,
    intentHash: sha256HexSchema,
    ownerEpoch: z.string().regex(/^[A-Za-z0-9_:-]{1,128}$/),
    status: z.enum(["succeeded", "failed", "running", ...RUNTIME_JOB_OPERATOR_STATUSES]),
    /** True only after the stop command and unit teardown succeeded. */
    stopped: z.boolean(),
    error: z.enum(RUNTIME_JOB_ERRORS).optional(),
    /**
     * Which check failed (`bad_job`, `definition_missing`): a field path, never a value. On a
     * status probe answered not stopped: why ({@link STOP_PROOF_FAILURES}).
     */
    detail: z
      .string()
      .regex(/^[A-Za-z0-9_.$[\]-]{1,128}$/)
      .optional(),
    terminalId: base64Url16Schema.optional(),
    exitCode: z.number().int().min(0).max(255).optional(),
  })
  .strict()
  .refine((result) => (result.status === "failed") === (result.error !== undefined), {
    message: "error exactly on failed results.",
  })
  .refine((result) => result.exitCode === undefined || result.status === "operator_closed", {
    message: "Only operator_closed carries an exit code.",
  });

// ── Kept 2.4 frames ──

const fileOpId = base64Url16Schema;
const fileOpEnvelope = { type: z.literal("file.op"), opId: fileOpId } as const;
/** 2.4 `file.op` without `mode`/`readGrant`: Full control + `files.roots` decide on the node. */
export const fileOpFrameSchema = z.discriminatedUnion("op", [
  z.object({ ...fileOpEnvelope, op: z.literal("read"), args: readArgsSchema }).strict(),
  z.object({ ...fileOpEnvelope, op: z.literal("stat"), args: statArgsSchema }).strict(),
  z.object({ ...fileOpEnvelope, op: z.literal("list"), args: listArgsSchema }).strict(),
  z.object({ ...fileOpEnvelope, op: z.literal("search"), args: searchArgsSchema }).strict(),
  z.object({ ...fileOpEnvelope, op: z.literal("edit"), args: editArgsSchema }).strict(),
  z
    .object({
      ...fileOpEnvelope,
      op: z.literal("write"),
      args: writeRelayArgsSchema,
      bodyBytes: z.number().int().min(0).max(FILE_BODY_MAX_BYTES),
    })
    .strict(),
  z.object({ ...fileOpEnvelope, op: z.literal("rename"), args: renameArgsSchema }).strict(),
  z.object({ ...fileOpEnvelope, op: z.literal("mkdir"), args: mkdirArgsSchema }).strict(),
  z.object({ ...fileOpEnvelope, op: z.literal("delete"), args: deleteArgsSchema }).strict(),
]);
export const FILE_REJECT_WIRE_REASONS = ["bad_frame", "trust_relay", "no_roots"] as const;
export const fileRejectedFrameSchema = z
  .object({
    type: z.literal("file.rejected"),
    opId: fileOpId,
    reason: z.enum([...FILE_ERROR_CODES, ...FILE_REJECT_WIRE_REASONS]),
    detail: fileRejectDetailSchema.optional(),
  })
  .strict()
  .refine(
    (frame) =>
      frame.reason !== "uncertain_outcome" ||
      (frame.detail?.recovery !== undefined && frame.detail.kept !== undefined),
    { message: "uncertain_outcome requires recovery detail.", path: ["detail"] },
  );

const sttItemSeq = z.number().int().min(0).max(STT_ITEM_SEQ_MAX);
const terminalIdentity = z
  .object({
    publicKey: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/),
    signature: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,512}$/)
      .optional(),
  })
  .strict();

// ── Node → server ──

export const helloFrameSchema = z
  .object({
    type: z.literal("hello"),
    id: relayIdSchema,
    protocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
    node: z
      .object({
        slug: nodeSlugSchema,
        /** Display label only (spoofable); normalized by the server. */
        hostname: z.string().max(1024).optional(),
        version: z.string().trim().min(1).max(80).optional(),
        identityPublicKey: p256PublicKeySchema,
        /** Signature over the `hello.challenge` statement with the identity key. */
        identitySignature: p256SignatureSchema,
        /** Browser-terminal key agreement key (kept from 2.4 capabilities). */
        terminalPublicKey: p256PublicKeySchema,
        terminalIdentity: z
          .object({ publicKey: p256PublicKeySchema, signature: p256SignatureSchema })
          .strict()
          .optional(),
      })
      .strict()
      .refine(
        (node) =>
          node.terminalIdentity === undefined ||
          node.terminalIdentity.publicKey === node.identityPublicKey,
        { message: "terminalIdentity.publicKey must equal identityPublicKey." },
      ),
    trust: nodeTrustStateSchema,
    features: nodeFeaturesSchema,
    /** Held server-origin definitions. */
    definitions: z.array(heldDefinitionSchema).max(RUNTIME_DEFINITIONS_MAX),
    heldMetricCommandsHash: sha256HexSchema.nullable(),
    heldPortRange: portRangeSchema.nullable(),
    heldFabricsHash: sha256HexSchema.nullable(),
  })
  .strict();

// ── Node secrets (owner decision round 3) ──

/**
 * Sets one node secret (Full control only; a Relay-only node refuses with `trust_relay`). The
 * value exists only in this frame and on the node (stored 0600): never logged, never stored in
 * the database, redacted from audit records and error descriptions
 * ({@link redactFrameForLog}).
 */
export const secretSetFrameSchema = z
  .object({
    type: z.literal("secret.set"),
    id: relayIdSchema,
    name: nodeSecretNameSchema,
    value: z
      .string()
      .min(1)
      .refine(
        (value) => new TextEncoder().encode(value).byteLength <= NODE_SECRET_VALUE_MAX_BYTES,
        "A secret value is at most 16 KiB.",
      ),
  })
  .strict();

export const SECRET_REFUSALS = ["trust_relay", "invalid", "store_failed", "limit"] as const;
/** The node's answer: the name only, never the value. */
export const secretResultFrameSchema = z
  .object({
    type: z.literal("secret.result"),
    id: relayIdSchema,
    name: nodeSecretNameSchema,
    status: z.enum(["set", "deleted", "not_found", "refused"]),
    reason: z.enum(SECRET_REFUSALS).optional(),
    updatedAt: isoTimeSchema.optional(),
  })
  .strict()
  .refine((frame) => (frame.status === "refused") === (frame.reason !== undefined), {
    message: "reason exactly for refused results.",
  });

export const REDACTED_SECRET_VALUE = "[redacted]";

/**
 * A copy of a frame safe for logs, audit and error text: a `secret.set` value is replaced.
 * Every log/describe path of the relay goes through this (or never touches the frame).
 */
export function redactFrameForLog<T>(frame: T): T {
  if (
    frame !== null &&
    typeof frame === "object" &&
    "type" in frame &&
    frame.type === "secret.set" &&
    "value" in frame
  )
    return { ...frame, value: REDACTED_SECRET_VALUE };
  return frame;
}

// ── Node commands (owner decision round 3: pollable, node-held output) ──

/**
 * A command's state as the node holds it. Sent unprompted when a command ends, in answer to
 * `exec.poll`, and after a reconnect for every command that was running before a daemon
 * restart (`interrupted`). `tail` is the end of the combined stdout/stderr ring buffer (masked
 * by the node), at most `tailBytes` of the poll; `truncated` marks a cut start.
 */
export const execStatusFrameSchema = z
  .object({
    type: z.literal("exec.status"),
    commandId: base64Url16Schema,
    state: z.enum(NODE_COMMAND_STATES),
    exitCode: z.number().int().min(0).max(255).optional(),
    signal: exitSignalSchema,
    startedAt: isoTimeSchema.optional(),
    endsBy: isoTimeSchema.optional(),
    finishedAt: isoTimeSchema.optional(),
    tail: z
      .string()
      .refine(
        (tail) => new TextEncoder().encode(tail).byteLength <= NODE_COMMAND_TAIL_MAX_BYTES,
        "A command output tail is at most 64 KiB.",
      )
      .optional(),
    truncated: z.boolean().optional(),
    /** Output bytes the command produced so far (the ring buffer may hold less). */
    outputBytes: byteCounter.optional(),
  })
  .strict()
  .refine((frame) => (frame.state === "running") === (frame.finishedAt === undefined), {
    message: "finishedAt exactly once the command ended.",
  })
  .refine(
    (frame) =>
      frame.exitCode === undefined || frame.state === "succeeded" || frame.state === "failed",
    { message: "An exit code only for succeeded or failed commands." },
  );

export const nodeToServerControlFrameSchema = z.discriminatedUnion("type", [
  secretResultFrameSchema,
  helloFrameSchema,
  z
    .object({ type: z.literal("heartbeat"), id: relayIdSchema, sentAt: isoTimeSchema.optional() })
    .strict(),
  z
    .object({
      type: z.literal("node.state"),
      trust: nodeTrustStateSchema,
      features: nodeFeaturesSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("runtime.inventory"),
      snapshotId: z.string().regex(/^[A-Za-z0-9]{32}$/),
      chunkIndex: z.number().int().min(0).max(131_071),
      final: z.boolean(),
      alwaysOn: z.array(alwaysOnInventorySchema).max(RUNTIME_INVENTORY_CHUNK_MAX),
      instances: z.array(instanceRecordSchema).max(RUNTIME_INVENTORY_CHUNK_MAX),
    })
    .strict()
    .refine(
      (frame) => frame.alwaysOn.length + frame.instances.length <= RUNTIME_INVENTORY_CHUNK_MAX,
      {
        message: "A chunk carries at most 512 entries.",
      },
    ),
  runtimeLoadFrameSchema,
  runtimeJobResultFrameSchema,
  runtimeDefineResultFrameSchema,
  z
    .object({
      type: z.literal("runtime.detected"),
      /** Echoes `runtime.detect.id` when answering one; absent for periodic scans. */
      id: relayIdSchema.optional(),
      scannedAt: isoTimeSchema,
      servers: z
        .array(
          z
            .object({
              baseUrl: z
                .string()
                .regex(/^http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost):[0-9]{1,5}(?:\/v1)?$/),
              engine: z.enum(ENGINES),
              api: z.enum(RUNTIME_APIS),
              models: z.array(z.string().min(1).max(256)).max(64),
              version: z.string().trim().min(1).max(80).optional(),
            })
            .strict(),
        )
        .max(16),
    })
    .strict(),
  nodeInfoFrameSchema,
  nodeMetricsFrameSchema,
  z
    .object({
      type: z.literal("relay.request.body.ack"),
      requestId: relayIdSchema,
      credits: z.number().int().min(1).max(RELAY_REQUEST_BODY_WINDOW_CHUNKS),
    })
    .strict(),
  z
    .object({
      type: z.literal("relay.response.headers"),
      requestId: relayIdSchema,
      status: z.number().int().min(100).max(599),
      /** Ordered pairs (repeated fields survive). */
      headers: z.array(z.tuple([headerName, headerValue])).max(256),
    })
    .strict(),
  z
    .object({
      type: z.literal("relay.complete"),
      requestId: relayIdSchema,
      usage: z
        .object({
          promptTokens: z.number().int().min(0).optional(),
          completionTokens: z.number().int().min(0).optional(),
          totalTokens: z.number().int().min(0).optional(),
        })
        .strict()
        .optional(),
      metrics: z
        .object({ completionTokens: z.number().int().min(0), tokenizer: z.literal("cl100k_base") })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("relay.error"),
      requestId: relayIdSchema,
      failure: relayFailureSchema,
      message: z.string().max(1000).optional(),
      upstreamStatusCode: z.number().int().min(100).max(599).optional(),
    })
    .strict(),
  z.object({ type: z.literal("relay.cancelled"), requestId: relayIdSchema }).strict(),
  z
    .object({
      type: z.literal("context.count.result"),
      requestId: relayIdSchema,
      tokens: z.number().int().min(0).max(TOKEN_COUNT_MAX),
      method: z.enum([
        "vllm_tokenize",
        "tgi_chat_tokenize",
        "llama_apply_template",
        "llama_input_tokens",
        "reader_count",
      ]),
    })
    .strict(),
  z
    .object({
      type: z.literal("context.count.error"),
      requestId: relayIdSchema,
      failure: relayFailureSchema,
      message: z.string().max(1000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("term.pending"),
      terminalId: base64Url16Schema,
      viewerId: base64Url16Schema.optional(),
      cliNonce: base64Url16Schema,
      approvalCode: z
        .string()
        .regex(/^[A-Z2-7]{8}$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("term.opened"),
      terminalId: base64Url16Schema,
      viewerId: base64Url16Schema.optional(),
      cliNonce: base64Url16Schema,
    })
    .strict(),
  z
    .object({
      type: z.literal("term.attached"),
      terminalId: base64Url16Schema,
      viewerId: base64Url16Schema.optional(),
      cliNonce: base64Url16Schema,
    })
    .strict(),
  z
    .object({
      type: z.literal("term.rejected"),
      terminalId: base64Url16Schema,
      viewerId: base64Url16Schema.optional(),
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
      terminalId: base64Url16Schema,
      viewerId: base64Url16Schema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("term.input_dropped"),
      terminalId: base64Url16Schema,
      viewerId: base64Url16Schema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("term.exit"),
      terminalId: base64Url16Schema,
      exitCode: z.number().int().min(0).max(255).optional(),
      signal: exitSignalSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("exec.started"),
      commandId: base64Url16Schema,
      startedAt: isoTimeSchema,
      /** startedAt + min(timeoutMs, the node's commandMaxMs). */
      endsBy: isoTimeSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("exec.rejected"),
      commandId: base64Url16Schema,
      reason: z.string().min(1).max(64),
    })
    .strict(),
  execStatusFrameSchema,
  fileResultFrameSchema,
  fileRejectedFrameSchema,
  ...sttClientControlSchemas,
]);
export type NodeToServerControlFrame = z.infer<typeof nodeToServerControlFrameSchema>;

// ── Server → node ──

export const RELAY_PROTOCOL_ERROR_CODES = [
  "upgrade_cli",
  "upgrade_server",
  "identity_mismatch",
  "access_denied",
  "malformed",
  "internal",
] as const;

export const serverToNodeControlFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("hello.challenge"),
      nonce: base64Url16Schema,
      /** Canonical public origin mixed into the hello identity statement. */
      origin: z.string().url().max(2048),
    })
    .strict(),
  z
    .object({
      type: z.literal("hello.ok"),
      id: relayIdSchema,
      protocolVersion: z.literal(RELAY_PROTOCOL_VERSION),
      nodeId: rowIdSchema,
      /**
       * `expect`: a `runtime.define` diff follows before any job, so the node does not report
       * missing definitions yet. `none`: the node is Relay only, or nothing differs.
       */
      definitionSync: z.enum(["expect", "none"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("protocol.error"),
      failure: z.literal("protocol_error"),
      code: z.enum(RELAY_PROTOCOL_ERROR_CODES),
      message: z.string().min(1).max(1000),
      supportedVersions: z.array(z.string().regex(/^\d{1,4}\.\d{1,4}$/)).max(8),
      requestId: relayIdSchema.optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("heartbeat.pong"), id: relayIdSchema, receivedAt: isoTimeSchema })
    .strict(),
  /** A person lowered trust in the browser; the node persists relay and answers `node.state`. */
  z
    .object({ type: z.literal("trust.lower"), id: relayIdSchema, requestedAt: isoTimeSchema })
    .strict(),
  secretSetFrameSchema,
  z
    .object({ type: z.literal("secret.delete"), id: relayIdSchema, name: nodeSecretNameSchema })
    .strict(),
  runtimeDefineFrameSchema,
  z.object({ type: z.literal("runtime.detect"), id: relayIdSchema }).strict(),
  z
    .object({
      type: z.literal("runtime.inventory.ok"),
      snapshotId: z.string().regex(/^[A-Za-z0-9]{32}$/),
    })
    .strict(),
  z
    .object({
      type: z.literal("runtime.inventory.error"),
      snapshotId: z.string().regex(/^[A-Za-z0-9]{32}$/),
      message: z.string().min(1).max(1000),
    })
    .strict(),
  runtimeJobFrameSchema,
  z
    .object({
      type: z.literal("relay.request"),
      requestId: relayIdSchema,
      family: z.enum([
        "chat.completions",
        "embeddings",
        "responses",
        "messages",
        "audio",
        "images",
        "generic",
      ]),
      method: z.enum(["GET", "POST", "DELETE"]),
      /** Checked by the node against the §4.8 allowlist for the runtime's api and model type. */
      path: z.string().min(1).max(2048),
      headers: z.record(headerName, headerValue),
      timeoutMs: z.number().int().min(1_000).max(3_600_000),
      handle: runtimeHandleSchema,
      expectBody: z.boolean(),
      /** The exact body length, so the node sends Content-Length (never chunked framing). */
      bodyBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
      countFirst: z.boolean().optional(),
      countCeiling: z.number().int().min(1).max(TOKEN_COUNT_MAX).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("relay.cancel"),
      requestId: relayIdSchema,
      reason: relayFailureSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("term.open"),
      terminalId: base64Url16Schema,
      viewerId: base64Url16Schema.optional(),
      cols: z.number().int().min(1).max(1000),
      rows: z.number().int().min(1).max(1000),
      browserPublicKey: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/),
      browserNonce: base64Url16Schema,
      identity: terminalIdentity.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("term.attach"),
      terminalId: base64Url16Schema,
      viewerId: base64Url16Schema.optional(),
      browserPublicKey: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/),
      browserNonce: base64Url16Schema,
      identity: terminalIdentity.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("term.detach"),
      terminalId: base64Url16Schema,
      viewerId: base64Url16Schema.optional(),
    })
    .strict(),
  z.object({ type: z.literal("term.close"), terminalId: base64Url16Schema }).strict(),
  z
    .object({
      type: z.literal("term.auth"),
      terminalId: base64Url16Schema,
      viewerId: base64Url16Schema.optional(),
      signature: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/),
    })
    .strict(),
  z
    .object({
      type: z.literal("exec.start"),
      commandId: base64Url16Schema,
      command: z.string().min(1).max(16_384),
      cwd: z.string().min(1).max(4096).optional(),
      /** Requested lifetime; the node caps it at its commandMaxMs and kills the whole tree. */
      timeoutMs: z.number().int().min(1_000).max(NODE_COMMAND_MAX_MS),
    })
    .strict(),
  /** Ask for a command's state and output tail; answered with `exec.status`. */
  z
    .object({
      type: z.literal("exec.poll"),
      commandId: base64Url16Schema,
      tailBytes: z.number().int().min(0).max(NODE_COMMAND_TAIL_MAX_BYTES),
    })
    .strict(),
  z.object({ type: z.literal("exec.cancel"), commandId: base64Url16Schema }).strict(),
  /** Nested union on `op` (one `file.op` type). */
  fileOpFrameSchema,
  z.object({ type: z.literal("file.cancel"), opId: fileOpId }).strict(),
  z
    .object({
      type: z.literal("stt.open"),
      sessionId: sttSessionIdSchema,
      handle: sttHandleSchema,
      upstreamModel: z
        .string()
        .min(1)
        .refine(
          (model) =>
            !model.includes("\0") &&
            new TextEncoder().encode(model).byteLength <= STT_MODEL_MAX_BYTES,
        ),
      adapter: z.enum(REALTIME_TRANSCRIPTION_ADAPTERS),
      config: sttConfigSchema,
      maxItemSeconds: z
        .number()
        .int()
        .min(REALTIME_MAX_ITEM_SECONDS_MIN)
        .max(REALTIME_MAX_ITEM_SECONDS_MAX),
      maxSessionMs: z.number().int().min(STT_MAX_SESSION_MS_MIN).max(STT_MAX_SESSION_MS_MAX),
      audioWindowBytes: z
        .number()
        .int()
        .min(STT_AUDIO_FRAME_MAX_BYTES)
        .max(STT_AUDIO_WINDOW_MAX_BYTES)
        .refine((bytes) => bytes % 2 === 0),
    })
    .strict()
    .refine(
      (open) =>
        open.adapter !== "segmented" ||
        open.maxItemSeconds <= REALTIME_SEGMENTED_MAX_ITEM_SECONDS_MAX,
      "The segmented adapter allows at most 120 seconds per item.",
    ),
  z
    .object({
      type: z.literal("stt.update"),
      sessionId: sttSessionIdSchema,
      config: sttConfigSchema,
    })
    .strict(),
  z
    .object({ type: z.literal("stt.commit"), sessionId: sttSessionIdSchema, itemSeq: sttItemSeq })
    .strict(),
  z
    .object({ type: z.literal("stt.clear"), sessionId: sttSessionIdSchema, itemSeq: sttItemSeq })
    .strict(),
  z
    .object({
      type: z.literal("stt.close"),
      sessionId: sttSessionIdSchema,
      reason: relayFailureSchema,
    })
    .strict(),
]);
export type ServerToNodeControlFrame = z.infer<typeof serverToNodeControlFrameSchema>;

// ── Binary frame metadata (4-byte length + JSON metadata + body) ──

const relayBodyFields = {
  requestId: relayIdSchema,
  chunkId: z.string().trim().min(1).max(128),
  final: z.boolean().optional(),
};
const sealedSeq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const termSealedSchema = z
  .object({
    type: z.literal("term.sealed"),
    terminalId: base64Url16Schema,
    seq: sealedSeq,
    viewerId: base64Url16Schema.optional(),
    epoch: z.number().int().min(1).max(0xffff_ffff).optional(),
  })
  .strict()
  .refine((frame) => frame.viewerId === undefined || frame.epoch === undefined, {
    message: "A sealed frame is either unicast or broadcast.",
  });

export const serverToNodeBinaryMetadataSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("relay.request.body"), ...relayBodyFields }).strict(),
  termSealedSchema,
  fileBodyMetadataSchema,
  sttAudioMetadataSchema,
]);
export const nodeToServerBinaryMetadataSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("relay.response.body"), ...relayBodyFields }).strict(),
  termSealedSchema,
  fileDataMetadataSchema,
]);

/** Every control frame type of 3.0, by direction (the fixture test checks coverage). */
export const NODE_TO_SERVER_CONTROL_TYPES: readonly NodeToServerControlFrame["type"][] = [
  ...new Set(nodeToServerControlFrameSchema.options.map((option) => option.shape.type.value)),
];
export const SERVER_TO_NODE_CONTROL_TYPES: readonly ServerToNodeControlFrame["type"][] = [
  ...new Set(
    serverToNodeControlFrameSchema.options.flatMap((option) =>
      "shape" in option ? [option.shape.type.value] : option.options.map((o) => o.shape.type.value),
    ),
  ),
];
