import { z } from "zod";
import {
  declaredHardwareSchema,
  nodeFeaturesSchema,
  nodeMetricCommandsSchema,
  portRangeSchema,
  runtimeLabelsSchema,
} from "../lib/runtime-spec";
import {
  ACTOR,
  CLAIM_STATE,
  confirmRunSchema,
  ENGINE,
  INSTANCE_PHASE,
  idSchema,
  isoDateSchema,
  NODE_AUDIT_KIND,
  NODE_AUDIT_OUTCOME,
  NODE_CONNECTION,
  NODE_TRUST,
  nameSchema,
  nodeSlugSchema,
  noteSchema,
  OPERATOR_NEED,
  okSchema,
  pageInputShape,
  pageOf,
  QUEUED_COMMAND_STATE,
  RUNTIME_API,
  sha256Schema,
} from "./common";
import { mutation, query } from "./procedure";

// ── Views ──

/** Trust as agents and the web see it (§3.2). The server applies RELAY when `effective` is. */
export const nodeTrustViewSchema = z
  .object({
    /** As the node reports it; null before the first hello (treated as Relay only). */
    reported: z.enum(NODE_TRUST).nullable(),
    effective: z.enum(NODE_TRUST),
    /** A person lowered trust; the node has not confirmed yet. */
    lowerPending: z.boolean(),
    frozen: z.boolean(),
    changedAt: isoDateSchema.nullable(),
    /** Shown on Relay-only nodes: the command that raises trust on the node itself. */
    raiseCommand: z.literal("wsmp trust full"),
  })
  .strict();

const hardwareSourceSchema = z.enum(["browser", "node", "detected"]);
function sourced<T extends z.ZodType>(value: T) {
  return z.object({ value: value.nullable(), source: hardwareSourceSchema.nullable() }).strict();
}
export const effectiveHardwareSchema = z
  .object({
    kind: sourced(z.enum(["cpu", "discrete", "unified"])),
    memoryGb: sourced(z.number()),
    acceleratorMemoryGb: sourced(z.number()),
    reservedMemoryGb: sourced(z.number()),
    gpus: z.array(
      z
        .object({
          key: z.string(),
          vendor: z.enum(["nvidia", "amd", "intel", "apple", "other"]),
          index: z.number().int(),
          name: z.string().nullable(),
          vramGb: z.number(),
          reservedVramGb: z.number(),
          source: hardwareSourceSchema,
        })
        .strict(),
    ),
    /** Usable = effective total − reserved (− 2 GiB headroom on unified). */
    usableMemoryGb: z.number(),
    /** What instances on this node reserve now (HELD + HELD_UNKNOWN). */
    reservedNowMemoryGb: z.number(),
    /** Latest node.metrics, when fresh. */
    liveFreeMemoryGb: z.number().nullable(),
    liveFreeAcceleratorGb: z.number().nullable(),
  })
  .strict();

export const detectedServerSchema = z
  .object({
    baseUrl: z.string(),
    engine: z.enum(ENGINE),
    api: z.enum(RUNTIME_API),
    models: z.array(z.string()),
    version: z.string().nullable(),
    /** An always-on runtime already points here. */
    runtimeId: idSchema.nullable(),
  })
  .strict();

export const queuedCommandViewSchema = z
  .object({
    id: idSchema,
    nodeId: idSchema,
    command: z.string(),
    note: z.string().nullable(),
    state: z.enum(QUEUED_COMMAND_STATE),
    agentTokenId: idSchema.nullable(),
    createdAt: isoDateSchema,
    expiresAt: isoDateSchema,
    decidedAt: isoDateSchema.nullable(),
    outcome: z.string().nullable(),
  })
  .strict();

export const nodeSummarySchema = z
  .object({
    id: idSchema,
    slug: nodeSlugSchema,
    name: z.string().nullable(),
    connection: z.enum(NODE_CONNECTION),
    lastHeartbeatAt: isoDateSchema.nullable(),
    version: z.string().nullable(),
    rejectedProtocolVersion: z.string().nullable(),
    trust: nodeTrustViewSchema,
    labels: z.array(z.string()),
    hardwareKind: z.enum(["cpu", "discrete", "unified"]).nullable(),
    liveFreeMemoryGb: z.number().nullable(),
    runningInstances: z.number().int(),
    alwaysOnRuntimes: z.number().int(),
    needsYou: z.number().int(),
  })
  .strict();

export const nodeInstanceRefSchema = z
  .object({
    instanceId: idSchema,
    runtimeId: idSchema,
    runtimeSlug: z.string(),
    /** "node 2 of 3" in the UI; 1-based here. */
    nodeNumber: z.number().int().min(1),
    nodeCount: z.number().int().min(1),
    phase: z.enum(INSTANCE_PHASE),
    reserved: z.enum(CLAIM_STATE),
    needsOperator: z.enum(OPERATOR_NEED).nullable(),
  })
  .strict();

export const nodeDetailSchema = nodeSummarySchema
  .extend({
    hostname: z.string().nullable(),
    features: nodeFeaturesSchema.nullable(),
    hardware: effectiveHardwareSchema,
    declaredHardware: declaredHardwareSchema.nullable(),
    portRange: portRangeSchema,
    metricCommands: nodeMetricCommandsSchema,
    /** True when the node holds what the server last pushed. */
    metricCommandsInSync: z.boolean(),
    heldDefinitions: z.array(
      z
        .object({
          runtimeId: idSchema,
          versionId: idSchema,
          launchHash: sha256Schema,
          /** False when the server's current version differs (frozen or not yet pushed). */
          current: z.boolean(),
        })
        .strict(),
    ),
    instances: z.array(nodeInstanceRefSchema),
    detectedServers: z.array(detectedServerSchema),
    detectedAt: isoDateSchema.nullable(),
    queuedCommands: z.array(queuedCommandViewSchema),
  })
  .strict();

export const nodeAuditEventSchema = z
  .object({
    id: idSchema,
    createdAt: isoDateSchema,
    nodeId: idSchema,
    actor: z.enum(ACTOR),
    agentTokenId: idSchema.nullable(),
    kind: z.enum(NODE_AUDIT_KIND),
    /** File path, `hmac-sha256:<hex> <program>` for commands, `runtime:<id>@<version>`. */
    subject: z.string(),
    outcome: z.enum(NODE_AUDIT_OUTCOME),
    reason: z.string().nullable(),
    exitCode: z.number().int().nullable(),
    startedAt: isoDateSchema,
    finishedAt: isoDateSchema.nullable(),
  })
  .strict();

export const enrollmentCodeViewSchema = z
  .object({
    id: idSchema,
    codePrefix: z.string().length(8),
    createdAt: isoDateSchema,
    expiresAt: isoDateSchema,
    suggestedSlug: nodeSlugSchema.nullable(),
    replaceNodeId: idSchema.nullable(),
    usedAt: isoDateSchema.nullable(),
    usedByNodeId: idSchema.nullable(),
    revokedAt: isoDateSchema.nullable(),
  })
  .strict();

export const nodeCredentialViewSchema = z
  .object({
    id: idSchema,
    nodeId: idSchema,
    createdAt: isoDateSchema,
    lastUsedAt: isoDateSchema.nullable(),
    lastRefusedAt: isoDateSchema.nullable(),
    lastRefusedReason: z.string().nullable(),
    revokedAt: isoDateSchema.nullable(),
  })
  .strict();

const commandTextSchema = z
  .string()
  .min(1)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 16_384, "At most 16 KiB.");

// ── File tool shapes (relay `file.op` args plus the node) ──

const filePathSchema = z.string().min(1).max(4096);
export const nodeFileReadInputSchema = z
  .object({
    nodeId: idSchema,
    path: filePathSchema,
    op: z.enum(["read", "stat", "list", "search"]).default("read"),
    /** read: first line (negative counts from the end); list: depth. */
    offset: z.number().int().min(-1_000_000).optional(),
    limit: z.number().int().min(1).max(2_000).optional(),
    /** search: the pattern; list: a glob. */
    pattern: z.string().min(1).max(1_024).optional(),
    ifNoneMatch: z.string().min(1).max(64).optional(),
  })
  .strict();
export const nodeFileReadOutputSchema = z
  .object({
    op: z.enum(["read", "stat", "list", "search"]),
    etag: z.string().nullable(),
    /** The relay file result for the op (`file-protocol.ts`), large text spilled. */
    result: z.record(z.string(), z.unknown()),
  })
  .strict();
export const nodeFileWriteInputSchema = z
  .object({
    nodeId: idSchema,
    path: filePathSchema,
    op: z.enum(["write", "mkdir", "rename", "delete"]).default("write"),
    content: z.string().optional(),
    encoding: z.enum(["utf-8", "base64"]).optional(),
    to: filePathSchema.optional(),
    ifMatch: z.string().min(1).max(64).optional(),
    note: noteSchema.optional(),
  })
  .strict()
  .refine((input) => (input.op === "write") === (input.content !== undefined), {
    message: "content exactly for write.",
  })
  .refine((input) => (input.op === "rename") === (input.to !== undefined), {
    message: "to exactly for rename.",
  });
export const nodeFileEditInputSchema = z
  .object({
    nodeId: idSchema,
    path: filePathSchema,
    edits: z
      .array(
        z
          .object({
            old: z.string().min(1),
            new: z.string(),
            count: z.union([z.number().int().min(1).max(10_000), z.literal("all")]).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    ifMatch: z.string().min(1).max(64),
    note: noteSchema.optional(),
  })
  .strict();
export const nodeFileMutationOutputSchema = z
  .object({ etag: z.string().nullable(), diff: z.string().nullable() })
  .strict();

// ── Procedures ──

export const nodesContract = {
  list: query(
    "agent",
    z.object({}).strict(),
    z.object({ nodes: z.array(nodeSummarySchema) }).strict(),
    "Your nodes with trust, hardware summary and running counts.",
    ["nodes_get"],
  ),
  get: query(
    "agent",
    z.object({ nodeId: idSchema }).strict(),
    nodeDetailSchema,
    "One node: trust, effective hardware with sources, held definitions, instances, detected servers, queued commands.",
    ["nodes_get"],
  ),
  update: mutation(
    "agent",
    z
      .object({
        nodeId: idSchema,
        labels: runtimeLabelsSchema.optional(),
        portRange: portRangeSchema.optional(),
        /** Replaces the browser/agent declaration; null clears it. */
        hardware: declaredHardwareSchema.nullable().optional(),
        metricCommands: nodeMetricCommandsSchema.optional(),
        /** Ask the node to scan for local servers now. */
        rescan: z.boolean().optional(),
        note: noteSchema.optional(),
      })
      .strict(),
    nodeDetailSchema,
    "Labels, port range, declared hardware, metric commands, rescan. Agents: Full-control nodes only (trust_relay).",
    ["node_update"],
  ),
  rename: mutation(
    "human",
    z.object({ nodeId: idSchema, name: nameSchema.nullable() }).strict(),
    nodeSummarySchema,
    "Set the display name (null = slug).",
  ),
  delete: mutation(
    "human",
    z.object({ nodeId: idSchema }).strict(),
    z.object({ deleted: z.literal(true), stoppedInstances: z.array(idSchema) }).strict(),
    "Delete a node: its always-on runtimes go, every reservation there is released and instances with a part there stop.",
  ),
  lowerTrust: mutation(
    "human",
    z.object({ nodeId: idSchema }).strict(),
    z
      .object({
        trust: nodeTrustViewSchema,
        /** What keeps running frozen: agent-written definitions and metric commands. */
        frozenAgentWritten: z.array(
          z
            .object({
              kind: z.enum(["runtime", "metric_command"]),
              id: z.string(),
              label: z.string(),
            })
            .strict(),
        ),
      })
      .strict(),
    "Lower to Relay only (sticks on the node; only `wsmp trust full` on the node raises it).",
  ),
  enrollmentCodes: {
    list: query(
      "session",
      z.object({}).strict(),
      z.object({ codes: z.array(enrollmentCodeViewSchema) }).strict(),
      "Unexpired and recently used enrollment codes.",
    ),
    create: mutation(
      "human",
      z
        .object({
          suggestedSlug: nodeSlugSchema.optional(),
          /** Default 1 h, at most 7 days. */
          ttlHours: z.number().int().min(1).max(168).default(1),
          /** "Replace node <slug>": moves that node to the identity that uses the code. */
          replaceNodeId: idSchema.optional(),
        })
        .strict(),
      z
        .object({
          code: enrollmentCodeViewSchema,
          /** `wsmp_enr_` + 26 base32 characters; shown once. */
          secret: z.string().regex(/^wsmp_enr_[A-Z2-7]{26}$/),
          installCommand: z.string(),
        })
        .strict(),
      "Mint a single-use enrollment code (minting is the approval).",
    ),
    revoke: mutation(
      "human",
      z.object({ codeId: idSchema }).strict(),
      okSchema,
      "Revoke an unused code.",
    ),
  },
  credentials: {
    list: query(
      "session",
      z.object({ nodeId: idSchema.optional() }).strict(),
      z.object({ credentials: z.array(nodeCredentialViewSchema) }).strict(),
      "Node credentials (one active per node).",
    ),
    revoke: mutation(
      "human",
      z.object({ credentialId: idSchema }).strict(),
      okSchema,
      "Revoke a node credential; the node must enroll again.",
    ),
  },
  activity: {
    list: query(
      "session",
      z
        .object({
          nodeId: idSchema.optional(),
          kind: z.enum(NODE_AUDIT_KIND).optional(),
          ...pageInputShape,
        })
        .strict(),
      pageOf(nodeAuditEventSchema),
      "What agents and people did on your nodes (metadata only).",
    ),
  },
  terminals: {
    openTicket: mutation(
      "human",
      z
        .object({
          nodeId: idSchema,
          cols: z.number().int().min(1).max(1_000),
          rows: z.number().int().min(1).max(1_000),
        })
        .strict(),
      z.object({ ticket: z.string(), terminalId: z.string(), expiresAt: isoDateSchema }).strict(),
      "Open a browser terminal (Full-control nodes only).",
    ),
  },
  queued: {
    list: query(
      "session",
      z
        .object({
          nodeId: idSchema.optional(),
          state: z.enum(QUEUED_COMMAND_STATE).optional(),
        })
        .strict(),
      z.object({ items: z.array(queuedCommandViewSchema) }).strict(),
      "Commands agents queued for you (Terminals page).",
    ),
    enqueue: mutation(
      "agent",
      z
        .object({
          nodeId: idSchema,
          command: commandTextSchema,
          note: noteSchema,
          expiresInHours: z.number().int().min(1).max(168).default(24),
        })
        .strict(),
      queuedCommandViewSchema,
      "Queue a command for a person to run in a browser terminal (Full-control nodes). Agent-only path.",
      ["node_command_queue_for_user"],
    ),
    run: mutation(
      "human",
      z
        .object({
          queuedCommandId: idSchema,
          cols: z.number().int().min(1).max(1_000),
          rows: z.number().int().min(1).max(1_000),
        })
        .strict(),
      z
        .object({
          item: queuedCommandViewSchema,
          ticket: z.string(),
          terminalId: z.string(),
          expiresAt: isoDateSchema,
        })
        .strict(),
      "Open a browser terminal with the command typed; the person presses Enter.",
    ),
    dismiss: mutation(
      "human",
      z.object({ queuedCommandId: idSchema }).strict(),
      queuedCommandViewSchema,
      "Dismiss a queued command.",
    ),
  },
  commands: {
    run: mutation(
      "agent",
      z
        .object({
          nodeId: idSchema,
          command: commandTextSchema,
          cwd: z.string().min(1).max(4_096).optional(),
          timeoutSec: z.number().int().min(1).max(600).default(120),
          confirm: confirmRunSchema,
          note: noteSchema.optional(),
        })
        .strict(),
      z
        .object({
          exitCode: z.number().int().nullable(),
          signal: z.string().nullable(),
          timedOut: z.boolean(),
          /** Masked and capped. */
          stdout: z.string(),
          stderr: z.string(),
          truncated: z.boolean(),
        })
        .strict(),
      "Run a command on a Full-control node; everything it starts dies with it or at 10 min.",
      ["node_command_run"],
    ),
  },
  files: {
    read: mutation(
      "agent",
      nodeFileReadInputSchema,
      nodeFileReadOutputSchema,
      "Read, stat, list or search under the node's file roots (Full control).",
      ["node_file_read"],
    ),
    write: mutation(
      "agent",
      nodeFileWriteInputSchema,
      nodeFileMutationOutputSchema,
      "Write, mkdir, rename or delete under the node's file roots (Full control).",
      ["node_file_write"],
    ),
    edit: mutation(
      "agent",
      nodeFileEditInputSchema,
      nodeFileMutationOutputSchema,
      "Exact-text edits with an etag guard (Full control).",
      ["node_file_edit"],
    ),
  },
} as const;
