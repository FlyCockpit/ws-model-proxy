/**
 * Shared contract schemas: ids, pages, the Prisma enums (values identical to
 * `packages/db/prisma/schema/*.prisma`; `contracts.test.ts` compares them), and the
 * "effective value + source" shape used by every Advanced view.
 *
 * Pure module: the web imports these schemas for forms.
 */
import { RESERVED_FORWARDER_SLUGS } from "@ws-model-proxy/config/forwarder-identifiers";
import { z } from "zod";

// ── Ids and paging ──

/** A row id (cuid2) named by a caller: never free text that reaches SQL as-is. */
export const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
/** Input of a procedure that takes none (clients may send nothing or `{}`). */
export const noInputSchema = z.object({}).strict().optional();
export const slugSchema = z.string().regex(/^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,40}$/);
/**
 * Node slugs the CLI refuses (`apps/cli/src/slug.rs` RESERVED; `contracts.test.ts` keeps the
 * lists equal): they collide with routes and old nouns. One list with the forwarder slugs.
 */
export const RESERVED_NODE_SLUGS = RESERVED_FORWARDER_SLUGS;
const reservedNodeSlugs: ReadonlySet<string> = new Set(RESERVED_NODE_SLUGS);
/**
 * The shape of a stored node slug (3–63 lowercase letters, digits and single inner hyphens).
 * Outputs use this: they echo what is stored, which may predate the reserved list.
 */
export const nodeSlugShapeSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62}$/);
/** A node slug a caller chooses: the shape, and not reserved (as the CLI checks). */
export const nodeSlugSchema = nodeSlugShapeSchema.refine(
  (slug) => !reservedNodeSlugs.has(slug),
  "That node name is reserved.",
);
export const nameSchema = z.string().trim().min(1).max(120);
export const descriptionSchema = z.string().trim().max(2_000);
/** Why (stored on the version / audit event so agent experiments are traceable, G6). */
export const noteSchema = z.string().trim().min(1).max(500);
export const emailSchema = z.string().trim().toLowerCase().email().max(320);
export const isoDateSchema = z.iso.datetime();
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const cursorSchema = z.string().min(1).max(512);

export const pageInputShape = {
  cursor: cursorSchema.optional(),
  limit: z.number().int().min(1).max(200).default(50),
};
export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: cursorSchema.nullable() }).strict();
}

export const okSchema = z.object({ ok: z.literal(true) }).strict();
/** Destructive MCP calls repeat the word (§6.1). The web confirms in a dialog instead. */
export const confirmDeleteSchema = z.literal("DELETE");
export const confirmRunSchema = z.literal("RUN");

// ── Prisma enums (upper-case values, as stored) ──

export const ACTOR = ["USER", "AGENT", "SYSTEM"] as const;
export const NODE_TRUST = ["RELAY", "FULL"] as const;
export const NODE_CONNECTION = ["OFFLINE", "ONLINE"] as const;
export const NODE_AUDIT_KIND = [
  "command",
  "file_read",
  "file_stat",
  "file_list",
  "file_search",
  "file_write",
  "file_edit",
  "file_rename",
  "file_mkdir",
  "file_delete",
  "command_queued_for_user",
  "browser_terminal",
  "operator_terminal",
  "runtime_define",
  "runtime_remove",
  "metric_commands_define",
  "node_update",
  "trust_lower",
  "marked_stopped",
] as const;
export const NODE_AUDIT_OUTCOME = [
  "completed",
  "refused",
  "failed",
  "cancelled",
  "declined",
  "expired",
  "unknown",
  "opened",
  "accepted",
  "closed",
  "auto_settled",
] as const;
export const QUEUED_COMMAND_STATE = [
  "QUEUED",
  "RUN",
  "DISMISSED",
  "EXPIRED",
  "REFUSED",
  "WITHDRAWN",
] as const;
export const NODE_COMMAND_STATE = [
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
  "INTERRUPTED",
  "UNKNOWN",
] as const;
export const RUNTIME_KIND = ["ALWAYS_ON", "STARTABLE"] as const;
export const RUNTIME_ORIGIN = ["NODE", "SERVER"] as const;
export const RUNTIME_API = ["OPENAI", "ANTHROPIC"] as const;
export const ENGINE = ["VLLM", "SGLANG", "LLAMA_CPP", "OLLAMA", "LM_STUDIO", "OTHER"] as const;
export const MODEL_TYPE = ["LLM", "EMBEDDINGS", "TRANSCRIPTION"] as const;
export const MODEL_CAPABILITY = [
  "TEXT_GENERATION",
  "VISION_INPUT",
  "VIDEO_INPUT",
  "EMBEDDING",
  "AUDIO_INPUT",
  "AUDIO_OUTPUT",
  "RESPONSES_API",
] as const;
export const ENGINE_LOAD_GATE = ["AUTO", "ENFORCE", "OBSERVE"] as const;
export const DESIRED_STATE = ["RUNNING", "STOPPED"] as const;
export const INSTANCE_PHASE = [
  "STARTING",
  "READY",
  "UNHEALTHY",
  "UNAVAILABLE",
  "STOPPING",
  "STOPPED",
  "FAILED",
] as const;
export const OPERATOR_NEED = ["STEP", "RESTART", "MARK_STOPPED"] as const;
export const CLAIM_STATE = ["HELD", "RELEASED", "HELD_UNKNOWN"] as const;
export const STEP_PHASE = [
  "PREPARE",
  "START",
  "AFTER_JOIN",
  "READINESS",
  "HEALTH",
  "STOP",
  "STATUS",
] as const;
export const STEP_STATE = [
  "PENDING",
  "RUNNING",
  "AWAITING_OPERATOR",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const;
export const OPERATION_KIND = [
  "START",
  "STOP",
  "RESTART",
  "PROFILE_APPLY",
  "MARK_STOPPED",
] as const;
export const TARGET_HEALTH = ["UNKNOWN", "HEALTHY", "DEGRADED", "HALF_OPEN", "UNHEALTHY"] as const;
export const PRIORITY_CLASS = ["BACKGROUND", "NORMAL", "HIGH"] as const;
export const FALLBACK_MODE = ["OFF", "OWNER", "OWNER_AND_SHARES"] as const;
export const MEMBER_KIND = ["LOCAL", "CLOUD"] as const;
export const MEMBER_STATE = ["ACTIVE", "DISABLED"] as const;
export const SIDECAR_INPUT = ["IMAGE", "AUDIO", "VIDEO"] as const;
export const API_KEY_SCOPE = ["ALL_POOLS", "SELECTED_POOLS"] as const;
export const AGENT_LEVEL = ["READ", "FULL"] as const;
export const PROVIDER_AUTH_TYPE = ["API_KEY", "BEARER"] as const;
export const PROVIDER_CREDENTIAL_STATUS = ["ACTIVE", "REPLACED", "REVOKED"] as const;
export const PROVIDER_HEALTH = ["UNKNOWN", "HEALTHY", "DEGRADED", "UNAVAILABLE"] as const;
export const PROVIDER_PRICING_STATUS = ["DRAFT", "ACTIVE", "RETIRED"] as const;
export const USAGE_COST_CONFIDENCE = ["REPORTED", "CALCULATED", "ESTIMATED"] as const;
export const SPEND_CAP_SCOPE = ["PROVIDER_ACCOUNT", "SHARE"] as const;
export const REQUEST_SOURCE = ["API_KEY", "TEST", "AGENT_TEST", "SIDECAR"] as const;
export const REQUEST_STATUS = ["PENDING", "SUCCEEDED", "FAILED", "CANCELED"] as const;
export const ATTEMPT_KIND = ["LOCAL", "CLOUD"] as const;
export const ATTEMPT_STATE = ["ACTIVE", "COMPLETED", "FAILED", "CANCELLED", "EXPIRED"] as const;

/** The enums above keyed by their Prisma name (checked against the schema files). */
export const PRISMA_ENUM_MIRRORS = {
  Actor: ACTOR,
  NodeTrust: NODE_TRUST,
  NodeConnection: NODE_CONNECTION,
  NodeAuditKind: NODE_AUDIT_KIND,
  NodeAuditOutcome: NODE_AUDIT_OUTCOME,
  QueuedCommandState: QUEUED_COMMAND_STATE,
  NodeCommandState: NODE_COMMAND_STATE,
  RuntimeKind: RUNTIME_KIND,
  RuntimeOrigin: RUNTIME_ORIGIN,
  RuntimeApi: RUNTIME_API,
  Engine: ENGINE,
  ModelType: MODEL_TYPE,
  ModelCapability: MODEL_CAPABILITY,
  EngineLoadGate: ENGINE_LOAD_GATE,
  DesiredState: DESIRED_STATE,
  InstancePhase: INSTANCE_PHASE,
  OperatorNeed: OPERATOR_NEED,
  ClaimState: CLAIM_STATE,
  StepPhase: STEP_PHASE,
  StepState: STEP_STATE,
  OperationKind: OPERATION_KIND,
  TargetHealth: TARGET_HEALTH,
  PriorityClass: PRIORITY_CLASS,
  FallbackMode: FALLBACK_MODE,
  MemberKind: MEMBER_KIND,
  MemberState: MEMBER_STATE,
  SidecarInput: SIDECAR_INPUT,
  ApiKeyScope: API_KEY_SCOPE,
  AgentLevel: AGENT_LEVEL,
  ProviderAuthType: PROVIDER_AUTH_TYPE,
  ProviderCredentialStatus: PROVIDER_CREDENTIAL_STATUS,
  ProviderHealth: PROVIDER_HEALTH,
  ProviderPricingStatus: PROVIDER_PRICING_STATUS,
  UsageCostConfidence: USAGE_COST_CONFIDENCE,
  SpendCapScope: SPEND_CAP_SCOPE,
  RequestSource: REQUEST_SOURCE,
  RequestStatus: REQUEST_STATUS,
  AttemptKind: ATTEMPT_KIND,
  AttemptState: ATTEMPT_STATE,
} as const;

// ── Effective values (Advanced tabs, `runtimes_get` limits) ──

/**
 * `override`: set on the pool/version; `auto`: observed from the engine or derived;
 * `default`: the registry default.
 */
export const VALUE_SOURCE = ["override", "auto", "default"] as const;

/** Money as a decimal string (Prisma Decimal(30,9)); never a float. */
export const moneySchema = z.string().regex(/^-?(0|[1-9][0-9]{0,20})(\.[0-9]{1,9})?$/);
export const currencySchema = z.string().regex(/^[A-Z]{3}$/);

/** Who did something, as shown in history lists. */
export const actorRefSchema = z
  .object({
    actor: z.enum(ACTOR),
    userId: idSchema.nullable(),
    agentTokenId: idSchema.nullable(),
    /** Display only: the person's name or the agent token's name. */
    label: z.string().max(200).nullable(),
  })
  .strict();
