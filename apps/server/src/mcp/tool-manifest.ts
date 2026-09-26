/**
 * Typed MCP tool manifest (Phase 5).
 *
 * EVERY descriptor here is the checked wire contract for one MCP tool:
 * the exact public name, the exact oRPC procedure (or extracted diagnostic
 * core) it invokes, its scope requirement, confirmation policy, feature
 * dependency, side-effect classification, input adapter, and safe output
 * projector. The completeness test (tool-manifest.test.ts) fails when:
 *   - the manifest's names differ from the checked read/write catalog in ANY
 *     way (extra, missing, or duplicated);
 *   - an `appRouter` leaf is neither a tool target nor an explicit exclusion;
 *   - a write tool lacks literal `mcp:write`, a destructive tool lacks
 *     `DELETE`, or an external/cost tool lacks `RUN`;
 *   - a target path does not resolve against the real router object.
 *
 * INPUT SCHEMA POLICY (deliberate): procedure-backed tools advertise a loose
 * object schema (plus the confirmation literal where gated) instead of a
 * hand-mirrored copy of each procedure's zod input. The oRPC procedure is
 * the SINGLE validation authority for its input — mirroring 60+ schemas in
 * this file could only drift, and a drifted mirror would either reject
 * valid calls or accept invalid ones that the procedure then rejects with a
 * stable mapped error anyway. The advertised schema carries the one field
 * the MCP layer itself owns (`confirm`) and lets every other argument
 * through to the authoritative validator.
 */

import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { AppRouterClient } from "@ws-model-proxy/api/routers/index";
import { z } from "zod";
import { runChatCompletionDiagnostic, runPoolMemberTest } from "../model-api/diagnostics.js";
import type { McpRequestCredential } from "./cli-command-access.js";
import {
  adaptCliCommandResultInput,
  adaptCliCommandRunInput,
  adaptCliSupervisedStartInput,
  CLI_COMMAND_OUTPUT_NOTICE,
  CLI_SUPERVISED_COMMAND_NOTICE,
  runForwarderCliCommand,
  runForwarderCliCommandResult,
  runForwarderCliSupervisedCommandStart,
} from "./cli-command-tools.js";

/** Endpoint-wide scope requirement. Write tools require literal `mcp:write`. */
export type McpToolScope = "read" | "write";

/**
 * Human-confirmation policy literal surfaced to the client:
 * - `DELETE` — destructive removal;
 * - `RUN` — externally visible or costly execution;
 * - `null` — ordinary mutation/read, no confirmation gate.
 */
export type McpToolConfirmation = "DELETE" | "RUN" | null;

/** Side-effect classification used by the coverage checks. */
export type McpToolClass = "pure" | "external" | "cost" | "destructive";

/** Everything the tool wrapper needs to execute a procedure-backed tool. */
export interface McpToolRunDeps {
  /** Verified user id (`sub`) — the ONLY identity the tools ever act for. */
  userId: string;
  /**
   * The verified request's OWNED admission signal (G1): diagnostic cores
   * thread it into their network work (relay attempts, the synthetic chat
   * Request) so client aborts / shutdown tear them down. CLI command run
   * passes it to the wait; an abort ends the wait, not the command.
   */
  signal?: AbortSignal;
  /**
   * Admission credential. OAuth and PATs without `allowCliCommands` cannot
   * run the CLI command tools. Missing bindings are treated as OAuth.
   */
  credential: McpRequestCredential;
}

/** One checked tool descriptor. */
export interface McpToolDescriptor {
  /** Exact public MCP tool name (stable wire contract). */
  name: string;
  /** Exact oRPC procedure path or extracted-core identifier (documentation + checked). */
  target: string;
  /** Required scope: `read` (mcp:read or mcp:write) or `write` (literal mcp:write). */
  scope: McpToolScope;
  /** Confirmation policy literal (`DELETE` / `RUN` / null). */
  confirmation: McpToolConfirmation;
  /**
   * Feature flags the underlying procedure family depends on
   * (informational metadata; runtime enforcement stays in oRPC). More than
   * one entry when the procedure has SEVERAL conditional gates (G8a).
   */
  featureDependencies?: readonly string[];
  /** Side-effect class for coverage-artifact checks. */
  classification: McpToolClass;
  /** Advertised input schema (loose object + confirm literal for gated tools). */
  inputSchema: StandardSchemaWithJSON;
  /** Input adapter (MCP args → procedure input). Runs AFTER confirm-stripping. */
  inputAdapter?: (input: unknown) => unknown;
  /** Safe output projector applied BEFORE redaction + caps + serialization. */
  outputProjector?: (output: unknown) => unknown;
  /** Procedure-backed tools: typed invocation through the per-request client. */
  invokeProcedure?: (client: AppRouterClient, input: unknown) => Promise<unknown>;
  /** Extracted-core tools: user-ID-bound application function invocation. */
  invokeCore?: (input: unknown, deps: McpToolRunDeps) => Promise<unknown>;
  /**
   * Extra sentence appended to the generated tool description.
   */
  descriptionNote?: string;
  /**
   * Deliver the core's result even if the admission signal aborts. CLI
   * command run uses this: abort ends the wait, not the command, and the
   * result must still carry `commandId`.
   */
  deliverDespiteAbort?: boolean;
}

/**
 * Clean, field-naming MCP error thrown by input adapters (G3): JSON cannot
 * carry the `Date` arguments several procedures require, so descriptors
 * with date-valued fields convert ISO-8601 strings and reject anything
 * else with THIS error — the wrapper maps it to a stable in-band tool
 * error naming the field (never a raw adapter message).
 */
export class McpInvalidDateInputError extends Error {
  constructor(readonly field: string) {
    super(`field ${field} must be an ISO-8601 timestamp`);
    this.name = "McpInvalidDateInputError";
  }
}

// ---------------------------------------------------------------------------
// Input adapters (JSON → procedure input)
// ---------------------------------------------------------------------------

/**
 * Strict RFC 3339 UTC timestamp: `YYYY-MM-DDTHH:MM:SS[.f+]Z` — the ONLY
 * form the adapter accepts. No offsets, no date-only forms, no space
 * separators: everything else (including the local-time and missing-Z
 * variants JavaScript's `new Date()` would happily parse) is rejected so no
 * silent timezone or calendar normalization can reach Prisma.
 */
const RFC3339_UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Parse one RFC 3339 UTC timestamp with FULL component validation and
 * construction via `Date.UTC` — impossible calendar dates (Feb 30, Apr 31,
 * Feb 29 on a non-leap year), hours > 23, or minutes/seconds > 59 are
 * REJECTED instead of being normalized into the next valid day by
 * JavaScript's permissive `Date` parsing. Returns `null` for any value that
 * is not a real UTC calendar timestamp in the accepted shape.
 */
function parseStrictRfc3339Utc(value: string): Date | null {
  const match = RFC3339_UTC_TIMESTAMP.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12) return null;
  const maxDay = month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] ?? 30);
  if (day < 1 || day > maxDay) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  // Fractional seconds: cut to milliseconds — never round (G3 pass 4).
  // Rounding a fraction like .9999 to 1000 ms increments the Date.UTC
  // second/minute/hour/day/year BEFORE `setUTCFullYear(year)` below
  // overwrites the rolled-over year, corrupting 2026-12-31T23:59:59.9999Z
  // into 2026-01-01 (wrong by ~a year on filters and destructive
  // staleBefore guards). Truncation is deterministic, never crosses a
  // calendar boundary, and matches millisecond `Date` precision. The
  // fraction digits are sliced as a STRING (padded to three places) so
  // binary floating-point artifacts (0.123 * 1000 === 122.999...) cannot
  // perturb the result.
  const millis = match[7] !== undefined ? Number(`${match[7].slice(1, 4).padEnd(3, "0")}`) : 0;
  // `Date.UTC` maps years 0-99 to 1900-1999; construct inside the safe
  // range and set the real year explicitly so 0000-0099 stay exact.
  const date = new Date(Date.UTC(2000, month - 1, day, hour, minute, second, millis));
  date.setUTCFullYear(year);
  return date;
}

/**
 * Adapt ISO-8601 timestamp STRINGS on the named fields to `Date` objects
 * (G3): the procedure's `z.date()` schema is the authority, but JSON can
 * only carry strings — without this adapter every timestamp filter
 * (`relay_requests_list` createdAfter/Before, the `staleBefore` guards)
 * would fail procedure validation with a generic BAD_REQUEST. ONLY strict
 * RFC 3339 UTC timestamps are accepted; anything else — non-string values,
 * `null` (the underlying schemas are `z.date().optional()`, where `null` is
 * invalid, and deleting it would silently remove the guard), a date-only
 * form, an offset form, or an impossible calendar date — is rejected with a
 * clean field-naming error BEFORE any procedure call. Absent fields pass
 * through untouched.
 */
export function isoDateFieldsAdapter(fields: readonly string[]): (input: unknown) => unknown {
  return (input) => {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
    const record = { ...(input as Record<string, unknown>) };
    for (const field of fields) {
      const value = record[field];
      if (value === undefined) continue;
      if (value instanceof Date) continue;
      if (typeof value !== "string") throw new McpInvalidDateInputError(field);
      const parsed = parseStrictRfc3339Utc(value);
      if (parsed === null || Number.isNaN(parsed.getTime())) {
        throw new McpInvalidDateInputError(field);
      }
      record[field] = parsed;
    }
    return record;
  };
}

// ---------------------------------------------------------------------------
// Input schema builders
// ---------------------------------------------------------------------------

/**
 * G5 (pass 4): first-stage bound on tool INPUT size, enforced BEFORE any
 * object/child parsing inside the registered zod schema so the installed
 * SDK's validation-error path (which echoes every zod issue into the tool
 * result) stays bounded: an oversized or abusive input produces ONE issue
 * instead of a per-entry issue echo that can dwarf the output cap.
 * Documented constant: 64 KiB of JSON encoding — far above every
 * legitimate tool argument (the endpoint body cap is 1 MiB, which an
 * attacker could otherwise fill with invalid entries). The guard measures
 * the JSON encoding of the value the SDK hands the schema BEFORE any
 * parsing — including keys (such as JSON-origin `__proto__`) that object
 * parsing would later drop, which is deliberately CONSERVATIVE: anything
 * that large is rejected regardless of later key-dropping, while the raw
 * wire is separately bounded by the 1 MiB body cap.
 */
export const MCP_TOOL_INPUT_MAX_BYTES = 64 * 1024;

function inputByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : new TextEncoder().encode(serialized).length;
}

/**
 * The FIRST schema stage (G5 pass 4): a `z.transform`-based guard that
 * measures the JSON encoding of the incoming value and adds ONE custom
 * issue when it exceeds {@link MCP_TOOL_INPUT_MAX_BYTES}. Installed Zod
 * (v4) runs object/child parsing before appended `.check(...)` refinements
 * and SKIPS those checks after an aborting parse issue — the pass-3
 * appended check could therefore be bypassed by any input that also failed
 * child validation. Piping this guard ahead of the object schema makes the
 * measurement the EARLIEST stage: it always runs, and when it fails, the
 * pipeline short-circuits with exactly one issue and child parsing never
 * executes.
 */
const INPUT_SIZE_GUARD = z.transform((value, ctx) => {
  if (inputByteLength(value) > MCP_TOOL_INPUT_MAX_BYTES) {
    ctx.addIssue({
      code: "custom",
      message: `input exceeds the maximum size of ${MCP_TOOL_INPUT_MAX_BYTES} bytes`,
      input: value,
      path: [],
    });
  }
  return value;
});

/**
 * Wrap one advertised input schema with the first-pass size bound: the
 * guard measures FIRST (always, before any child parsing) and adds ONE
 * issue for oversized inputs. The advertised JSON Schema shape is
 * unchanged — the pipe's `toJSONSchema` output equals the inner object's
 * (custom transforms emit no JSON-Schema keywords).
 */
function withInputSizeBound<T extends z.ZodType>(schema: T) {
  return z.pipe(INPUT_SIZE_GUARD, schema as z.ZodType);
}

/** Loose passthrough object — the procedure's zod input stays the authority. */
function anyArgs(): StandardSchemaWithJSON {
  return withInputSizeBound(z.looseObject({}));
}

/** Loose object that additionally requires the exact confirmation literal. */
function confirmedArgs(confirmation: Exclude<McpToolConfirmation, null>): StandardSchemaWithJSON {
  return withInputSizeBound(z.looseObject({ confirm: z.literal(confirmation) }));
}

// ---------------------------------------------------------------------------
// Procedure invocation helper
// ---------------------------------------------------------------------------

/**
 * Build the typed invocation for one procedure leaf.
 *
 * The ONE `input as I` cast in the entire manifest is this seam: the input
 * arrived as unknown JSON from the wire, and the procedure's own zod schema
 * revalidates it server-side before any handler runs — that validator, not
 * this cast, is the input authority (see the INPUT SCHEMA POLICY above).
 */
export function procedureInvoker<I, O>(
  select: (client: AppRouterClient) => (input: I) => Promise<O>,
): (client: AppRouterClient, input: unknown) => Promise<O> {
  return (client, input) => select(client)(input as I);
}

// ---------------------------------------------------------------------------
// Safe output projectors
// ---------------------------------------------------------------------------

/**
 * Explicit safe projection for provider credential rows: keep ONLY the
 * display-safe metadata fields. The procedure already selects exactly these
 * columns, but the projection is the MCP-side contract — a future select
 * widening cannot leak through this tool.
 */
const SAFE_CREDENTIAL_FIELDS = [
  "id",
  "createdAt",
  "credentialType",
  "keyVersion",
  "displaySuffix",
  "status",
  "replacedAt",
  "lastUsedAt",
  "revokedAt",
] as const;

function projectCredentialRows(output: unknown): unknown {
  if (!Array.isArray(output)) return output;
  return output.map((row) => {
    if (row === null || typeof row !== "object") return row;
    const record = row as Record<string, unknown>;
    const projected: Record<string, unknown> = {};
    for (const field of SAFE_CREDENTIAL_FIELDS) {
      if (field in record) projected[field] = record[field];
    }
    return projected;
  });
}

// ---------------------------------------------------------------------------
// Feature dependencies
// ---------------------------------------------------------------------------

const PROVIDER_EGRESS_FEATURE = "WMP_PUBLIC_PROVIDER_EGRESS_ENABLED";

// ---------------------------------------------------------------------------
// The checked catalog — every entry's name/target pair is pinned against the
// checked read/write catalog by tool-manifest.test.ts.
// ---------------------------------------------------------------------------

const READ_TOOLS: readonly McpToolDescriptor[] = [
  {
    name: "app_config_get",
    target: "appConfig",
    scope: "read",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.appConfig),
  },
  {
    name: "forwarder_guarded_candidates_list",
    target: "forwarderManagement.listGuardedOverflowCandidates",
    scope: "read",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker(
      (client) => client.forwarderManagement.listGuardedOverflowCandidates,
    ),
  },
  {
    name: "forwarder_cli_devices_list",
    target: "forwarderManagement.listCliDevices",
    scope: "read",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.forwarderManagement.listCliDevices),
  },
  {
    name: "forwarder_model_pools_list",
    target: "forwarderManagement.listModelPools",
    scope: "read",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.forwarderManagement.listModelPools),
  },
  {
    name: "forwarder_affinity_stats_get",
    target: "forwarderManagement.cacheAffinityStats",
    scope: "read",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.forwarderManagement.cacheAffinityStats),
  },
  {
    name: "forwarder_models_visible_list",
    target: "forwarderManagement.visibleModels",
    scope: "read",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.forwarderManagement.visibleModels),
  },
  {
    name: "provider_accounts_list",
    target: "providerManagement.listAccounts",
    scope: "read",
    confirmation: null,
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.providerManagement.listAccounts),
  },
  {
    name: "provider_models_list",
    target: "providerManagement.listModels",
    scope: "read",
    confirmation: null,
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.providerManagement.listModels),
  },
  {
    name: "provider_pricing_versions_list",
    target: "providerManagement.listPricingVersions",
    scope: "read",
    confirmation: null,
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.providerManagement.listPricingVersions),
  },
  {
    name: "provider_credentials_list",
    target: "providerManagement.listCredentials",
    scope: "read",
    confirmation: null,
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "pure",
    inputSchema: anyArgs(),
    outputProjector: projectCredentialRows,
    invokeProcedure: procedureInvoker((client) => client.providerManagement.listCredentials),
  },
  {
    name: "provider_audit_events_list",
    target: "providerManagement.listAuditEvents",
    scope: "read",
    confirmation: null,
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.providerManagement.listAuditEvents),
  },
  {
    name: "provider_usage_page_list",
    target: "providerManagement.listUsageReportPage",
    scope: "read",
    confirmation: null,
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.providerManagement.listUsageReportPage),
  },
  {
    name: "provider_usage_totals_get",
    target: "providerManagement.getUsageTotals",
    scope: "read",
    confirmation: null,
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.providerManagement.getUsageTotals),
  },
  {
    name: "provider_budget_activity_list",
    target: "providerManagement.listBudgetActivity",
    scope: "read",
    confirmation: null,
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.providerManagement.listBudgetActivity),
  },
  {
    name: "provider_attempt_events_list",
    target: "providerManagement.listProviderAttemptEvents",
    scope: "read",
    confirmation: null,
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker(
      (client) => client.providerManagement.listProviderAttemptEvents,
    ),
  },
  {
    name: "provider_attempts_list",
    target: "providerManagement.listProviderAttempts",
    scope: "read",
    confirmation: null,
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.providerManagement.listProviderAttempts),
  },
  {
    name: "provider_budget_policies_list",
    target: "providerManagement.listBudgetPolicies",
    scope: "read",
    confirmation: null,
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.providerManagement.listBudgetPolicies),
  },
  {
    name: "capacity_records_list",
    target: "capacityManagement.list",
    scope: "read",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.capacityManagement.list),
  },
  {
    name: "capacity_audit_list",
    target: "capacityManagement.listAudit",
    scope: "read",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.capacityManagement.listAudit),
  },
  {
    name: "model_api_tokens_list",
    target: "modelApiTokens.list",
    scope: "read",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.modelApiTokens.list),
  },
  {
    name: "model_api_tokens_preview",
    target: "modelApiTokens.preview",
    scope: "read",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.modelApiTokens.preview),
  },
  {
    name: "cli_tokens_list",
    target: "cliCredentials.listTokens",
    scope: "read",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.cliCredentials.listTokens),
  },
  {
    name: "relay_requests_list",
    target: "relayMetadata.listOwn",
    scope: "read",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    // G3: JSON→Date adaptation for the timestamp filters (z.date() inputs).
    inputAdapter: isoDateFieldsAdapter(["createdAfter", "createdBefore"]),
    invokeProcedure: procedureInvoker((client) => client.relayMetadata.listOwn),
  },
  // --- dashboard overview (prompt-free aggregates) ---
  // Same procedure and scope as the web Overview: traffic on resources the
  // caller owns (any requester), plus the caller's own usage of pools shared
  // with them as per-pool totals; never other requesters' shared-pool usage.
  {
    name: "overview_metrics",
    target: "overview.metrics",
    scope: "read",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.overview.metrics),
  },
  {
    name: "overview_health",
    target: "overview.health",
    scope: "read",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.overview.health),
  },
];

/**
 * Chat diagnostic `messages` (G5 input parity, pass 5): a plain array of
 * `unknown` entries — NO minimum count and NO per-entry (role) validation.
 * Full input parity with the shared HTTP diagnostic path
 * (chatTestCompletionsHandler / prepareJsonModeledRequest), which validates
 * JSON and the model then forwards — it relays `messages: []` and roleless
 * entries verbatim (pinned by the HTTP regression), so the production
 * chat-test core owns the real per-entry validation. Mirroring per-entry
 * object schemas here would both diverge from HTTP again and let an
 * abusive input produce one zod issue PER ENTRY, which the installed SDK
 * echoes into an unbounded tool result. The ONLY intentional restriction
 * is the 64 KiB first-stage byte bound (withInputSizeBound) — the same
 * budget the pass-4 design established.
 */
const CHAT_MESSAGES_SCHEMA = z.array(z.unknown());

const WRITE_TOOLS: readonly McpToolDescriptor[] = [
  // --- forwarder management (writes) ---
  {
    name: "forwarder_guarded_pool_create",
    target: "forwarderManagement.createGuardedModelPool",
    scope: "write",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    // G8a: conditional provider-egress gate (providerModels.length > 0).
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    invokeProcedure: procedureInvoker(
      (client) => client.forwarderManagement.createGuardedModelPool,
    ),
  },
  {
    name: "forwarder_cli_device_rename",
    target: "forwarderManagement.renameCliDevice",
    scope: "write",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.forwarderManagement.renameCliDevice),
  },
  {
    name: "forwarder_cli_metadata_remove",
    target: "forwarderManagement.removeCliDeviceMetadata",
    scope: "write",
    confirmation: "DELETE",
    classification: "destructive",
    inputSchema: confirmedArgs("DELETE"),
    // G3: JSON→Date adaptation for the staleness guard (z.date() input).
    inputAdapter: isoDateFieldsAdapter(["staleBefore"]),
    invokeProcedure: procedureInvoker(
      (client) => client.forwarderManagement.removeCliDeviceMetadata,
    ),
  },
  {
    name: "forwarder_endpoint_metadata_remove",
    target: "forwarderManagement.removeEndpointMetadata",
    scope: "write",
    confirmation: "DELETE",
    classification: "destructive",
    inputSchema: confirmedArgs("DELETE"),
    // G3: JSON→Date adaptation for the staleness guard (z.date() input).
    inputAdapter: isoDateFieldsAdapter(["staleBefore"]),
    invokeProcedure: procedureInvoker(
      (client) => client.forwarderManagement.removeEndpointMetadata,
    ),
  },
  {
    name: "forwarder_model_metadata_remove",
    target: "forwarderManagement.removeDiscoveredModelMetadata",
    scope: "write",
    confirmation: "DELETE",
    classification: "destructive",
    inputSchema: confirmedArgs("DELETE"),
    // G3: JSON→Date adaptation for the staleness guard (z.date() input).
    inputAdapter: isoDateFieldsAdapter(["staleBefore"]),
    invokeProcedure: procedureInvoker(
      (client) => client.forwarderManagement.removeDiscoveredModelMetadata,
    ),
  },
  {
    name: "forwarder_affinity_clear",
    target: "forwarderManagement.clearCacheAffinity",
    scope: "write",
    confirmation: "DELETE",
    classification: "destructive",
    inputSchema: confirmedArgs("DELETE"),
    invokeProcedure: procedureInvoker((client) => client.forwarderManagement.clearCacheAffinity),
  },
  {
    name: "forwarder_model_pool_create",
    target: "forwarderManagement.createModelPool",
    scope: "write",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    // G8a: conditional provider-egress gate (publicEgress inputs).
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    invokeProcedure: procedureInvoker((client) => client.forwarderManagement.createModelPool),
  },
  {
    name: "forwarder_model_pool_update",
    target: "forwarderManagement.updateModelPool",
    scope: "write",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    // Conditional provider-egress gate (publicEgress inputs). Capacity policy
    // fields are always admitted; there is no capacity release flag.
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    invokeProcedure: procedureInvoker((client) => client.forwarderManagement.updateModelPool),
  },
  {
    name: "forwarder_model_pool_delete",
    target: "forwarderManagement.deleteModelPool",
    scope: "write",
    confirmation: "DELETE",
    classification: "destructive",
    inputSchema: confirmedArgs("DELETE"),
    invokeProcedure: procedureInvoker((client) => client.forwarderManagement.deleteModelPool),
  },
  {
    name: "forwarder_pool_member_add",
    target: "forwarderManagement.addPoolMember",
    scope: "write",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.forwarderManagement.addPoolMember),
  },
  {
    name: "forwarder_provider_member_add",
    target: "forwarderManagement.addProviderPoolMember",
    scope: "write",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    // G8a: the provider-egress gate is UNCONDITIONAL for this procedure.
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    invokeProcedure: procedureInvoker((client) => client.forwarderManagement.addProviderPoolMember),
  },
  {
    name: "forwarder_pool_member_update",
    target: "forwarderManagement.updatePoolMember",
    scope: "write",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    // G8a: conditional provider-egress gate (provider model targets).
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    invokeProcedure: procedureInvoker((client) => client.forwarderManagement.updatePoolMember),
  },
  {
    name: "forwarder_provider_member_reorder",
    target: "forwarderManagement.reorderProviderPoolMember",
    scope: "write",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker(
      (client) => client.forwarderManagement.reorderProviderPoolMember,
    ),
  },
  {
    name: "forwarder_pool_member_remove",
    target: "forwarderManagement.removePoolMember",
    scope: "write",
    confirmation: "DELETE",
    classification: "destructive",
    inputSchema: confirmedArgs("DELETE"),
    invokeProcedure: procedureInvoker((client) => client.forwarderManagement.removePoolMember),
  },
  {
    name: "forwarder_model_capabilities_update",
    target: "forwarderManagement.updateDiscoveredModelCapabilities",
    scope: "write",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker(
      (client) => client.forwarderManagement.updateDiscoveredModelCapabilities,
    ),
  },
  {
    name: "forwarder_model_capability_profile_set",
    target: "forwarderManagement.setDiscoveredModelCapabilityProfile",
    scope: "write",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker(
      (client) => client.forwarderManagement.setDiscoveredModelCapabilityProfile,
    ),
  },
  {
    name: "forwarder_model_attachment_limit_update",
    target: "forwarderManagement.updateDiscoveredModelAttachmentLimit",
    scope: "write",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker(
      (client) => client.forwarderManagement.updateDiscoveredModelAttachmentLimit,
    ),
  },
  {
    name: "forwarder_pool_grant_create",
    target: "forwarderManagement.grantPoolAccessByEmail",
    scope: "write",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker(
      (client) => client.forwarderManagement.grantPoolAccessByEmail,
    ),
  },
  {
    name: "forwarder_pool_grant_revoke",
    target: "forwarderManagement.revokePoolAccessByEmail",
    scope: "write",
    confirmation: "DELETE",
    classification: "destructive",
    inputSchema: confirmedArgs("DELETE"),
    invokeProcedure: procedureInvoker(
      (client) => client.forwarderManagement.revokePoolAccessByEmail,
    ),
  },
  // --- provider management (writes) ---
  {
    name: "provider_account_create",
    target: "providerManagement.createAccount",
    scope: "write",
    confirmation: null,
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.providerManagement.createAccount),
  },
  {
    name: "provider_account_update",
    target: "providerManagement.updateAccount",
    scope: "write",
    confirmation: null,
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.providerManagement.updateAccount),
  },
  {
    name: "provider_account_enabled_set",
    target: "providerManagement.setAccountEnabled",
    scope: "write",
    confirmation: null,
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.providerManagement.setAccountEnabled),
  },
  {
    name: "provider_account_delete",
    target: "providerManagement.deleteAccount",
    scope: "write",
    confirmation: "DELETE",
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "destructive",
    inputSchema: confirmedArgs("DELETE"),
    invokeProcedure: procedureInvoker((client) => client.providerManagement.deleteAccount),
  },
  {
    name: "provider_model_create",
    target: "providerManagement.createModel",
    scope: "write",
    confirmation: null,
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.providerManagement.createModel),
  },
  {
    name: "provider_model_update",
    target: "providerManagement.updateModel",
    scope: "write",
    confirmation: null,
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.providerManagement.updateModel),
  },
  {
    name: "provider_model_delete",
    target: "providerManagement.deleteModel",
    scope: "write",
    confirmation: "DELETE",
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "destructive",
    inputSchema: confirmedArgs("DELETE"),
    invokeProcedure: procedureInvoker((client) => client.providerManagement.deleteModel),
  },
  {
    name: "provider_pricing_version_create",
    target: "providerManagement.createPricingVersion",
    scope: "write",
    confirmation: null,
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.providerManagement.createPricingVersion),
  },
  {
    name: "provider_pricing_version_update",
    target: "providerManagement.updatePricingVersion",
    scope: "write",
    confirmation: null,
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.providerManagement.updatePricingVersion),
  },
  {
    name: "provider_pricing_version_activate",
    target: "providerManagement.activatePricingVersion",
    scope: "write",
    confirmation: "RUN",
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "external",
    inputSchema: confirmedArgs("RUN"),
    invokeProcedure: procedureInvoker((client) => client.providerManagement.activatePricingVersion),
  },
  {
    name: "provider_pricing_version_retire",
    target: "providerManagement.retirePricingVersion",
    scope: "write",
    confirmation: "RUN",
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "external",
    inputSchema: confirmedArgs("RUN"),
    invokeProcedure: procedureInvoker((client) => client.providerManagement.retirePricingVersion),
  },
  {
    name: "provider_pricing_version_delete",
    target: "providerManagement.deletePricingVersion",
    scope: "write",
    confirmation: "DELETE",
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "destructive",
    inputSchema: confirmedArgs("DELETE"),
    invokeProcedure: procedureInvoker((client) => client.providerManagement.deletePricingVersion),
  },
  {
    name: "provider_credential_revoke",
    target: "providerManagement.revokeCredential",
    scope: "write",
    confirmation: "DELETE",
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "destructive",
    inputSchema: confirmedArgs("DELETE"),
    invokeProcedure: procedureInvoker((client) => client.providerManagement.revokeCredential),
  },
  {
    name: "provider_credential_reencrypt",
    target: "providerManagement.rotateCredential",
    scope: "write",
    confirmation: null,
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.providerManagement.rotateCredential),
  },
  {
    name: "provider_credential_test",
    target: "providerManagement.testCredential",
    scope: "write",
    confirmation: "RUN",
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "cost",
    inputSchema: confirmedArgs("RUN"),
    invokeProcedure: procedureInvoker((client) => client.providerManagement.testCredential),
  },
  {
    name: "provider_budget_policy_create",
    target: "providerManagement.createBudgetPolicy",
    scope: "write",
    confirmation: null,
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.providerManagement.createBudgetPolicy),
  },
  {
    name: "provider_budget_policy_replace",
    target: "providerManagement.replaceBudgetPolicy",
    scope: "write",
    confirmation: null,
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.providerManagement.replaceBudgetPolicy),
  },
  {
    name: "provider_budget_policy_deactivate",
    target: "providerManagement.deactivateBudgetPolicy",
    scope: "write",
    confirmation: "DELETE",
    featureDependencies: [PROVIDER_EGRESS_FEATURE],
    classification: "destructive",
    inputSchema: confirmedArgs("DELETE"),
    invokeProcedure: procedureInvoker((client) => client.providerManagement.deactivateBudgetPolicy),
  },
  // --- capacity management (writes) ---
  {
    name: "capacity_record_create",
    target: "capacityManagement.create",
    scope: "write",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.capacityManagement.create),
  },
  {
    name: "capacity_record_update",
    target: "capacityManagement.update",
    scope: "write",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.capacityManagement.update),
  },
  {
    name: "capacity_record_remove",
    target: "capacityManagement.remove",
    scope: "write",
    confirmation: "DELETE",
    classification: "destructive",
    inputSchema: confirmedArgs("DELETE"),
    invokeProcedure: procedureInvoker((client) => client.capacityManagement.remove),
  },
  {
    name: "capacity_direct_policy_update",
    target: "capacityManagement.updateDirectPolicy",
    scope: "write",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.capacityManagement.updateDirectPolicy),
  },
  {
    name: "capacity_pool_policy_update",
    target: "capacityManagement.updatePoolPolicy",
    scope: "write",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.capacityManagement.updatePoolPolicy),
  },
  {
    name: "capacity_member_policy_update",
    target: "capacityManagement.updateMemberPolicy",
    scope: "write",
    confirmation: null,
    classification: "pure",
    inputSchema: anyArgs(),
    invokeProcedure: procedureInvoker((client) => client.capacityManagement.updateMemberPolicy),
  },
  // --- token revocation (writes) ---
  {
    name: "model_api_token_revoke",
    target: "modelApiTokens.revoke",
    scope: "write",
    confirmation: "DELETE",
    classification: "destructive",
    inputSchema: confirmedArgs("DELETE"),
    invokeProcedure: procedureInvoker((client) => client.modelApiTokens.revoke),
  },
  {
    name: "cli_token_revoke",
    target: "cliCredentials.revokeToken",
    scope: "write",
    confirmation: "DELETE",
    classification: "destructive",
    inputSchema: confirmedArgs("DELETE"),
    invokeProcedure: procedureInvoker((client) => client.cliCredentials.revokeToken),
  },
  // --- extracted diagnostic cores (writes: external + cost) ---
  {
    name: "forwarder_pool_member_test",
    target: "core:model-api/runPoolMemberTest",
    scope: "write",
    confirmation: "RUN",
    classification: "cost",
    inputSchema: withInputSizeBound(
      z.looseObject({ memberId: z.string().min(1), confirm: z.literal("RUN") }),
    ),
    inputAdapter: (input) =>
      typeof input === "object" && input !== null
        ? { memberId: (input as { memberId?: unknown }).memberId }
        : input,
    invokeCore: (input, deps) =>
      runPoolMemberTest({
        userId: deps.userId,
        memberId: (input as { memberId: string }).memberId,
        signal: deps.signal,
      }),
  },
  {
    name: "forwarder_chat_completion_test",
    target: "core:model-api/runChatCompletionDiagnostic",
    scope: "write",
    confirmation: "RUN",
    classification: "cost",
    inputSchema: withInputSizeBound(
      z.looseObject({
        model: z.string().min(1),
        messages: CHAT_MESSAGES_SCHEMA,
        confirm: z.literal("RUN"),
      }),
    ),
    invokeCore: (input, deps) =>
      runChatCompletionDiagnostic({
        userId: deps.userId,
        body: input as Record<string, unknown>,
        signal: deps.signal,
      }),
  },
  {
    name: "forwarder_cli_command_run",
    target: "core:forwarderCliCommandRun",
    scope: "write",
    confirmation: "RUN",
    classification: "external",
    descriptionNote: CLI_COMMAND_OUTPUT_NOTICE,
    deliverDespiteAbort: true,
    inputSchema: withInputSizeBound(
      z.looseObject({
        cliDeviceId: z.string(),
        command: z.string(),
        cwd: z.string().optional(),
        waitMs: z.number().optional(),
        confirm: z.literal("RUN"),
      }),
    ),
    inputAdapter: adaptCliCommandRunInput,
    invokeCore: (input, deps) => runForwarderCliCommand(input, deps),
  },
  {
    name: "forwarder_cli_supervised_command_start",
    target: "core:forwarderCliSupervisedCommandStart",
    scope: "write",
    confirmation: "RUN",
    classification: "external",
    descriptionNote: `${CLI_SUPERVISED_COMMAND_NOTICE} ${CLI_COMMAND_OUTPUT_NOTICE}`,
    deliverDespiteAbort: true,
    inputSchema: withInputSizeBound(
      z.looseObject({
        cliDeviceId: z.string(),
        command: z.string(),
        cwd: z.string().optional(),
        reason: z.string().optional(),
        shareOutput: z.boolean().optional(),
        confirm: z.literal("RUN"),
      }),
    ),
    inputAdapter: adaptCliSupervisedStartInput,
    invokeCore: (input, deps) => runForwarderCliSupervisedCommandStart(input, deps),
  },
  {
    name: "forwarder_cli_command_result",
    target: "core:forwarderCliCommandResult",
    scope: "write",
    confirmation: null,
    classification: "pure",
    descriptionNote: CLI_COMMAND_OUTPUT_NOTICE,
    inputSchema: withInputSizeBound(
      z.looseObject({
        commandId: z.string(),
        progress: z.boolean().optional(),
      }),
    ),
    inputAdapter: adaptCliCommandResultInput,
    invokeCore: (input, deps) => runForwarderCliCommandResult(input, deps),
  },
];

/**
 * The checked catalog: exactly 23 read tools and 50 write tools
 * (45 procedure-backed + 5 extracted cores: 2 diagnostics and 3 CLI commands).
 */
export const MCP_TOOL_MANIFEST: readonly McpToolDescriptor[] = [...READ_TOOLS, ...WRITE_TOOLS];

// ---------------------------------------------------------------------------
// Explicit first-release exclusions (Phase 5). Every `appRouter`
// leaf that is not a tool target above MUST appear here; the completeness
// test fails otherwise (a new unclassified procedure cannot ship silently).
// ---------------------------------------------------------------------------

export interface McpToolExclusion {
  /** Exact oRPC procedure path (or router, for whole-router exclusions). */
  target: string;
  /** Why the procedure is not an MCP tool in the first release. */
  reason: string;
}

export const MCP_TOOL_EXCLUSIONS: readonly McpToolExclusion[] = [
  {
    target: "auth.verifyEmailTransport",
    reason: "Auth-router surface; not a model-proxy operation.",
  },
  {
    target: "auth.updateLocale",
    reason: "Account identity management, not model-proxy operation.",
  },
  {
    target: "auth.passwordCapabilities",
    reason: "Auth-router surface; not a model-proxy operation.",
  },
  {
    target: "forwarderManagement.getProfileSlug",
    reason: "Profile-slug procedures are account identity management.",
  },
  {
    target: "forwarderManagement.previewProfileSlugChange",
    reason: "Profile-slug procedures are account identity management.",
  },
  {
    target: "forwarderManagement.updateProfileSlug",
    reason: "Profile-slug procedures are account identity management.",
  },
  {
    target: "providerManagement.createCredential",
    reason: "Accepts plaintext provider secrets; permanently excluded by policy.",
  },
  {
    target: "providerManagement.replaceCredential",
    reason: "Accepts plaintext provider secrets; permanently excluded by policy.",
  },
  {
    target: "providerManagement.listUsageReport",
    reason: "Overlaps the pageable usage report (provider_usage_page_list).",
  },
  {
    target: "providerManagement.repairExpiredAttempts",
    reason: "Operational accounting repair (admin-operated).",
  },
  { target: "modelApiTokens.create", reason: "Returns the one-time raw token secret." },
  { target: "cliCredentials.createToken", reason: "Returns the one-time raw token secret." },
  {
    target: "cliCredentials.exchangeDeviceCode",
    reason: "Public device-flow credential exchange; not an MCP surface.",
  },
  {
    target: "cliCredentials.deviceLoginRequest",
    reason: "Browser device-login approval page read; not an MCP surface.",
  },
  {
    target: "relayMetadata.deleteOwn",
    reason: "Audit/history deletion without an agent workflow.",
  },
  { target: "relayMetadata.prune", reason: "Admin-only accounting deletion." },
  {
    target: "settings.getAll",
    reason: "Global application settings read; not model-proxy operation.",
  },
  {
    target: "deploymentFlags",
    reason: "Signed-in product gates. The browser reads them; MCP does not.",
  },
  {
    target: "deploymentFeatures",
    reason: "Admin-only deployment inventory, including keyring status.",
  },
  {
    target: "settings.myNotificationPreferences",
    reason: "Notification settings are excluded from MCP.",
  },
  {
    target: "settings.updateMyNotificationPreferences",
    reason: "Notification settings are excluded from MCP.",
  },
  { target: "settings.update", reason: "Admin-only global settings mutation." },
  { target: "devices.list", reason: "Admin-only device administration." },
  { target: "devices.revoke", reason: "Admin-only device administration." },
  { target: "users.list", reason: "Admin-only account management." },
  { target: "users.invite", reason: "Admin-only account management." },
  { target: "users.setRole", reason: "Admin-only account management." },
  { target: "users.archive", reason: "Admin-only account management." },
  { target: "users.unarchive", reason: "Admin-only account management." },
  { target: "users.remove", reason: "Admin-only account management." },
  { target: "adminObservability.listCliDevices", reason: "Admin-only observability." },
  { target: "adminObservability.listEndpoints", reason: "Admin-only observability." },
  { target: "adminObservability.listModels", reason: "Admin-only observability." },
  { target: "adminObservability.listPools", reason: "Admin-only observability." },
  {
    target: "adminObservability.listRelayMetadataSummaries",
    reason: "Admin-only observability.",
  },
  {
    target: "providerCatalog.search",
    reason:
      "Human-only catalog picker: an outbound OpenRouter catalog fetch that stays out of MCP.",
  },
  {
    target: "providerCatalog.importModel",
    reason: "Human-only catalog import; agents use the confirmed provider model tools.",
  },
  {
    target: "providerCatalog.getPoolExternalEquivalent",
    reason: "Human-only pool external-equivalent picker.",
  },
  {
    target: "providerCatalog.setPoolExternalEquivalent",
    reason: "Human-only pool external-equivalent picker (the owner's BYOK consent).",
  },
  {
    target: "mcpGrants.listMine",
    reason:
      "Human-only MCP grant management (Phase 7): a connected MCP client must not enumerate the user's other authorizations.",
  },
  {
    target: "mcpGrants.revokeMine",
    reason:
      "Human-only MCP grant revocation (Phase 7): only the browser session may kill grant generations.",
  },
  {
    target: "mcpTokens.listMine",
    reason:
      "Human-only MCP personal-token management: a connected MCP client must not enumerate the user's other credentials.",
  },
  {
    target: "mcpTokens.create",
    reason: "Returns the one-time raw MCP personal-token secret; human-only browser session.",
  },
  {
    target: "forwarderManagement.setCliDeviceFeatureGrants",
    reason: "human-only device grant",
  },
  {
    target: "supervisedCommands.pending",
    reason:
      "Human-only supervised-command awareness: the person, not an agent, answers agent requests.",
  },
  {
    target: "supervisedCommands.submitOutput",
    reason:
      "Human-only output review: an agent must never review or release the output of its own request.",
  },
  {
    target: "forwarderManagement.listDashboardNotices",
    reason: "human-only dashboard notices",
  },
  {
    target: "forwarderManagement.dismissDashboardNotice",
    reason: "human-only dashboard notices",
  },
  {
    target: "mcpTokens.updateMine",
    reason:
      "Human-only MCP personal-token capability edits: a connected MCP client must not widen or narrow its own or other credentials.",
  },
  {
    target: "mcpTokens.revokeMine",
    reason:
      "Human-only MCP personal-token revocation: only the browser session may kill PAT generations.",
  },
];
