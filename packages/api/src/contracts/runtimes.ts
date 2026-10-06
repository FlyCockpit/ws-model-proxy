import { z } from "zod";
import { runtimeSpecSchema } from "../lib/runtime-spec";
import {
  runtimeAdvancedPatchSchema,
  runtimeAdvancedViewSchema,
  runtimeLimitsPatchSchema,
  runtimeLimitsViewSchema,
} from "./advanced";
import {
  actorRefSchema,
  CLAIM_STATE,
  confirmDeleteSchema,
  DESIRED_STATE,
  emailSchema,
  INSTANCE_PHASE,
  idSchema,
  isoDateSchema,
  MODEL_CAPABILITY,
  MODEL_TYPE,
  nameSchema,
  noteSchema,
  OPERATION_KIND,
  OPERATOR_NEED,
  okSchema,
  pageInputShape,
  pageOf,
  RUNTIME_KIND,
  RUNTIME_ORIGIN,
  STEP_PHASE,
  STEP_STATE,
  sha256Schema,
  slugSchema,
} from "./common";
import { mutation, query } from "./procedure";

/** Built-in starting points (`packages/config/src/runtime-presets.ts`). */
export const RUNTIME_PRESETS = [
  "detected",
  "vllm",
  "sglang",
  "llama_cpp",
  "ollama_service",
  "systemd_unit",
] as const;

/** Runtime slugs never look like an instance handle (`i-<id12>`). */
export const runtimeSlugSchema = slugSchema.refine(
  (slug) => !/^i-[a-z0-9]{12}$/.test(slug),
  "This slug is reserved for instances.",
);

// ── Views ──

export const runtimeModelViewSchema = z
  .object({
    id: idSchema,
    upstreamModelId: z.string(),
    type: z.enum(MODEL_TYPE),
    detectedCapabilities: z.array(z.enum(MODEL_CAPABILITY)),
    capabilities: z.array(z.enum(MODEL_CAPABILITY)),
    capabilitiesOverridden: z.boolean(),
    retired: z.boolean(),
    /** Pools using this served model (own and contributed). */
    pools: z.array(
      z.object({ poolId: idSchema, callableId: z.string(), contributed: z.boolean() }).strict(),
    ),
  })
  .strict();

export const instanceRankViewSchema = z
  .object({
    /** 1-based ("node 2 of 3"). */
    nodeNumber: z.number().int().min(1),
    nodeId: idSchema.nullable(),
    nodeSlug: z.string().nullable(),
    port: z.number().int(),
    reserved: z.enum(CLAIM_STATE),
    unitName: z.string(),
  })
  .strict();

export const instanceStepViewSchema = z
  .object({
    id: idSchema,
    nodeNumber: z.number().int().min(1),
    phase: z.enum(STEP_PHASE),
    state: z.enum(STEP_STATE),
    attempts: z.number().int(),
    errorCode: z.string().nullable(),
    operatorTerminalId: z.string().nullable(),
    updatedAt: isoDateSchema,
  })
  .strict();

export const instanceViewSchema = z
  .object({
    id: idSchema,
    runtimeId: idSchema,
    handle: z.string(),
    versionId: idSchema,
    launchVersionId: idSchema,
    versionNumber: z.number().int(),
    desiredState: z.enum(DESIRED_STATE).nullable(),
    phase: z.enum(INSTANCE_PHASE),
    phaseReason: z.string().nullable(),
    phaseChangedAt: isoDateSchema,
    needsOperator: z.enum(OPERATOR_NEED).nullable(),
    startedBy: actorRefSchema.shape.actor,
    restartWindow: z
      .object({
        used: z.number().int(),
        budget: z.number().int(),
        windowMin: z.number().int(),
        nextRestartAt: isoDateSchema.nullable(),
      })
      .strict(),
    ranks: z.array(instanceRankViewSchema),
    openSteps: z.array(instanceStepViewSchema),
    live: z
      .object({
        running: z.number().int().nullable(),
        waiting: z.number().int().nullable(),
        kvUsage: z.number().nullable(),
        slots: z.number().int().nullable(),
        at: isoDateSchema.nullable(),
      })
      .strict(),
  })
  .strict();

export const runtimeVersionSummarySchema = z
  .object({
    id: idSchema,
    version: z.number().int().min(1),
    createdAt: isoDateSchema,
    editor: actorRefSchema,
    note: z.string().nullable(),
    launchHash: sha256Schema,
    /** Edits that keep the launch hash apply to running instances live. */
    launchChanged: z.boolean(),
  })
  .strict();

export const runtimeVersionDetailSchema = runtimeVersionSummarySchema
  .extend({
    runtimeId: idSchema,
    contentHash: sha256Schema,
    spec: runtimeSpecSchema,
    limits: runtimeLimitsViewSchema,
    advanced: runtimeAdvancedViewSchema,
  })
  .strict();

export const runtimeSummarySchema = z
  .object({
    id: idSchema,
    slug: z.string(),
    name: z.string(),
    kind: z.enum(RUNTIME_KIND),
    origin: z.enum(RUNTIME_ORIGIN),
    nodeId: idSchema.nullable(),
    modelType: z.enum(MODEL_TYPE),
    currentVersion: runtimeVersionSummarySchema,
    models: z.array(z.string()),
    instances: z
      .object({
        running: z.number().int(),
        starting: z.number().int(),
        failed: z.number().int(),
        needsYou: z.number().int(),
      })
      .strict(),
    /** Set when forked from a definition someone shared with you. */
    forkedFromVersionId: idSchema.nullable(),
  })
  .strict();

export const runtimeDetailSchema = runtimeSummarySchema
  .extend({
    current: runtimeVersionDetailSchema,
    servedModels: z.array(runtimeModelViewSchema),
    instanceList: z.array(instanceViewSchema),
    shares: z.array(z.object({ id: idSchema, email: z.string() }).strict()),
    /** Your served models contributed to other people's pools. */
    contributions: z.array(
      z.object({ poolId: idSchema, callableId: z.string(), memberId: idSchema }).strict(),
    ),
    /** Nodes holding an older version of this runtime frozen (Relay only). */
    frozenOn: z.array(z.object({ nodeId: idSchema, versionId: idSchema }).strict()),
  })
  .strict();

// ── Previews and operations ──

export const placementSchema = z
  .object({
    nodeId: idSchema,
    nodeSlug: z.string(),
    nodeNumber: z.number().int().min(1),
    port: z.number().int(),
    resources: z.record(z.string(), z.unknown()),
  })
  .strict();

export const previewWarningSchema = z
  .object({
    code: z.enum([
      "low_free_memory",
      "frozen_version",
      "pins_outdated",
      "interactive_needs_person",
      "definition_not_on_node",
    ]),
    nodeId: idSchema.nullable(),
    detail: z.string(),
  })
  .strict();

export const startPreviewSchema = z
  .object({
    /** Echo it back to apply exactly this preview (people); agents may omit it. */
    fingerprint: sha256Schema,
    starts: z.array(
      z
        .object({
          runtimeId: idSchema,
          versionId: idSchema,
          instanceId: idSchema.nullable(),
          placements: z.array(placementSchema),
        })
        .strict(),
    ),
    /** Instances that will be stopped to make room. */
    stops: z.array(
      z
        .object({
          instanceId: idSchema,
          runtimeId: idSchema,
          reason: z.enum(["preempted", "profile_owned_node"]),
        })
        .strict(),
    ),
    kept: z.array(idSchema),
    warnings: z.array(previewWarningSchema),
    /** Why it cannot run (e.g. trust_relay for an agent, definition_frozen). */
    refusals: z.array(z.object({ code: z.string(), nodeId: idSchema.nullable() }).strict()),
  })
  .strict();

export const operationViewSchema = z
  .object({
    id: idSchema,
    kind: z.enum(OPERATION_KIND),
    createdAt: isoDateSchema,
    actor: actorRefSchema,
    instances: z.array(instanceViewSchema),
  })
  .strict();

export const previewOrOperationSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("preview"), preview: startPreviewSchema }).strict(),
  z.object({ mode: z.literal("applied"), operation: operationViewSchema }).strict(),
]);

export const defineResultSchema = z
  .object({
    nodeId: idSchema,
    status: z.enum(["applied", "unchanged", "rejected", "pending", "skipped_trust_relay"]),
    reason: z.string().nullable(),
  })
  .strict();

const limitsInput = runtimeLimitsPatchSchema.optional();
const advancedInput = runtimeAdvancedPatchSchema.optional();

// ── Procedures ──

export const runtimesContract = {
  list: query(
    "agent",
    z.object({}).strict(),
    z.object({ runtimes: z.array(runtimeSummarySchema) }).strict(),
    "Your runtimes with current version and instance counts.",
    ["runtimes_get"],
  ),
  get: query(
    "agent",
    z.object({ runtimeId: idSchema }).strict(),
    runtimeDetailSchema,
    "One runtime: current version (limits with sources), served models, instances, shares, contributions.",
    ["runtimes_get"],
  ),
  versions: {
    list: query(
      "agent",
      z.object({ runtimeId: idSchema, ...pageInputShape }).strict(),
      pageOf(runtimeVersionSummarySchema),
      "Version history with notes and hashes.",
      ["runtimes_get"],
    ),
    get: query(
      "agent",
      z.object({ versionId: idSchema }).strict(),
      runtimeVersionDetailSchema,
      "One version's full definition.",
      ["runtimes_get"],
    ),
  },
  presets: {
    list: query(
      "agent",
      z.object({}).strict(),
      z
        .object({
          presets: z.array(
            z
              .object({
                id: z.enum(RUNTIME_PRESETS),
                kind: z.enum(RUNTIME_KIND),
                spec: runtimeSpecSchema,
                /** Fields the caller must fill (`models[0].id`, `launch.commands[0].start`, ...). */
                fill: z.array(z.string()),
              })
              .strict(),
          ),
        })
        .strict(),
      "Built-in starting points.",
      ["runtimes_get", "runtime_create"],
    ),
  },
  create: mutation(
    "agent",
    z
      .object({
        slug: runtimeSlugSchema,
        name: nameSchema,
        kind: z.enum(RUNTIME_KIND),
        /** ALWAYS_ON: the node it lives on (Full control for agents). */
        nodeId: idSchema.optional(),
        preset: z.enum(RUNTIME_PRESETS).optional(),
        spec: runtimeSpecSchema,
        limits: limitsInput,
        advanced: advancedInput,
        note: noteSchema.optional(),
      })
      .strict()
      .refine((input) => (input.kind === "ALWAYS_ON") === (input.nodeId !== undefined), {
        message: "nodeId exactly for always-on runtimes.",
        path: ["nodeId"],
      })
      .refine((input) => (input.kind === "STARTABLE") === (input.spec.launch !== undefined), {
        message: "A startable runtime has launch; an always-on one has address.",
        path: ["spec"],
      }),
    z
      .object({
        runtime: runtimeSummarySchema,
        version: runtimeVersionSummarySchema,
        define: z.array(defineResultSchema),
      })
      .strict(),
    "Create a runtime (version 1) and push it to the nodes that need it.",
    ["runtime_create"],
  ),
  update: mutation(
    "agent",
    z
      .object({
        runtimeId: idSchema,
        name: nameSchema.optional(),
        spec: runtimeSpecSchema.optional(),
        limits: limitsInput,
        advanced: advancedInput,
        note: noteSchema.optional(),
        /** Restart instances whose launch changed (agents: Full-control nodes only). */
        restartRunning: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        version: runtimeVersionSummarySchema,
        adoptedLive: z.array(idSchema),
        needsRestart: z.array(
          z
            .object({
              instanceId: idSchema,
              reason: z.enum(["launch_changed", "trust_relay", "interactive"]),
            })
            .strict(),
        ),
        restarted: z.array(idSchema),
        define: z.array(defineResultSchema),
      })
      .strict(),
    "New version. Same launch hash: adopted live. A launch change to an always-on runtime on a Relay-only node is refused.",
    ["runtime_update"],
  ),
  delete: mutation(
    "agent",
    z.object({ runtimeId: idSchema, confirm: confirmDeleteSchema.optional() }).strict(),
    z.object({ deleted: z.literal(true), removedMembers: z.array(idSchema) }).strict(),
    "Delete a runtime (refused while instances run, or while a profile pins it). Removes its pool members.",
    ["runtime_delete"],
  ),
  start: mutation(
    "agent",
    z
      .object({
        runtimeId: idSchema,
        versionId: idSchema.optional(),
        nodeIds: z.array(idSchema).min(1).max(64).optional(),
        count: z.number().int().min(1).max(64).optional(),
        /** Restart this instance (same as `restart`). */
        instanceId: idSchema.optional(),
        preview: z.boolean().optional(),
        fingerprint: sha256Schema.optional(),
      })
      .strict()
      .refine((input) => !(input.nodeIds && input.count), {
        message: "Give nodeIds or count, not both.",
      }),
    previewOrOperationSchema,
    "Start (or preview) instances; may stop others to make room. Agents: refused on Relay-only nodes.",
    ["runtime_start"],
  ),
  stop: mutation(
    "agent",
    z.union([
      z.object({ instanceId: idSchema }).strict(),
      z.object({ runtimeId: idSchema, nodeId: idSchema.optional() }).strict(),
    ]),
    operationViewSchema,
    "Stop instances. Agents: refused on Relay-only nodes.",
    ["runtime_stop"],
  ),
  restart: mutation(
    "agent",
    z
      .object({
        instanceId: idSchema,
        preview: z.boolean().optional(),
        fingerprint: sha256Schema.optional(),
      })
      .strict(),
    previewOrOperationSchema,
    "Restart an instance (resets its restart window). Agents: Full-control nodes only.",
    ["runtime_start"],
  ),
  instances: {
    forget: mutation(
      "human",
      z.object({ instanceId: idSchema, nodeNumber: z.number().int().min(1).optional() }).strict(),
      instanceViewSchema,
      "Forget a stop that cannot be proven: resources stay counted until a probe proves the stop.",
    ),
  },
  models: {
    setCapabilities: mutation(
      "agent",
      z
        .object({
          runtimeModelId: idSchema,
          /** null: use the detected capabilities again. */
          capabilities: z.array(z.enum(MODEL_CAPABILITY)).nullable(),
          note: noteSchema.optional(),
        })
        .strict(),
      runtimeModelViewSchema,
      "Override a served model's capabilities.",
      ["runtime_update"],
    ),
  },
  detected: {
    add: mutation(
      "session",
      z
        .object({
          nodeId: idSchema,
          baseUrl: z.string().url().max(2_048),
          slug: runtimeSlugSchema.optional(),
          name: nameSchema.optional(),
        })
        .strict(),
      runtimeSummarySchema,
      "Add a detected local server as an always-on runtime (agents use runtime_create preset detected).",
    ),
  },
  shares: {
    list: query(
      "session",
      z.object({ runtimeId: idSchema.optional() }).strict(),
      z
        .object({
          sharedByMe: z.array(
            z
              .object({
                id: idSchema,
                runtimeId: idSchema,
                email: z.string(),
                createdAt: isoDateSchema,
              })
              .strict(),
          ),
          sharedWithMe: z.array(
            z
              .object({
                id: idSchema,
                runtimeId: idSchema,
                ownerEmail: z.string(),
                name: z.string(),
                currentVersion: runtimeVersionSummarySchema,
              })
              .strict(),
          ),
        })
        .strict(),
      "Runtime definitions you share and that are shared with you.",
    ),
    create: mutation(
      "human",
      z.object({ runtimeId: idSchema, email: emailSchema }).strict(),
      z.object({ id: idSchema }).strict(),
      "Share a runtime definition (read-only, all versions).",
    ),
    delete: mutation(
      "human",
      z.object({ shareId: idSchema }).strict(),
      okSchema,
      "Stop sharing a runtime definition (forks stay).",
    ),
  },
  fork: mutation(
    "human",
    z
      .object({
        runtimeId: idSchema,
        versionId: idSchema.optional(),
        slug: runtimeSlugSchema,
        name: nameSchema,
        nodeId: idSchema.optional(),
      })
      .strict(),
    runtimeSummarySchema,
    "Copy a shared definition into your own runtime.",
  ),
} as const;
