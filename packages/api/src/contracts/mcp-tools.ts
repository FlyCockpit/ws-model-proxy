/**
 * The 0.4.0 MCP tool manifest (spec §6): 28 tools, user nouns, no implementations.
 * `apps/server/src/mcp/tools.ts` registers these; handlers call the procedures named in
 * `procedures`. READ tokens see the read tools; FULL tokens see all. Most writes take an
 * optional `note`. Refusals carry `data.reason` with a message that says what to do next.
 *
 * Token budget (owner guidance): descriptions are 1–3 short sentences (what it does plus the
 * one rule an agent must know); long guidance lives in docs/mcp.md and in refusal messages.
 * Large nested inputs (runtime definitions, pool advanced settings, hardware, metric commands)
 * are advertised compactly (`compactFields`: their JSON type only — object, list or null) and
 * validated in full by the procedure;
 * `contracts.test.ts` fails when `tools/list` grows past its budget.
 */
import { z } from "zod";
import { nodeSecretNameSchema } from "../lib/runtime-spec";
import { activityContract } from "./activity";
import { confirmDeleteSchema, idSchema, MODEL_CAPABILITY, noteSchema, okSchema } from "./common";
import { modelsContract } from "./models";
import {
  nodeDetailSchema,
  nodeFileEditInputSchema,
  nodeFileMutationOutputSchema,
  nodeFileReadInputSchema,
  nodeFileReadOutputSchema,
  nodeFileWriteInputSchema,
  nodeListRowSchema,
  nodesContract,
} from "./nodes";
import { modelAliasNameSchema, poolsContract, poolViewSchema } from "./pools";
import { profilesContract, profileViewSchema } from "./profiles";
import { providersContract } from "./providers";
import {
  runtimeDetailSchema,
  runtimeModelViewSchema,
  runtimeSummarySchema,
  runtimesContract,
  runtimeVersionDetailSchema,
  runtimeVersionSummarySchema,
} from "./runtimes";
import { MCP_READ_TOOLS, type McpToolName } from "./tool-names";

export type McpToolContract = {
  name: McpToolName;
  level: "READ" | "FULL";
  /** Shown to the agent: 1–3 short sentences, the user's nouns. */
  description: string;
  input: z.ZodType;
  output: z.ZodType;
  /** Procedure paths (`router.sub.name`) the handler calls. */
  procedures: readonly string[];
  /**
   * Top-level input fields advertised as a plain object with this description instead of their
   * full JSON Schema (the procedure still validates them in full and its refusal names the
   * path). Keeps `tools/list` small.
   */
  compactFields?: Readonly<Record<string, string>>;
  /**
   * The input carries a secret value: the server never logs, audits or echoes it (errors name
   * the field, never its value).
   */
  sensitiveInput?: boolean;
  /** Calls per minute per token, when stricter than the MCP default. */
  rateLimit?: {
    perMinute: number;
    key: "start_stop_apply" | "node_command" | "bench";
    /** Counted only for calls that set this input field (model_test: bench runs only). */
    onlyWhen?: "bench";
  };
};

function tool(contract: Omit<McpToolContract, "level">): McpToolContract {
  return {
    ...contract,
    level: (MCP_READ_TOOLS as readonly string[]).includes(contract.name) ? "READ" : "FULL",
  };
}

type JsonSchema = Record<string, unknown>;

/** The JSON types a full field schema allows (`anyOf` branches flattened). */
function jsonTypes(schema: JsonSchema): string[] {
  if (typeof schema.type === "string") return [schema.type];
  if (Array.isArray(schema.type)) return schema.type.filter((t) => typeof t === "string");
  const branches = Array.isArray(schema.anyOf) ? (schema.anyOf as JsonSchema[]) : [];
  return branches.flatMap(jsonTypes);
}

/**
 * A compact field: a plain object, or a list of objects when the field is a list, with
 * `null` kept when the field takes it (so the shape an agent sends matches the procedure).
 */
function compactField(full: JsonSchema, description: string): JsonSchema {
  const types = jsonTypes(full);
  const base: JsonSchema = types.includes("array")
    ? { type: "array", items: { type: "object" } }
    : { type: "object" };
  if (types.includes("null")) base.type = [base.type, "null"];
  return { ...base, description };
}

/** The `inputSchema` a tool advertises in `tools/list` (compact fields replaced). */
export function advertisedInputSchema(contract: McpToolContract): JsonSchema {
  const schema = z.toJSONSchema(contract.input, { io: "input" }) as JsonSchema;
  delete schema.$schema;
  const properties = schema.properties as Record<string, JsonSchema> | undefined;
  for (const [field, description] of Object.entries(contract.compactFields ?? {})) {
    const full = properties?.[field];
    if (properties && full) properties[field] = compactField(full, description);
  }
  return schema;
}

/** What `tools/list` returns for these tools (the budget test measures it). */
export function advertisedToolList(): Array<{
  name: string;
  description: string;
  inputSchema: JsonSchema;
}> {
  return MCP_TOOLS.map((contract) => ({
    name: contract.name,
    description: contract.description,
    inputSchema: advertisedInputSchema(contract),
  }));
}

const SPEC = "Runtime definition; shape in docs/mcp.md, start from runtimes_get presets.";
const LIMITS = "Limit overrides (null: automatic); runtimes_get shows effective values.";
const ADVANCED = "Advanced settings by key; pools_get / runtimes_get show keys and defaults.";
const COMPAT = "Request compatibility (replaces; null: automatic); shape in docs/mcp.md.";

const runtimeCreateInput = z
  .object({
    slug: z.string(),
    name: z.string(),
    kind: z.enum(["ALWAYS_ON", "STARTABLE"]).optional(),
    nodeId: idSchema.optional(),
    preset: z.string().optional(),
    spec: z.record(z.string(), z.unknown()).optional(),
    limits: z.record(z.string(), z.unknown()).optional(),
    advanced: z.record(z.string(), z.unknown()).optional(),
    compat: z.record(z.string(), z.unknown()).nullable().optional(),
    /** Copy a definition shared with you instead of giving spec. */
    forkFrom: z.object({ runtimeId: idSchema, versionId: idSchema.optional() }).strict().optional(),
    note: noteSchema.optional(),
  })
  .strict()
  .refine((input) => (input.forkFrom === undefined) === (input.spec !== undefined), {
    message: "Give spec, or forkFrom to copy a shared definition.",
  });

/** runtimes.stop, or (markStopped) runtimes.instances.markStopped: one flat object keeps tools/list small. */
const runtimeStopInput = z
  .object({
    instanceId: idSchema.optional(),
    runtimeId: idSchema.optional(),
    nodeId: idSchema.optional(),
    markStopped: z.literal(true).optional(),
    /** markStopped: only this node of a multi-node instance (1-based). */
    nodeNumber: z.number().int().min(1).optional(),
    confirm: z.literal("MARK_STOPPED").optional(),
    note: noteSchema.optional(),
  })
  .strict()
  .refine((input) => (input.instanceId === undefined) !== (input.runtimeId === undefined), {
    message: "Give instanceId or runtimeId.",
  })
  .refine(
    (input) =>
      input.markStopped
        ? input.instanceId !== undefined && input.confirm === "MARK_STOPPED" && !input.nodeId
        : input.confirm === undefined &&
          input.nodeNumber === undefined &&
          input.note === undefined &&
          (input.instanceId === undefined || input.nodeId === undefined),
    { message: 'markStopped takes instanceId and confirm "MARK_STOPPED"; a stop takes neither.' },
  );

const runtimeUpdateInput = z
  .object({
    runtimeId: idSchema,
    name: z.string().optional(),
    spec: z.record(z.string(), z.unknown()).optional(),
    limits: z.record(z.string(), z.unknown()).optional(),
    advanced: z.record(z.string(), z.unknown()).optional(),
    compat: z.record(z.string(), z.unknown()).nullable().optional(),
    relearn: z.boolean().optional(),
    restartRunning: z.boolean().optional(),
    /** Per served model; null: what the node detected. */
    modelCapabilities: z
      .array(
        z
          .object({
            runtimeModelId: idSchema,
            capabilities: z.array(z.enum(MODEL_CAPABILITY)).nullable(),
          })
          .strict(),
      )
      .max(64)
      .optional(),
    note: noteSchema.optional(),
  })
  .strict();

const poolUpdateInput = z
  .object({
    poolId: idSchema,
    name: z.string().optional(),
    slug: z.string().optional(),
    description: z.string().nullable().optional(),
    members: z.record(z.string(), z.unknown()).optional(),
    cloudMembers: z
      .array(z.object({ providerModelId: idSchema }).strict())
      .max(16)
      .optional(),
    routing: z.record(z.string(), z.unknown()).optional(),
    cloud: z.record(z.string(), z.unknown()).optional(),
    sidecars: z.array(z.record(z.string(), z.unknown())).max(3).optional(),
    advanced: z.record(z.string(), z.unknown()).optional(),
    /** Your model-name aliases for this pool (your namespace; any pool you can use). */
    aliases: z
      .object({
        set: z
          .array(
            z
              .object({ name: modelAliasNameSchema, apiKeyId: idSchema.nullable().optional() })
              .strict(),
          )
          .max(16)
          .optional(),
        remove: z.array(idSchema).max(16).optional(),
      })
      .strict()
      .optional(),
    /** In a pool shared with you (can contribute): add or withdraw YOUR served models. */
    contribute: z
      .object({
        add: z.array(idSchema).max(16).optional(),
        withdraw: z.array(idSchema).max(16).optional(),
      })
      .strict()
      .optional(),
    note: noteSchema.optional(),
  })
  .strict();

export const MCP_TOOLS: readonly McpToolContract[] = [
  tool({
    name: "nodes_get",
    description:
      "Your nodes, or one in detail: trust, hardware, fabrics, hold, held definitions (versions frozen on a Relay-only node), instances, found local servers, secret names.",
    input: z.object({ nodeId: idSchema.optional() }).strict(),
    output: z.union([z.object({ nodes: z.array(nodeListRowSchema) }).strict(), nodeDetailSchema]),
    procedures: ["nodes.list", "nodes.get"],
  }),
  tool({
    name: "runtimes_get",
    description:
      "Your runtimes, or one in detail (versions: the version list; versionId: one full definition; presets: starting points; shared: definitions shared with you).",
    input: z
      .object({
        runtimeId: idSchema.optional(),
        versions: z.boolean().optional(),
        versionId: idSchema.optional(),
        presets: z.boolean().optional(),
        shared: z.boolean().optional(),
      })
      .strict(),
    output: z.union([
      z.object({ runtimes: z.array(runtimeSummarySchema) }).strict(),
      runtimeVersionDetailSchema,
      runtimeDetailSchema
        .extend({ versions: z.array(runtimeVersionSummarySchema).optional() })
        .strict(),
      runtimesContract.presets.list.output,
      runtimesContract.shares.list.output,
    ]),
    procedures: [
      "runtimes.list",
      "runtimes.get",
      "runtimes.versions.list",
      "runtimes.versions.get",
      "runtimes.presets.list",
      "runtimes.shares.list",
    ],
  }),
  tool({
    name: "pools_get",
    description:
      "Your pools and pools shared with you, or one pool (history: its change log; aliases: your model-name aliases).",
    input: z
      .object({
        poolId: idSchema.optional(),
        history: z.boolean().optional(),
        aliases: z.boolean().optional(),
      })
      .strict(),
    output: z.union([
      poolsContract.list.output,
      poolViewSchema.extend({ history: poolsContract.history.list.output.optional() }).strict(),
      poolsContract.aliases.list.output,
    ]),
    procedures: ["pools.list", "pools.get", "pools.history.list", "pools.aliases.list"],
  }),
  tool({
    name: "profiles_get",
    description:
      "Your profiles, or one: owned nodes, hold lines, pinned versions, satisfied now (pinned versions running).",
    input: z.object({ profileId: idSchema.optional() }).strict(),
    output: z.union([profilesContract.list.output, profileViewSchema]),
    procedures: ["profiles.list", "profiles.get"],
  }),
  tool({
    name: "providers_get",
    description:
      "Cloud provider accounts and models with this month's spend (never keys). Only people change providers.",
    input: z.object({}).strict(),
    output: z
      .object({
        accounts: providersContract.accounts.list.output.shape.accounts,
        models: providersContract.models.list.output.shape.models,
      })
      .strict(),
    procedures: ["providers.accounts.list", "providers.models.list"],
  }),
  tool({
    name: "requests_list",
    description:
      "Recent requests without prompts: route, what served them, timings, tokens, errors.",
    input: activityContract.requests.list.input,
    output: activityContract.requests.list.output,
    procedures: ["activity.requests.list"],
  }),
  tool({
    name: "metrics_query",
    description:
      "Request, engine-load and node metrics for a pool, runtime, version, node or instance over a range, optionally grouped; point time = start + at×step. Use it to compare versions after a change. Tests (model_test, Test page) are left out (totals.tests counts them) unless includeTests; a runtime test counts on the runtime, not its pools.",
    input: activityContract.metrics.query.input,
    output: activityContract.metrics.query.output,
    procedures: ["activity.metrics.query"],
  }),
  tool({
    name: "model_test",
    description:
      "Send a test to a callable ID (not :external) or one of your runtimes and see what served it and how fast; bench repeats it on your own pools and runtimes.",
    input: modelsContract.test.input,
    output: modelsContract.test.output,
    procedures: ["models.test"],
    rateLimit: { perMinute: 2, key: "bench", onlyWhen: "bench" },
  }),
  tool({
    name: "pool_create",
    description:
      "Create a pool from your served models. Cloud fallback stays off until a person turns it on.",
    input: poolsContract.create.input,
    output: poolsContract.create.output,
    procedures: ["pools.create"],
    compactFields: {
      advanced: ADVANCED,
      routing: "Priority class, pool cap, kept slots, borrowing.",
    },
  }),
  tool({
    name: "pool_update",
    description:
      "Change a pool you own, contribute/withdraw your own served models in a pool shared with you (can contribute), or set your model-name aliases for any pool you can use. People only: cloud mode, paid warm protection, own-key consent, only-my-own-hardware.",
    input: poolUpdateInput,
    output: poolsContract.update.output,
    procedures: [
      "pools.update",
      "pools.members.addContributed",
      "pools.members.removeContributed",
      "pools.aliases.set",
      "pools.aliases.delete",
    ],
    compactFields: {
      members: "{add: [{runtimeModelId}], remove: [memberId], set: [{memberId, weight, state}]}.",
      aliases: "{set: [{name, apiKeyId?}], remove: [aliasId]}; names like gpt-4o.",
      routing: "Priority class, pool cap, kept slots, borrowing.",
      cloud: "{embeddingContract}.",
      advanced: ADVANCED,
    },
  }),
  tool({
    name: "pool_delete",
    description:
      'Delete a pool with its shares, contributed members, API-key entries and sidecar links. confirm: "DELETE".',
    input: z.object({ poolId: idSchema, confirm: confirmDeleteSchema }).strict(),
    output: okSchema,
    procedures: ["pools.delete"],
  }),
  tool({
    name: "runtime_create",
    description:
      "Define a runtime (a server on a node, or commands that start one), or copy one shared with you (forkFrom). Put model downloads and other setup in an idempotent prepare step so applying a profile on a fresh node fetches weights by itself.",
    input: runtimeCreateInput,
    output: runtimesContract.create.output,
    procedures: ["runtimes.create", "runtimes.presets.list", "runtimes.fork"],
    compactFields: { spec: SPEC, limits: LIMITS, advanced: ADVANCED, compat: COMPAT },
  }),
  tool({
    name: "runtime_update",
    description:
      "Save a new version (say why in note); limit edits apply live, a changed definition needs restartRunning. Setup such as model downloads belongs in the idempotent prepare step.",
    input: runtimeUpdateInput,
    output: runtimesContract.update.output.extend({
      models: z.array(runtimeModelViewSchema).optional(),
    }),
    procedures: ["runtimes.update", "runtimes.models.setCapabilities"],
    compactFields: { spec: SPEC, limits: LIMITS, advanced: ADVANCED, compat: COMPAT },
  }),
  tool({
    name: "runtime_delete",
    description: 'Delete a runtime that no instance runs and no profile pins. confirm: "DELETE".',
    input: z.object({ runtimeId: idSchema, confirm: confirmDeleteSchema }).strict(),
    output: runtimesContract.delete.output,
    procedures: ["runtimes.delete"],
  }),
  tool({
    name: "runtime_start",
    description:
      "Start a startable runtime on nodes (or count instances placed for you), or restart an instance; preview shows placements and what stops. Refused on Relay-only and held nodes.",
    input: runtimesContract.start.input,
    output: runtimesContract.start.output,
    procedures: ["runtimes.start"],
    rateLimit: { perMinute: 10, key: "start_stop_apply" },
  }),
  tool({
    name: "runtime_stop",
    description:
      'Stop an instance, or every instance of a runtime (optionally on one node). markStopped with confirm "MARK_STOPPED" marks stopped an instance whose stop its node cannot prove (Full-control nodes).',
    input: runtimeStopInput,
    output: z.union([runtimesContract.stop.output, runtimesContract.instances.markStopped.output]),
    procedures: ["runtimes.stop", "runtimes.instances.markStopped"],
    rateLimit: { perMinute: 10, key: "start_stop_apply" },
  }),
  tool({
    name: "profile_save",
    description:
      "Create or replace a profile: owned nodes and pinned runtime versions. Hold lines are for people.",
    input: profilesContract.save.input,
    output: profilesContract.save.output,
    procedures: ["profiles.save"],
  }),
  tool({
    name: "profile_apply",
    description:
      "Apply a profile (preview first if unsure): start its pins, stop other startable runtimes on its nodes. Refused if any owned node is Relay only.",
    input: profilesContract.apply.input,
    output: profilesContract.apply.output,
    procedures: ["profiles.apply"],
    rateLimit: { perMinute: 10, key: "start_stop_apply" },
  }),
  tool({
    name: "profile_delete",
    description: 'Delete a profile; nothing stops. confirm: "DELETE".',
    input: z.object({ profileId: idSchema, confirm: confirmDeleteSchema }).strict(),
    output: okSchema,
    procedures: ["profiles.delete"],
  }),
  tool({
    name: "node_update",
    description:
      "Change a Full-control node: labels, ports, hardware, metric commands, fabrics, command lifetime, rescan.",
    input: nodesContract.update.input,
    output: nodesContract.update.output,
    procedures: ["nodes.update"],
    compactFields: {
      hardware: "Declared hardware (null clears); nodes_get shows sources.",
      metricCommands: "Node metric commands; shape in docs/mcp.md.",
    },
  }),
  tool({
    name: "node_delete",
    description:
      'Delete an offline node (refused while online: node_online): its always-on runtimes go, instances with a part there stop. confirm: "DELETE".',
    input: nodesContract.deleteOffline.input,
    output: nodesContract.deleteOffline.output,
    procedures: ["nodes.deleteOffline"],
  }),
  tool({
    name: "node_secret_set",
    description:
      "Set (or with value null delete) a WSMP_SECRET_* on a Full-control node, for runtimes to reference by name. Write-only: never shown again.",
    input: z
      .object({
        nodeId: idSchema,
        name: nodeSecretNameSchema,
        value: z.string().nullable(),
        note: noteSchema.optional(),
      })
      .strict(),
    output: z.object({ name: z.string(), deleted: z.boolean() }).strict(),
    procedures: ["nodes.secrets.set", "nodes.secrets.delete"],
    /** The whole input is sensitive: never logged, audited or echoed in errors. */
    sensitiveInput: true,
  }),
  tool({
    name: "node_command_run",
    description:
      'Run a one-off command (downloads while experimenting, builds, diagnostics, benchmarks) on a Full-control node; answers within ~15 s, then poll with node_command_get. Anything that should keep running or serve traffic must be a runtime: a server started here is invisible to the proxy and dies with the command. confirm: "RUN".',
    input: nodesContract.commands.run.input,
    output: nodesContract.commands.run.output,
    procedures: ["nodes.commands.run"],
    rateLimit: { perMinute: 30, key: "node_command" },
  }),
  tool({
    name: "node_command_get",
    description:
      "State and output tail of a command from node_command_run (or the state of one from node_command_queue_for_user); waitMs waits for it, cancel stops it and everything it started.",
    input: nodesContract.commands.get.input,
    output: nodesContract.commands.get.output,
    procedures: ["nodes.commands.get"],
  }),
  tool({
    name: "node_command_queue_for_user",
    description:
      "Queue a command a person must run (e.g. it needs their sudo password); it runs only when they press Run and Enter.",
    input: nodesContract.queued.enqueue.input,
    output: nodesContract.queued.enqueue.output,
    procedures: ["nodes.queued.enqueue"],
    rateLimit: { perMinute: 30, key: "node_command" },
  }),
  tool({
    name: "node_file_read",
    description: "Read, stat, list or search under the node's allowed folders; returns an etag.",
    input: nodeFileReadInputSchema,
    output: nodeFileReadOutputSchema,
    procedures: ["nodes.files.read"],
  }),
  tool({
    name: "node_file_write",
    description:
      "Write, mkdir, rename or delete under the node's allowed folders (ifMatch: the etag you read).",
    input: nodeFileWriteInputSchema,
    output: nodeFileMutationOutputSchema,
    procedures: ["nodes.files.write"],
  }),
  tool({
    name: "node_file_edit",
    description:
      "Replace exact text in a file (ifMatch required); returns the new etag and a diff.",
    input: nodeFileEditInputSchema,
    output: nodeFileMutationOutputSchema,
    procedures: ["nodes.files.edit"],
  }),
];

/**
 * Procedures deliberately not on MCP, with the reason (the coverage doc and the manifest test
 * read this). Every `human`/`human_admin`/`admin`/`public` procedure is excluded implicitly.
 */
export const MCP_EXCLUDED_SESSION_PROCEDURES: Readonly<Record<string, string>> = {
  "nodes.enrollmentCodes.list": "Enrollment is a person's approval; agents never see codes.",
  "nodes.credentials.list": "Credentials are managed by people.",
  "nodes.activity.list": "Audit history for people (agents see their own results).",
  "nodes.queued.list": "Queued items are shown in nodes_get.",
  "nodes.fabrics.list": "nodes_get shows each node's fabrics and peers.",
  "runtimes.detected.add": "Agents use runtime_create with preset detected.",
  "models.list": "Callable IDs are part of pools_get.",
  "models.testTargets": "The web Test page's picker; agents name targets in model_test.",
  "access.apiKeys.list": "API keys are managed by people.",
  "access.agentTokens.list": "Agent tokens are managed by people.",
  "access.oauthGrants.list": "Agent connections are managed by people.",
  "access.shares.list": "Sharing is for people only; pools_get shows the count.",
  "access.contributing.pools":
    "pools_get lists pools shared with you and whether you may contribute.",
  "providers.accounts.get": "providers_get covers accounts and models.",
  "providers.pricing.list": "providers_get shows the active price.",
  "providers.catalog.search": "Adding provider models is for people only.",
  "providers.usage.list": "Spend details are for people; providers_get shows the month's total.",
  "providers.attempts.list": "Use requests_list (cloud attempts are requests with route cloud).",
  "activity.overview.summary": "Use metrics_query.",
  "activity.needsYou.list": "Needs-you items are in runtimes_get (instances) and nodes_get.",
  "activity.needsYou.count": "The web nav badge; agents read needs in runtimes_get and nodes_get.",
  "activity.commands.list": "Agents follow their own commands with node_command_get.",
  "settings.get": "Account settings are for people.",
  "app.flags": "Web app switches.",
  "auth.updateLocale": "Web app plumbing.",
  "auth.passwordCapabilities": "Web app plumbing.",
};
