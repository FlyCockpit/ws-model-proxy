/**
 * The 0.4.0 MCP tool manifest (spec §6): 27 tools, user nouns, no implementations.
 * `apps/server/src/mcp/tool-manifest.ts` registers these; handlers call the procedures named in
 * `procedures`. READ tokens see the read tools; FULL tokens see all. Every write takes an
 * optional `note`. Refusals carry `data.reason` with a message that says what to do next.
 *
 * Token budget (owner guidance): descriptions are 1–3 short sentences (what it does plus the
 * one rule an agent must know); long guidance lives in docs/mcp.md and in refusal messages.
 * Large nested inputs (runtime definitions, pool advanced settings, hardware, metric commands)
 * are advertised as plain objects (`compactFields`) and validated in full by the procedure;
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
  nodeSummarySchema,
  nodesContract,
} from "./nodes";
import { poolsContract, poolViewSchema } from "./pools";
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

/** The `inputSchema` a tool advertises in `tools/list` (compact fields replaced). */
export function advertisedInputSchema(contract: McpToolContract): JsonSchema {
  const schema = z.toJSONSchema(contract.input, { io: "input" }) as JsonSchema;
  delete schema.$schema;
  const properties = schema.properties as Record<string, JsonSchema> | undefined;
  for (const [field, description] of Object.entries(contract.compactFields ?? {}))
    if (properties?.[field]) properties[field] = { type: "object", description };
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
    /** Copy a definition shared with you instead of giving spec. */
    forkFrom: z.object({ runtimeId: idSchema, versionId: idSchema.optional() }).strict().optional(),
    note: noteSchema.optional(),
  })
  .strict()
  .refine((input) => (input.forkFrom === undefined) === (input.spec !== undefined), {
    message: "Give spec, or forkFrom to copy a shared definition.",
  });

const runtimeUpdateInput = z
  .object({
    runtimeId: idSchema,
    name: z.string().optional(),
    spec: z.record(z.string(), z.unknown()).optional(),
    limits: z.record(z.string(), z.unknown()).optional(),
    advanced: z.record(z.string(), z.unknown()).optional(),
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
      "Your nodes, or one in detail: trust, hardware, fabrics, hold, held definitions, instances, found local servers, secret names.",
    input: z.object({ nodeId: idSchema.optional() }).strict(),
    output: z.union([z.object({ nodes: z.array(nodeSummarySchema) }).strict(), nodeDetailSchema]),
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
    description: "Your pools and pools shared with you, or one pool (history: its change log).",
    input: z.object({ poolId: idSchema.optional(), history: z.boolean().optional() }).strict(),
    output: z.union([
      poolsContract.list.output,
      poolViewSchema.extend({ history: poolsContract.history.list.output.optional() }).strict(),
    ]),
    procedures: ["pools.list", "pools.get", "pools.history.list"],
  }),
  tool({
    name: "profiles_get",
    description: "Your profiles, or one: owned nodes, hold lines, pinned versions, satisfied now.",
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
      "Request, engine-load and node metrics for a pool, runtime, version, node or instance over a range, optionally grouped. Use it to compare versions after a change.",
    input: activityContract.metrics.query.input,
    output: activityContract.metrics.query.output,
    procedures: ["activity.metrics.query"],
  }),
  tool({
    name: "model_test",
    description:
      "Send a test to a callable ID or one of your runtimes and see what served it and how fast; bench repeats it (not against :external).",
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
      "Change a pool you own, or contribute/withdraw your own served models in a pool shared with you (can contribute). People only: cloud mode, paid warm protection, own-key consent, only-my-own-hardware.",
    input: poolUpdateInput,
    output: poolsContract.update.output,
    procedures: ["pools.update", "pools.members.addContributed", "pools.members.removeContributed"],
    compactFields: {
      members: "{add: [{runtimeModelId}], remove: [memberId], set: [{memberId, weight, state}]}.",
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
    compactFields: { spec: SPEC, limits: LIMITS, advanced: ADVANCED },
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
    compactFields: { spec: SPEC, limits: LIMITS, advanced: ADVANCED },
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
      "Start a runtime on nodes (or count instances placed for you), or restart an instance; preview shows placements and what stops. Refused on Relay-only and held nodes.",
    input: runtimesContract.start.input,
    output: runtimesContract.start.output,
    procedures: ["runtimes.start"],
    rateLimit: { perMinute: 10, key: "start_stop_apply" },
  }),
  tool({
    name: "runtime_stop",
    description: "Stop an instance, or every instance of a runtime (optionally on one node).",
    input: runtimesContract.stop.input,
    output: runtimesContract.stop.output,
    procedures: ["runtimes.stop"],
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
      "State and output tail of a command from node_command_run; waitMs waits for it, cancel stops it and everything it started.",
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
  "activity.commands.list": "Agents follow their own commands with node_command_get.",
  "settings.get": "Account settings are for people.",
  "app.flags": "Web app switches.",
  "auth.updateLocale": "Web app plumbing.",
  "auth.passwordCapabilities": "Web app plumbing.",
};
