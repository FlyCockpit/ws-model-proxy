import { z } from "zod";
import { NODE_LOCAL_PLACEHOLDERS } from "../lib/command-render";
import { COMPAT_ENDPOINTS, requestCompatSchema } from "../lib/request-compat";
import { RUNTIME_SPEC_WARNINGS, runtimeSpecSchema } from "../lib/runtime-spec";
import { shareInviteViewSchema } from "./access";
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
  NODE_CONNECTION,
  nameSchema,
  noInputSchema,
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
import { refusalReasonSchema, refusalSchema } from "./refusals";

/** Built-in starting points (`packages/api/src/lib/runtime-presets.ts`, typed by the runtime spec). */
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
    /** The node's connection and since when (its last connect or disconnect); null if deleted. */
    nodeConnection: z
      .object({ state: z.enum(NODE_CONNECTION), since: isoDateSchema.nullable() })
      .strict()
      .nullable(),
    /**
     * The rank's last automatic stop check (status probe) that finished, while the instance is
     * STOPPING or the rank is still held after it was marked stopped (HELD_UNKNOWN, also on a
     * STOPPED instance): `proven` false means the node could not confirm the process is gone,
     * and `errorCode` says why (`port_in_use`, `process_alive`, `process_unknown`, `status_running`,
     * `status_unknown`, `unowned_service`; `not_stopped` from older nodes). Null when none ran.
     */
    lastStopCheck: z
      .object({ at: isoDateSchema, proven: z.boolean(), errorCode: z.string().nullable() })
      .strict()
      .nullable(),
  })
  .strict();

/**
 * An interactive step's command as the node will render it (`lib/command-render.ts`, mirroring
 * `render.rs`). `ready`: the text that runs, except the `nodeFills` placeholders, which stay
 * `{{name}}` because only the node knows them. `refused`: the node refuses the job with this
 * field and nothing runs. `unavailable`: the server cannot render it faithfully (the step's
 * intent is unreadable, it names another launch hash than the instance's spec, or the head's
 * fabric address is unknown, or a literal `{{fabric_*}}` would look like one the node fills) and
 * shows no rendered text rather than a wrong one.
 */
export const renderedStepCommandSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("ready"),
      text: z.string(),
      nodeFills: z.array(z.enum(NODE_LOCAL_PLACEHOLDERS)),
    })
    .strict(),
  z.object({ state: z.literal("refused"), field: z.string() }).strict(),
  z
    .object({
      state: z.literal("unavailable"),
      reason: z.enum(["intent", "version", "head_addr", "node_fill_ambiguous"]),
    })
    .strict(),
]);

export const instanceStepViewSchema = z
  .object({
    id: idSchema,
    nodeNumber: z.number().int().min(1),
    phase: z.enum(STEP_PHASE),
    state: z.enum(STEP_STATE),
    attempts: z.number().int(),
    errorCode: z.string().nullable(),
    /** A person runs this step in an operator terminal. */
    interactive: z.boolean(),
    /**
     * The command template the step runs (from the launched version, placeholders unrendered) and
     * who wrote it, so a person can judge it before typing a sudo password. Terminal ids are never
     * in a view (agents read this through runtimes_get); people attach by step id. Null too when
     * the step names another spec than the instance's (its text here would not be what runs).
     */
    command: z.string().nullable(),
    commandAuthor: z.enum(["user", "agent", "unknown"]).nullable(),
    /** Interactive steps only (null otherwise): the command with its placeholder values. */
    rendered: renderedStepCommandSchema.nullable(),
    /** The head node's fabric address the job sends as `{{head_addr}}` (multi-node only). */
    headAddr: z.string().nullable(),
    terminalOpen: z.boolean(),
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
    /** Request compatibility ({} = automatic). */
    compat: requestCompatSchema,
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
    /** Null for a service (no models, never proxied). */
    modelType: z.enum(MODEL_TYPE).nullable(),
    service: z.boolean(),
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

/**
 * What the current launch's engine accepts, as learned: `described` lists the endpoints its
 * OpenAPI description covers; `learned` the fixes learned from its 400s (`endpoint op path`).
 */
export const requestProfileViewSchema = z
  .object({
    source: z.enum(["LEARNED", "OPENAPI", "CATALOG"]),
    engine: z.string().nullable(),
    probedAt: isoDateSchema.nullable(),
    described: z.array(z.enum(COMPAT_ENDPOINTS)),
    learned: z.array(z.string()),
    stripHeaders: z.array(z.string()),
  })
  .strict();

export const runtimeDetailSchema = runtimeSummarySchema
  .extend({
    current: runtimeVersionDetailSchema,
    /** Null until the engine was described or answered a request. */
    requestProfile: requestProfileViewSchema.nullable(),
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

/** A share of your runtime definition. */
export const runtimeShareViewSchema = z
  .object({ id: idSchema, runtimeId: idSchema, email: z.string(), createdAt: isoDateSchema })
  .strict();

// ── Previews and operations ──

export const placementSchema = z
  .object({
    nodeId: idSchema,
    nodeSlug: z.string(),
    nodeNumber: z.number().int().min(1),
    port: z.number().int(),
    /** This node's IP on the instance's fabric (`{{fabric_ip}}`); null for single-node. */
    fabricIp: z.string().nullable(),
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
      "binds_all_interfaces",
      /** A start waits for an instance that was already stopping to release its claims. */
      "waits_for_stop",
    ]),
    nodeId: idSchema.nullable(),
    detail: z.string(),
  })
  .strict();

/**
 * A hold change a profile apply makes (`planProfileHolds`). Part of what a person confirms:
 * the fingerprint covers it. Empty for a plain runtime start.
 */
export const previewHoldChangeSchema = z
  .object({
    nodeId: idSchema,
    change: z.enum(["hold", "release", "keep"]),
    /** Who holds it now (before the apply); null when it is not held. */
    heldBy: z.enum(["this_profile", "person", "other_profile"]).nullable(),
    note: z.string().nullable(),
  })
  .strict();

export const startPreviewSchema = z
  .object({
    /**
     * `previewFingerprint` of everything else in the preview (lib/preview-fingerprint.ts):
     * echo it back to apply exactly this preview (people); agents may omit it.
     */
    fingerprint: sha256Schema,
    starts: z.array(
      z
        .object({
          runtimeId: idSchema,
          versionId: idSchema,
          instanceId: idSchema.nullable(),
          placements: z.array(placementSchema),
          /** Multi-node: the one fabric every rank shares, with the head's IP (`head_addr`). */
          fabric: z
            .object({ fabricId: idSchema, name: z.string(), headAddr: z.string() })
            .strict()
            .nullable(),
          /** Multi-node: `{{dist_port}}`, one port free on every rank's node. */
          distPort: z.number().int().nullable(),
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
    /** Node holds this apply sets, releases or leaves (profiles only). */
    holds: z.array(previewHoldChangeSchema),
    warnings: z.array(previewWarningSchema),
    /** Why it cannot run (e.g. trust_relay for an agent, definition_frozen, no_shared_fabric, node_held). */
    refusals: z.array(refusalSchema),
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
/** Replaces the whole setting; null returns it to automatic. */
const compatInput = requestCompatSchema.nullable().optional();

// ── Procedures ──

/** What creating a runtime returns, from a spec or a fork. */
export const runtimeCreateOutputSchema = z
  .object({
    runtime: runtimeSummarySchema,
    version: runtimeVersionSummarySchema,
    define: z.array(defineResultSchema),
    warnings: z.array(z.enum(RUNTIME_SPEC_WARNINGS)),
  })
  .strict();

export const runtimesContract = {
  list: query(
    "agent",
    noInputSchema,
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
      noInputSchema,
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
        /**
         * The built-in starting point the spec came from (from presets.list). Recorded and shown
         * only; `spec` is always complete and is what gets validated.
         */
        preset: z.enum(RUNTIME_PRESETS).optional(),
        spec: runtimeSpecSchema,
        limits: limitsInput,
        advanced: advancedInput,
        compat: compatInput,
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
    runtimeCreateOutputSchema,
    "Create a runtime (version 1) and push it to the nodes that need it. Warns (never refuses) when it binds 0.0.0.0 or ::.",
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
        compat: compatInput,
        /** Forget what was learned about the engine's requests; it is learned again. */
        relearn: z.boolean().optional(),
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
              reason: refusalReasonSchema.extract([
                "launch_changed",
                "trust_relay",
                "interactive_needs_person",
              ]),
            })
            .strict(),
        ),
        restarted: z.array(idSchema),
        define: z.array(defineResultSchema),
        warnings: z.array(z.enum(RUNTIME_SPEC_WARNINGS)),
      })
      .strict(),
    "New version. Same launch hash: adopted live. A launch change to an always-on runtime on a Relay-only node is refused (launch_change_on_relay_only), on a node-origin runtime always (launch_change_on_node_origin). With MCP capability overrides, the overrides and the new version commit in one transaction or not at all.",
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
        /** Restart this instance (resets its restart window); the placement is its own. */
        instanceId: idSchema.optional(),
        preview: z.boolean().optional(),
        fingerprint: sha256Schema.optional(),
      })
      .strict()
      .refine((input) => !(input.nodeIds && input.count), {
        message: "Give nodeIds or count, not both.",
      }),
    previewOrOperationSchema,
    "Start, or restart with instanceId (or preview); may stop others to make room. People must echo the preview fingerprint (preview_required / preview_stale); agents may omit it and need no confirmation. Agents: refused on Relay-only nodes (trust_relay).",
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
  steps: {
    /** Open (or rejoin) the operator terminal of an interactive step; works on Relay-only nodes. */
    attach: mutation(
      "human",
      z
        .object({
          stepId: idSchema,
          cols: z.number().int().min(1).max(1_000),
          rows: z.number().int().min(1).max(1_000),
        })
        .strict(),
      z
        .object({
          step: instanceStepViewSchema,
          ticket: z.string(),
          terminalId: z.string(),
          expiresAt: isoDateSchema,
        })
        .strict(),
      "Attach to the operator terminal of a step waiting for you.",
    ),
    reopen: mutation(
      "human",
      z.object({ stepId: idSchema }).strict(),
      instanceStepViewSchema,
      "Run an interactive step's command again in a fresh terminal (after it closed without success).",
    ),
    cancel: mutation(
      "human",
      z.object({ stepId: idSchema }).strict(),
      instanceStepViewSchema,
      "Give up on an interactive step: it fails and the instance follows its stop/restart rules.",
    ),
  },
  instances: {
    markStopped: mutation(
      "agent",
      z
        .object({
          instanceId: idSchema,
          nodeNumber: z.number().int().min(1).optional(),
          /** Agents repeat it (recovery, like node_delete); people confirm in a dialog. */
          confirm: z.literal("MARK_STOPPED").optional(),
          note: noteSchema.optional(),
        })
        .strict(),
      instanceViewSchema,
      "Mark stopped an instance whose stop cannot be proven: resources stay counted until a probe proves the stop. Agents: Full-control nodes only (trust_relay), with confirm MARK_STOPPED; audited on the node.",
      ["runtime_stop"],
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
      "agent",
      z.object({ runtimeId: idSchema.optional() }).strict(),
      z
        .object({
          sharedByMe: z.array(runtimeShareViewSchema),
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
      ["runtimes_get"],
    ),
    create: mutation(
      "human",
      z.object({ runtimeId: idSchema, email: emailSchema }).strict(),
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("share"), share: runtimeShareViewSchema }).strict(),
        z
          .object({
            kind: z.literal("invite"),
            invite: shareInviteViewSchema,
            /** Shown once, only when no e-mail could be sent: copy it to the person. */
            link: z.string().nullable(),
          })
          .strict(),
      ]),
      "Share a runtime definition (read-only, all versions), as access.shares.create does a pool: directly only with an account whose mailbox was proved; any other e-mail (an unknown one included, answered alike) gets an invite that needs its link (access.invites resend/revoke).",
    ),
    delete: mutation(
      "human",
      z.object({ shareId: idSchema }).strict(),
      okSchema,
      "Stop sharing a runtime definition (forks stay).",
    ),
  },
  fork: mutation(
    "agent",
    z
      .object({
        runtimeId: idSchema,
        versionId: idSchema.optional(),
        slug: runtimeSlugSchema,
        name: nameSchema,
        nodeId: idSchema.optional(),
        /** Applied on top of the copied definition, exactly as on create. */
        limits: limitsInput,
        advanced: advancedInput,
        compat: compatInput,
        note: noteSchema.optional(),
      })
      .strict(),
    runtimeCreateOutputSchema,
    "Copy a definition shared with you into your own runtime (version 1; agents: onto your Full-control nodes). Takes limits, advanced and note like create.",
    ["runtime_create"],
  ),
} as const;
