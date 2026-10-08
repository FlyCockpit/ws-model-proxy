import { z } from "zod";
import {
  declaredHardwareSchema,
  fabricNameSchema,
  NODE_COMMAND_DEFAULT_TIMEOUT_MS,
  NODE_COMMAND_GET_WAIT_MAX_MS,
  NODE_COMMAND_MAX_MS,
  NODE_COMMAND_MIN_MS,
  NODE_SECRET_VALUE_MAX_BYTES,
  nodeFabricMembershipsSchema,
  nodeFeaturesSchema,
  nodeMetricCommandsSchema,
  nodeSecretNameSchema,
  portRangeSchema,
  runtimeLabelsSchema,
} from "../lib/runtime-spec";
import {
  ACTOR,
  CLAIM_STATE,
  confirmDeleteSchema,
  confirmRunSchema,
  ENGINE,
  INSTANCE_PHASE,
  idSchema,
  isoDateSchema,
  NODE_AUDIT_KIND,
  NODE_AUDIT_OUTCOME,
  NODE_COMMAND_STATE,
  NODE_CONNECTION,
  NODE_TRUST,
  nameSchema,
  nodeSlugSchema,
  nodeSlugShapeSchema,
  noInputSchema,
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
  })
  .strict();

/** `browser`: declared by a person; `agent`: declared by an agent (node_update). */
const hardwareSourceSchema = z.enum(["browser", "agent", "node", "detected"]);
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
          /** Null when the GPU shares system memory (`unified`). */
          vramGb: z.number().nullable(),
          /** Shares system memory (GB10, an APU): placement counts it against node memory. */
          unified: z.boolean(),
          reservedVramGb: z.number(),
          source: hardwareSourceSchema,
        })
        .strict(),
    ),
    /** Usable = effective total − reserved − VRAM reserved on unified GPUs (− 2 GiB headroom on unified). */
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

/** A person's hold on a node (owner decision round 3): nothing is placed there. */
export const nodeHoldSchema = z
  .object({
    at: isoDateSchema,
    note: z.string().nullable(),
    /** Set by applying this profile (a "hold node" line); null: a person set it here. */
    profileId: idSchema.nullable(),
  })
  .strict();

export const nodeSummarySchema = z
  .object({
    id: idSchema,
    slug: nodeSlugShapeSchema,
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
    hold: nodeHoldSchema.nullable(),
    /** Temporary node: deleted after being offline this long. */
    removeAfterOfflineMs: z.number().int().nullable(),
  })
  .strict();

/**
 * One row of the node list: the summary plus what an agent needs to pick a node without a
 * get per node (MCP drops nulls and empty lists from these rows).
 */
export const nodeListRowSchema = nodeSummarySchema
  .extend({
    hostname: z.string().nullable(),
    /** Fabric memberships: this node's address and how many other nodes share the fabric. */
    fabrics: z.array(
      z.object({ name: z.string(), ip: z.string(), peerCount: z.number().int() }).strict(),
    ),
    gpus: z.array(
      z
        .object({
          vendor: z.enum(["nvidia", "amd", "intel", "apple", "other"]),
          name: z.string().nullable(),
        })
        .strict(),
    ),
    secretNames: z.array(z.string()),
  })
  .strict();

export const nodeFabricViewSchema = z
  .object({
    fabricId: idSchema,
    name: z.string(),
    ip: z.string(),
    /** Other nodes in this fabric. */
    peers: z.array(z.object({ nodeId: idSchema, slug: z.string(), ip: z.string() }).strict()),
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
    fabrics: z.array(nodeFabricViewSchema),
    fabricsInSync: z.boolean(),
    /** From node.info: addresses that look like a fast link (only suggestions). */
    fabricSuggestions: z.array(
      z
        .object({
          ip: z.string(),
          linkSpeedMbps: z.number().int().nullable(),
          rdma: z.boolean(),
          /** Nodes with a fast or RDMA link in the same subnet, RDMA first. */
          peerNodeIds: z.array(idSchema),
        })
        .strict(),
    ),
    commandMaxMs: z.number().int(),
    /** Names and when they were set; values never leave the node. */
    secrets: z.array(z.object({ name: z.string(), updatedAt: isoDateSchema }).strict()),
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
    /** The agent token's name, or the OAuth client's name; null for people. */
    agentName: z.string().nullable(),
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
    suggestedSlug: nodeSlugShapeSchema.nullable(),
    replaceNodeId: idSchema.nullable(),
    maxUses: z.number().int().min(1).max(50),
    usedCount: z.number().int().min(0),
    lastUsedAt: isoDateSchema.nullable(),
    labels: z.array(z.string()),
    removeAfterOfflineMs: z.number().int().nullable(),
    /** Nodes enrolled with this code (null: deleted since). */
    enrolled: z.array(
      z
        .object({ nodeId: idSchema.nullable(), slug: z.string().nullable(), usedAt: isoDateSchema })
        .strict(),
    ),
    revokedAt: isoDateSchema.nullable(),
  })
  .strict();

/** 1 min .. 30 days offline before a temporary node is deleted. */
export const removeAfterOfflineMsSchema = z.number().int().min(60_000).max(2_592_000_000);
/** A node secret value: 1 byte .. 16 KiB of UTF-8, never stored or shown. */
const nodeSecretValueSchema = z
  .string()
  .min(1)
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= NODE_SECRET_VALUE_MAX_BYTES,
    "At most 16 KiB.",
  );

export const nodeCommandViewSchema = z
  .object({
    commandId: z.string(),
    /**
     * Answering a cancel: it was asked for and the node has not reported the end yet (an
     * offline node gets it when it reconnects). Poll again for the final state.
     */
    cancelRequested: z.boolean().optional(),
    state: z.enum(NODE_COMMAND_STATE),
    exitCode: z.number().int().optional(),
    /** Masked end of the output; null when the node is offline. */
    output: z.string().nullable(),
    truncated: z.boolean().optional(),
    startedAt: isoDateSchema,
    endsBy: isoDateSchema,
    finishedAt: isoDateSchema.optional(),
  })
  .strict();

/**
 * `node_command_get` on an id from `node_command_queue_for_user`: a person decides when (and
 * whether) it runs, in a browser terminal, so there is no output tail. `outcome` is the refusal
 * reason (REFUSED) or the browser terminal it was typed into (RUN).
 */
export const queuedCommandStatusSchema = z
  .object({
    commandId: idSchema,
    queuedForUser: z.literal(true),
    state: z.enum(QUEUED_COMMAND_STATE),
    nodeId: idSchema,
    createdAt: isoDateSchema,
    expiresAt: isoDateSchema,
    decidedAt: isoDateSchema.nullable(),
    outcome: z.string().nullable(),
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
    /** read: continue inside a long line (`more.byteOffset`, with `offset: more.startLine`). */
    byteOffset: z.number().int().min(0).optional(),
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
    noInputSchema,
    z.object({ nodes: z.array(nodeListRowSchema) }).strict(),
    "Your nodes with trust, hardware summary, fabrics, GPUs, secret names and running counts.",
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
        /** Replaces this node's fabric memberships (a new name creates the fabric). */
        fabrics: nodeFabricMembershipsSchema.optional(),
        commandMaxMs: z.number().int().min(NODE_COMMAND_MIN_MS).max(NODE_COMMAND_MAX_MS).optional(),
        /** Ask the node to scan for local servers now. */
        rescan: z.boolean().optional(),
        note: noteSchema.optional(),
      })
      .strict(),
    nodeDetailSchema,
    "Labels, port range, declared hardware, metric commands, fabrics, command lifetime, rescan. Full-control nodes only for everyone (trust_relay). Changing the address of a node a running multi-node instance uses on that fabric is refused (fabric_in_use); a port range that leaves out a port a running instance there uses is refused (port_range_in_use). Secrets go through secrets.set / secrets.delete.",
    ["node_update"],
  ),
  /**
   * Node secrets (owner decision round 3). Write-only: the value goes to the node in one
   * `secret.set` frame and is never stored, logged, audited or echoed (these procedures are
   * excluded from generic input/error logging; the audit records the name only). Full control
   * only: at Relay only they are set with `wsmp secret set NAME` on the node (secret_needs_node).
   */
  secrets: {
    set: mutation(
      "agent",
      z
        .object({
          nodeId: idSchema,
          name: nodeSecretNameSchema,
          value: nodeSecretValueSchema,
          note: noteSchema.optional(),
        })
        .strict(),
      z.object({ name: z.string(), updatedAt: isoDateSchema }).strict(),
      "Set a node secret (write-only, never shown again). Full-control nodes only (secret_needs_node).",
      ["node_secret_set"],
    ),
    delete: mutation(
      "agent",
      z
        .object({ nodeId: idSchema, name: nodeSecretNameSchema, note: noteSchema.optional() })
        .strict(),
      okSchema,
      "Delete a node secret. Full-control nodes only (secret_needs_node).",
      ["node_secret_set"],
    ),
  },
  setHold: mutation(
    "human",
    z.object({ nodeId: idSchema, hold: z.boolean(), note: noteSchema.optional() }).strict(),
    nodeSummarySchema,
    "Hold the node (nothing may be placed there, for anyone) or release it. Holding does not stop what runs; apply a profile with a hold line to switch the node over.",
  ),
  setTemporary: mutation(
    "human",
    z
      .object({ nodeId: idSchema, removeAfterOfflineMs: removeAfterOfflineMsSchema.nullable() })
      .strict(),
    nodeSummarySchema,
    "Make a node temporary (deleted, releasing everything, after being offline this long) or keep it (null). People only: a deletion policy. The sweeper deletes it like a person's delete except that profile items pinning its always-on runtimes are removed first (and recorded in the node activity), never leaving it stuck on pinned_by_profile.",
  ),
  fabrics: {
    list: query(
      "session",
      noInputSchema,
      z
        .object({
          fabrics: z.array(
            z
              .object({
                id: idSchema,
                name: z.string(),
                members: z.array(
                  z.object({ nodeId: idSchema, slug: z.string(), ip: z.string() }).strict(),
                ),
              })
              .strict(),
          ),
        })
        .strict(),
      "Your fabrics and their members (agents see them in nodes_get).",
    ),
    rename: mutation(
      "human",
      z.object({ fabricId: idSchema, name: fabricNameSchema }).strict(),
      okSchema,
      "Rename a fabric (runtime definitions naming the old name stop matching it).",
    ),
    delete: mutation(
      "human",
      z.object({ fabricId: idSchema }).strict(),
      okSchema,
      "Delete a fabric and its memberships (refused while a multi-node instance runs on it: fabric_in_use).",
    ),
  },
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
  /** An agent's delete: offline nodes only (owner decision), audited with the slug and id. */
  deleteOffline: mutation(
    "agent",
    z
      .object({ nodeId: idSchema, confirm: confirmDeleteSchema, note: noteSchema.optional() })
      .strict(),
    z.object({ deleted: z.literal(true), stoppedInstances: z.array(idSchema) }).strict(),
    "Delete an offline node as nodes.delete does; refused while it is online (node_online), with no override.",
    ["node_delete"],
  ),
  lowerTrustPreview: query(
    "human",
    z.object({ nodeId: idSchema }).strict(),
    z
      .object({
        /** What stays defined and keeps running, frozen (lowering protects against future compromise only). */
        frozenRuntimes: z.array(
          z
            .object({
              runtimeId: idSchema,
              versionId: idSchema,
              name: z.string(),
              agentWritten: z.boolean(),
              running: z.boolean(),
            })
            .strict(),
        ),
        frozenMetricCommands: z.array(
          z.object({ name: z.string(), agentWritten: z.boolean() }).strict(),
        ),
        /** Fabric memberships that freeze with the node (multi-node starts need them). */
        frozenFabrics: z.array(
          z.object({ fabricId: idSchema, name: z.string(), ip: z.string() }).strict(),
        ),
        /** Secrets can then be set only with `wsmp secret set` on the node. */
        secretNames: z.array(z.string()),
        /**
         * Node commands still running: the node kills each one's process tree when trust drops
         * and reports it INTERRUPTED. Their state and output stay readable at Relay (exec.poll),
         * and exec.cancel still works; exec.start is refused.
         */
        runningCommands: z.number().int(),
        /** What stops working: commands, files, browser terminals, definition changes, agent starts/stops. */
        openBrowserTerminals: z.number().int(),
        queuedCommandsRefused: z.number().int(),
      })
      .strict(),
    "What the Lower dialog lists before the click: definitions and metric commands that freeze (agent-written ones flagged), and running commands that stop.",
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
    "Lower to Relay only (sticks on the node; only `wsmp trust full` on the node raises it). Running node commands are killed with their process trees and marked INTERRUPTED.",
  ),
  enrollmentCodes: {
    list: query(
      "session",
      noInputSchema,
      z.object({ codes: z.array(enrollmentCodeViewSchema) }).strict(),
      "Unexpired and recently used enrollment codes.",
    ),
    create: mutation(
      "human",
      z
        .object({
          /** Single-use codes only. */
          suggestedSlug: nodeSlugSchema.optional(),
          /** Default 1 h, at most 7 days. */
          ttlHours: z.number().int().min(1).max(168).default(1),
          /** "Replace node <slug>": moves that node to the identity that uses the code (single use). */
          replaceNodeId: idSchema.optional(),
          /** How many nodes may enroll with it (default 1, at most 50). */
          maxUses: z.number().int().min(1).max(50).default(1),
          /** Added to every node enrolled with it. */
          labels: runtimeLabelsSchema.optional(),
          /** Temporary nodes: every node enrolled with it is removed after being offline for an hour (or removeAfterOfflineMs). */
          temporary: z.boolean().optional(),
          /** Implies temporary. */
          removeAfterOfflineMs: removeAfterOfflineMsSchema.optional(),
        })
        .strict()
        .refine(
          (input) =>
            input.maxUses === 1 ||
            (input.suggestedSlug === undefined && input.replaceNodeId === undefined),
          { message: "A multi-use code takes no suggested slug and replaces no node." },
        )
        .refine(
          (input) =>
            input.replaceNodeId === undefined ||
            (input.labels === undefined &&
              input.removeAfterOfflineMs === undefined &&
              input.temporary !== true),
          { message: "A replace code keeps the node's labels and policy." },
        )
        .refine((input) => input.temporary !== false || input.removeAfterOfflineMs === undefined, {
          message: "removeAfterOfflineMs makes the code temporary.",
        }),
      z
        .object({
          code: enrollmentCodeViewSchema,
          /** `wsmp_enr_` + 26 base32 characters; shown once. */
          secret: z.string().regex(/^wsmp_enr_[A-Z2-7]{26}$/),
          installCommand: z.string(),
        })
        .strict(),
      "Mint an enrollment code (single-use by default, up to 50 nodes; minting is the approval).",
    ),
    revoke: mutation(
      "human",
      z.object({ codeId: idSchema }).strict(),
      okSchema,
      "Revoke a code (nodes already enrolled stay).",
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
          /** Default 1 h; capped by the node's commandMaxMs (at most 24 h). */
          timeoutMs: z
            .number()
            .int()
            .min(1_000)
            .max(NODE_COMMAND_MAX_MS)
            .default(NODE_COMMAND_DEFAULT_TIMEOUT_MS),
          confirm: confirmRunSchema,
          note: noteSchema.optional(),
        })
        .strict(),
      nodeCommandViewSchema,
      "Run a command on a Full-control node; answers within about 15 s, with state running and the output so far if it is still going. The node kills the whole process tree at the end.",
      ["node_command_run"],
    ),
    get: mutation(
      "agent",
      z
        .object({
          /** From node_command_run, or from node_command_queue_for_user (its `id`). */
          commandId: idSchema,
          /** Wait up to this long for it to finish. */
          waitMs: z.number().int().min(0).max(NODE_COMMAND_GET_WAIT_MAX_MS).optional(),
          cancel: z.literal(true).optional(),
        })
        .strict(),
      z.union([nodeCommandViewSchema, queuedCommandStatusSchema]),
      "A command's state and output tail (or a queued command's state); optionally wait for it or cancel it.",
      ["node_command_get"],
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
