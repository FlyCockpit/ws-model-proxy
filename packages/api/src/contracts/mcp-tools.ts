/**
 * The 0.4.0 MCP tool manifest (spec §6): 25 tools, user nouns, no implementations.
 * `apps/server/src/mcp/tool-manifest.ts` registers these in S0c; handlers call the procedures
 * named in `procedures`. READ tokens see the read tools; FULL tokens see all 25. Every write
 * takes an optional `note`. Refusals keep the fleet-fixes passthrough (`data.reason` + valid
 * choices); NOT_FOUND only for things the caller cannot see.
 *
 * Tool and field descriptions follow the glossary (§1.2); `contracts.test.ts` checks the
 * banned words.
 */
import { z } from "zod";
import { activityContract } from "./activity";
import { confirmDeleteSchema, idSchema, MODEL_CAPABILITY, okSchema } from "./common";
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
  /** Shown to the agent. Plain language, the user's nouns. */
  description: string;
  input: z.ZodType;
  output: z.ZodType;
  /** Procedure paths (`router.sub.name`) the handler calls. */
  procedures: readonly string[];
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

const runtimeUpdateInput = runtimesContract.update.input
  .extend({
    /** Override served-model capabilities (null: use what the node detected). */
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
  })
  .strict();

export const MCP_TOOLS: readonly McpToolContract[] = [
  tool({
    name: "nodes_get",
    description:
      "List your nodes, or one node in detail: online, trust (Full control or Relay only, a pending lowering, frozen), hardware with where each value comes from (browser, node, detected), reserved and live free memory, labels, port range, node metric commands, held runtime definitions, instances, local servers the node found, and commands queued for you.",
    input: z.object({ nodeId: idSchema.optional() }).strict(),
    output: z.union([z.object({ nodes: z.array(nodeSummarySchema) }).strict(), nodeDetailSchema]),
    procedures: ["nodes.list", "nodes.get"],
  }),
  tool({
    name: "runtimes_get",
    description:
      "List your runtimes, or one in detail: kind (always-on or startable), node, current version (definition, limits as effective value with source auto/override/default), served models, instances (phase, nodes, needs you, restart window), pools using it, shares and contributions. With versions: the version list with notes and launch hashes; with versionId: that version's full definition.",
    input: z
      .object({
        runtimeId: idSchema.optional(),
        versions: z.boolean().optional(),
        versionId: idSchema.optional(),
      })
      .strict(),
    output: z.union([
      z.object({ runtimes: z.array(runtimeSummarySchema) }).strict(),
      runtimeVersionDetailSchema,
      runtimeDetailSchema
        .extend({ versions: z.array(runtimeVersionSummarySchema).optional() })
        .strict(),
    ]),
    procedures: [
      "runtimes.list",
      "runtimes.get",
      "runtimes.versions.list",
      "runtimes.versions.get",
      "runtimes.presets.list",
    ],
  }),
  tool({
    name: "pools_get",
    description:
      "List your pools (and pools shared with you), or one pool: callable IDs, type, routing, cloud setting (read-only for agents), sidecars, advanced settings with effective values, metric routing rules, members with status and live load, number of shares.",
    input: z
      .object({
        poolId: idSchema.optional(),
        /** With poolId: also the pool's configuration history (newest first). */
        history: z.boolean().optional(),
      })
      .strict(),
    output: z.union([
      poolsContract.list.output,
      poolViewSchema.extend({ history: poolsContract.history.list.output.optional() }).strict(),
    ]),
    procedures: ["pools.list", "pools.get", "pools.history.list"],
  }),
  tool({
    name: "profiles_get",
    description:
      "List your profiles, or one: the nodes it owns, pinned runtime versions with counts (and whether pins are outdated), whether it is satisfied now, and the last apply.",
    input: z.object({ profileId: idSchema.optional() }).strict(),
    output: z.union([profilesContract.list.output, profileViewSchema]),
    procedures: ["profiles.list", "profiles.get"],
  }),
  tool({
    name: "providers_get",
    description:
      "Cloud provider accounts (never keys): enabled, health, models (type, context, price) and this month's spend against the monthly cap. Changing providers is for people only.",
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
      "Recent requests without prompts: route (local, cloud, own key), what served them, queue wait, time to first token, tokens, refusal reason and error class. Filter by pool, runtime, version, node, status or time.",
    input: activityContract.requests.list.input,
    output: activityContract.requests.list.output,
    procedures: ["activity.requests.list"],
  }),
  tool({
    name: "metrics_query",
    description:
      "Metrics for a pool, runtime, version, node or instance over 1h/24h/7d/30d or a custom range, in 1m/5m/1h/1d steps, optionally grouped by runtime, version, node, instance, model, member or source. Request metrics (requests, errors, refusals by reason, TTFT and latency p50/p95, queue wait, decode and prefill tokens per second, tokens, cache hit rate, cloud share), engine load (KV usage, running, waiting, full ratio) and node gauges (CPU, free memory, accelerator memory, GPU use and temperature, custom:<name> from node metric commands). Use it to compare versions after a change.",
    input: activityContract.metrics.query.input,
    output: activityContract.metrics.query.output,
    procedures: ["activity.metrics.query"],
  }),
  tool({
    name: "model_test",
    description:
      "Send a test to a callable ID (owner/pool or owner/pool:external) or to one of your runtimes directly, and see what served it, TTFT, latency and tokens. kind chat, embeddings or transcription (a built-in short silent WAV). bench repeats up to 50 requests with up to 8 at once and returns p50/p95; bench traffic counts in metrics as agent tests. No API key needed; bench against :external is refused.",
    input: modelsContract.test.input,
    output: modelsContract.test.output,
    procedures: ["models.test"],
    rateLimit: { perMinute: 2, key: "bench", onlyWhen: "bench" },
  }),
  tool({
    name: "pool_create",
    description:
      "Create a pool from served models (yours). It starts Local only: cloud fallback stays off until a person turns it on.",
    input: poolsContract.create.input,
    output: poolsContract.create.output,
    procedures: ["pools.create"],
  }),
  tool({
    name: "pool_update",
    description:
      "Change a pool: name, slug, members (add, remove, weight, disable), the ordered cloud members (only provider models a person enabled; spend caps apply), routing (priority class, pool cap, kept slots, borrowing), sidecars, and advanced settings (the one max wait, context ceiling and margin, affinity, warm protection, API adaptation, attachments, metric routing rules). Members other people contributed: weight and state only. People only: cloud mode, paid warm protection, own-key consent, only-my-own-hardware.",
    input: poolsContract.update.input,
    output: poolsContract.update.output,
    procedures: ["pools.update"],
  }),
  tool({
    name: "pool_delete",
    description:
      'Delete a pool. This also removes its shares, the monthly caps on those shares, members other people contributed, API-key entries and sidecar links from other pools. Requires confirm: "DELETE".',
    input: z.object({ poolId: idSchema, confirm: confirmDeleteSchema }).strict(),
    output: okSchema,
    procedures: ["pools.delete"],
  }),
  tool({
    name: "runtime_create",
    description:
      "Define a runtime. Always-on: the address of a server already running on a node (preset detected adds one the node found). Startable: commands to start, stop and check it on one or more nodes (presets vllm, sglang, llama_cpp, ollama_service, systemd_unit). Model downloads belong in the prepare command (up to 24 h). The definition is pushed to Full-control nodes only.",
    input: runtimesContract.create.input,
    output: runtimesContract.create.output,
    procedures: ["runtimes.create", "runtimes.presets.list"],
  }),
  tool({
    name: "runtime_update",
    description:
      "Save a new version of a runtime (say why in note). Limit and advanced edits keep the launch hash and apply to running instances at once; a changed definition needs a restart (restartRunning restarts instances on Full-control nodes and lists the rest under needsRestart). A definition change to an always-on runtime on a Relay-only node is refused. Also overrides served-model capabilities.",
    input: runtimeUpdateInput,
    output: runtimesContract.update.output.extend({
      models: z.array(runtimeModelViewSchema).optional(),
    }),
    procedures: ["runtimes.update", "runtimes.models.setCapabilities"],
  }),
  tool({
    name: "runtime_delete",
    description:
      'Delete a runtime. Refused while instances run (instances_running) or while a profile pins it (pinned_by_profile). Removes its pool members, including in pools shared with you. Requires confirm: "DELETE".',
    input: z.object({ runtimeId: idSchema, confirm: confirmDeleteSchema }).strict(),
    output: runtimesContract.delete.output,
    procedures: ["runtimes.delete"],
  }),
  tool({
    name: "runtime_start",
    description:
      "Start a runtime on given nodes (or let the server place count instances), or restart an instance with instanceId. preview: true shows placements, what would be stopped to make room, and warnings (such as low free memory) without acting. No confirmation is needed and other startable runtimes may be stopped. Refused on Relay-only nodes (trust_relay): only people start runtimes there.",
    input: runtimesContract.start.input,
    output: runtimesContract.start.output,
    procedures: ["runtimes.start"],
    rateLimit: { perMinute: 10, key: "start_stop_apply" },
  }),
  tool({
    name: "runtime_stop",
    description:
      "Stop an instance, or every instance of a runtime (optionally on one node). Refused on Relay-only nodes (trust_relay).",
    input: runtimesContract.stop.input,
    output: runtimesContract.stop.output,
    procedures: ["runtimes.stop"],
    rateLimit: { perMinute: 10, key: "start_stop_apply" },
  }),
  tool({
    name: "profile_save",
    description:
      "Create or replace a profile: the nodes it owns and which runtime versions run there (count, optional node subset). Pins move only with updatePins.",
    input: profilesContract.save.input,
    output: profilesContract.save.output,
    procedures: ["profiles.save"],
  }),
  tool({
    name: "profile_apply",
    description:
      "Apply a profile: start its pinned runtimes and stop other startable runtimes on the nodes it owns (always-on runtimes are never touched). preview: true shows starts, stops, kept and warnings. Refused as a whole, with the list, if any owned node is Relay only.",
    input: profilesContract.apply.input,
    output: profilesContract.apply.output,
    procedures: ["profiles.apply"],
    rateLimit: { perMinute: 10, key: "start_stop_apply" },
  }),
  tool({
    name: "profile_delete",
    description: 'Delete a profile. Nothing stops. Requires confirm: "DELETE".',
    input: z.object({ profileId: idSchema, confirm: confirmDeleteSchema }).strict(),
    output: okSchema,
    procedures: ["profiles.delete"],
  }),
  tool({
    name: "node_update",
    description:
      "Change a Full-control node: labels, port range, declared hardware (including memory reserved for things outside wsmp), node metric commands, or rescan for local servers. Trust, renaming and deleting are for people only.",
    input: nodesContract.update.input,
    output: nodesContract.update.output,
    procedures: ["nodes.update"],
  }),
  tool({
    name: "node_command_run",
    description:
      'Run a command on a Full-control node and get its exit code and (masked, capped) output. Everything it starts dies with it or after 10 minutes: servers must be runtimes, and long downloads belong in a runtime\'s prepare command (up to 24 h). Requires confirm: "RUN".',
    input: nodesContract.commands.run.input,
    output: nodesContract.commands.run.output,
    procedures: ["nodes.commands.run"],
    rateLimit: { perMinute: 30, key: "node_command" },
  }),
  tool({
    name: "node_command_queue_for_user",
    description:
      "Queue a command for a person (for example one that needs their sudo password). It appears on their Terminals page and runs only when they press Run and then Enter in a browser terminal. Full-control nodes only; expires after expiresInHours (default 24, at most 168). nodes_get shows queued items and outcomes.",
    input: nodesContract.queued.enqueue.input,
    output: nodesContract.queued.enqueue.output,
    procedures: ["nodes.queued.enqueue"],
    rateLimit: { perMinute: 30, key: "node_command" },
  }),
  tool({
    name: "node_file_read",
    description:
      "Read a file, stat paths, list a folder or search under the node's allowed folders (Full control). Returns an etag for later edits.",
    input: nodeFileReadInputSchema,
    output: nodeFileReadOutputSchema,
    procedures: ["nodes.files.read"],
  }),
  tool({
    name: "node_file_write",
    description:
      "Write a file, make a folder, rename or delete under the node's allowed folders (Full control). Pass ifMatch with the etag you read to avoid overwriting changes.",
    input: nodeFileWriteInputSchema,
    output: nodeFileMutationOutputSchema,
    procedures: ["nodes.files.write"],
  }),
  tool({
    name: "node_file_edit",
    description:
      "Replace exact text in a file under the node's allowed folders (Full control); ifMatch is required. Returns the new etag and a diff summary.",
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
  "runtimes.detected.add": "Agents use runtime_create with preset detected.",
  "runtimes.shares.list": "Sharing runtime definitions is for people only.",
  "models.list": "Callable IDs are part of pools_get.",
  "access.apiKeys.list": "API keys are managed by people.",
  "access.agentTokens.list": "Agent tokens are managed by people.",
  "access.oauthGrants.list": "Agent connections are managed by people.",
  "access.shares.list": "Sharing is for people only; pools_get shows the count.",
  "access.contributing.pools": "Contributing to another person's pool is for people only.",
  "providers.accounts.get": "providers_get covers accounts and models.",
  "providers.pricing.list": "providers_get shows the active price.",
  "providers.catalog.search": "Adding provider models is for people only.",
  "providers.usage.list": "Spend details are for people; providers_get shows the month's total.",
  "providers.attempts.list": "Use requests_list (cloud attempts are requests with route cloud).",
  "activity.overview.summary": "Use metrics_query.",
  "activity.needsYou.list": "Needs-you items are in runtimes_get (instances) and nodes_get.",
  "settings.get": "Account settings are for people.",
  "app.flags": "Web app switches.",
  "auth.updateLocale": "Web app plumbing.",
  "auth.passwordCapabilities": "Web app plumbing.",
};
