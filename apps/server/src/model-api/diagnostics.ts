/**
 * Extracted diagnostic cores (Phase 5 — "Extracted diagnostic cores").
 *
 * Typed, USER-ID-BOUND application functions shared by the internal Hono
 * routes and the MCP tools. The Hono routes (chat-test.ts / pool-member-test.ts)
 * and the MCP bridge both consume THESE functions; neither calls the other.
 *
 * Invariants preserved from the original route implementations:
 * - the SINGLETON `relaySessionManager` and `modelApiConcurrencyLimiter` are
 *   the defaults (no runtime state is created per request and none is created
 *   per MCP request — the capacity runtime below is ONE module-lifetime
 *   instance shared by both transports);
 * - ownership checks (pool member / pool ownership by user id) happen in the
 *   core, keyed by the caller-supplied user id ONLY (MCP passes the verified
 *   JWT `sub`; the Hono route passes the session user);
 * - global + CLI concurrency leases are acquired/released exactly as before
 *   (acquire-global first, release in `finally`, no CLI lease taken when the
 *   global lease is exhausted);
 * - the relay attempt keeps its timeout, cancellation, and terminal-state
 *   handling (`startRelayAttempt`), and successful probes still mark pool
 *   member health (`markPoolMemberRelaySuccess`);
 * - capability checks (chat-completions support, published model/endpoint,
 *   connected CLI) run before any lease or relay dispatch.
 *
 * `runPoolMemberTest` returns a typed outcome discriminated union; the Hono
 * route maps it to the exact HTTP responses it always produced (its tests pin
 * that mapping byte-for-byte), and the MCP tool maps it to a JSON-safe result.
 *
 * `runChatCompletionDiagnostic` wraps the already-extracted, user-id-bound
 * `chatTestCompletionsHandler` core (routes.ts): it builds a synthetic
 * chat-completions Request, dispatches it through the SAME singletons, and
 * projects the response to a bounded, provider-safe summary — the raw
 * provider response NEVER crosses this boundary (invariant 10).
 */

import { markPoolMemberRelaySuccess } from "@ws-model-proxy/api/lib/model-pool-routing";
import {
  resolveEffectiveCapabilityMetadata,
  supportsChatCompletions,
} from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import prisma, { Prisma } from "@ws-model-proxy/db";
import { type RelaySessionManager, relaySessionManager } from "../relay/session-manager.js";
import { PostgresCapacityAdmissionStore } from "./capacity/postgres-store.js";
import {
  type CapacityAdmissionRuntime,
  StoreCapacityAdmissionRuntime,
} from "./capacity/runtime.js";
import {
  type ModelApiConcurrencyLimiter,
  ModelApiLimitError,
  type ModelApiLimitLease,
  modelApiConcurrencyLimiter,
} from "./limits.js";
import { extractAssistantTextFromChatCompletion, readResponseUtf8 } from "./media-transform.js";
import { startRelayAttempt } from "./relay-executor.js";
import { chatTestCompletionsHandler } from "./routes.js";

const TEST_TIMEOUT_MS = 20_000;
const EXPECTED_PROBE_WORD = /\bpong\b/i;

export function isSuccessfulChatProbeReply(status: number, rawText: string): boolean {
  if (status !== 200) return false;
  try {
    const parsed: unknown = JSON.parse(rawText);
    const text = extractAssistantTextFromChatCompletion(parsed);
    return Boolean(text && EXPECTED_PROBE_WORD.test(text));
  } catch {
    return false;
  }
}

type DiagnosticsManager = Pick<
  RelaySessionManager,
  | "getActiveCliDeviceIds"
  | "registerRelayResponseHandlers"
  | "sendRelayRequest"
  | "cancelRelayRequest"
  | "completeRelayRequest"
>;

export interface DiagnosticCoreDependencies {
  manager?: DiagnosticsManager;
  concurrencyLimiter?: ModelApiConcurrencyLimiter;
  capacityRuntime?: CapacityAdmissionRuntime;
}

/**
 * The ONE module-lifetime capacity admission runtime shared by the chat
 * diagnostic core across BOTH transports (Hono chat-test routes and the MCP
 * chat completion test tool). Created lazily on first use — exactly the shape
 * the Hono route used to create per mount (one per app), never per request —
 * Admission is always on: both transports share this runtime, and there is
 * no in-memory limiter fallback when it is absent.
 */
let sharedDiagnosticsCapacityRuntime: CapacityAdmissionRuntime | undefined;

export function diagnosticsCapacityRuntime(): CapacityAdmissionRuntime {
  sharedDiagnosticsCapacityRuntime ??= new StoreCapacityAdmissionRuntime(
    new PostgresCapacityAdmissionStore(),
  );
  return sharedDiagnosticsCapacityRuntime;
}

// ---------------------------------------------------------------------------
// Pool member chat probe core
// ---------------------------------------------------------------------------

/** Typed outcomes of a pool member test probe (mapped, never a raw error). */
export type PoolMemberTestResult =
  | { outcome: "ok"; status: number; latencyMs: number }
  | { outcome: "not-found" }
  | { outcome: "not-relay-capable" }
  | { outcome: "unpublished" }
  | { outcome: "not-chat-capable" }
  | { outcome: "cli-disconnected" }
  | { outcome: "rate-limited" }
  | { outcome: "probe-failed"; status: number; latencyMs: number; reason: string }
  | { outcome: "probe-error"; latencyMs: number; reason: string };

/** One relay-capable model view (shared by both resolution arms below). */
const poolMemberModelSelect = {
  id: true,
  published: true,
  upstreamModelId: true,
  capabilityOverrideMode: true,
  capabilityOverrides: true,
  capabilityOverrideMetadata: true,
  Endpoint: {
    select: {
      published: true,
      slug: true,
      cliDeviceId: true,
      capabilityMetadata: true,
      defaultCapabilities: true,
      CliDevice: { select: { status: true } },
    },
  },
} satisfies Prisma.DiscoveredModelSelect;

/** EXACT select from the original Hono route (ownership + capability views). */
const poolMemberTestSelect = {
  id: true,
  ModelPool: { select: { userId: true } },
  ExecutionTarget: {
    select: {
      DiscoveredModel: { select: poolMemberModelSelect },
    },
  },
  DiscoveredModel: { select: poolMemberModelSelect },
} satisfies Prisma.PoolMemberSelect;

type PoolMemberTestRow = Prisma.PoolMemberGetPayload<{ select: typeof poolMemberTestSelect }>;

/**
 * Run the chat-completions probe against one pool member, owned by `userId`.
 * The `tokenId` used for the global concurrency lease is the SAME stable
 * diagnostic identity the original route used
 * (`pool-member-test:<userId>`); MCP callers inherit the identical lease
 * bucket and limits.
 */
export async function runPoolMemberTest({
  userId,
  memberId,
  signal,
  manager = relaySessionManager,
  concurrencyLimiter = modelApiConcurrencyLimiter,
}: {
  userId: string;
  memberId: string;
  /**
   * Caller-owned cancellation (G1): the MCP wrapper passes the verified
   * request's admission signal so client aborts / shutdown cancel the relay
   * attempt; the Hono route passes the HTTP request signal. Optional —
   * older callers keep the pre-existing behavior.
   */
  signal?: AbortSignal;
} & DiagnosticCoreDependencies): Promise<PoolMemberTestResult> {
  const member: PoolMemberTestRow | null = await prisma.poolMember.findUnique({
    where: { id: memberId },
    select: poolMemberTestSelect,
  });
  // G1: post-lookup cancellation check. The ownership lookup is the core's
  // first await — a caller (or the shutdown gate) that aborted while it was
  // parked must not let the resumed continuation proceed to capability
  // checks, lease acquisition, or a NEW relay dispatch. The boundary: work
  // that already started may finish; no new work starts after the abort.
  if (signal?.aborted) {
    return { outcome: "probe-error", latencyMs: 0, reason: "Member test was cancelled." };
  }
  if (!member || member.ModelPool.userId !== userId) {
    return { outcome: "not-found" };
  }
  const model = member.ExecutionTarget?.DiscoveredModel ?? member.DiscoveredModel;
  if (!model) {
    return { outcome: "not-relay-capable" };
  }
  if (!model.published || !model.Endpoint.published) {
    return { outcome: "unpublished" };
  }
  const supportsChat = supportsChatCompletions({
    capabilities: resolveEffectiveCapabilityMetadata({
      capabilityOverrideMode: model.capabilityOverrideMode,
      capabilityOverrideMetadata: model.capabilityOverrideMetadata,
      endpointCapabilityMetadata: model.Endpoint.capabilityMetadata,
    }),
    coarse:
      model.capabilityOverrideMode === "OVERRIDE"
        ? model.capabilityOverrides
        : model.Endpoint.defaultCapabilities,
  });
  if (!supportsChat) {
    return { outcome: "not-chat-capable" };
  }
  if (!manager.getActiveCliDeviceIds().includes(model.Endpoint.cliDeviceId)) {
    return { outcome: "cli-disconnected" };
  }

  const startedAt = Date.now();
  let globalLease: ModelApiLimitLease | null = null;
  let cliLease: ModelApiLimitLease | null = null;
  try {
    globalLease = concurrencyLimiter.acquireGlobal({
      tokenId: `pool-member-test:${userId}`,
      userId,
    });
    cliLease = concurrencyLimiter.acquireCli(model.Endpoint.cliDeviceId);
  } catch (error) {
    globalLease?.release();
    cliLease?.release();
    if (error instanceof ModelApiLimitError) {
      return { outcome: "rate-limited" };
    }
    throw error;
  }

  const body = new TextEncoder().encode(
    JSON.stringify({
      model: model.upstreamModelId,
      stream: false,
      max_tokens: 8,
      messages: [{ role: "user", content: "Reply with the single word pong." }],
    }),
  );
  const attempt = startRelayAttempt({
    manager,
    cliDeviceId: model.Endpoint.cliDeviceId,
    endpointSlug: model.Endpoint.slug,
    family: "chat.completions",
    method: "POST",
    path: "/v1/chat/completions",
    headers: new Headers({ "content-type": "application/json" }),
    body,
    timeoutMs: TEST_TIMEOUT_MS,
    abortSignal: signal,
  });

  try {
    const started = await attempt.started;
    const rawText = await readResponseUtf8(started.body);
    const terminal = await attempt.terminal;
    const latencyMs = Date.now() - startedAt;
    if (!terminal.ok || !isSuccessfulChatProbeReply(started.status, rawText)) {
      return {
        outcome: "probe-failed",
        status: started.status,
        latencyMs,
        reason: terminal.failure
          ? `Member test failed (${terminal.failure}).`
          : "Member did not return a valid chat completion containing pong.",
      };
    }
    await markPoolMemberRelaySuccess(member.id);
    return { outcome: "ok", status: started.status, latencyMs };
  } catch (error) {
    // G2 (stable outcomes only): the caught error can be ANY failure — a
    // Prisma error from health marking (SQL/credential material in the
    // message), a relay transport failure, an abort. Its message NEVER
    // crosses the outcome boundary; both transports surface the SAME
    // stable reason. One sanitized log line (Part D, ctor-only) keeps the
    // failure observable server-side.
    console.error(
      `pool member test probe failed (${
        error instanceof Error ? error.constructor.name : typeof error
      })`,
    );
    return {
      outcome: "probe-error",
      latencyMs: Date.now() - startedAt,
      reason: "Member test failed.",
    };
  } finally {
    cliLease.release();
    globalLease.release();
  }
}

// ---------------------------------------------------------------------------
// Chat completion diagnostic core
// ---------------------------------------------------------------------------

/** Bounded, provider-safe assistant excerpt length for diagnostic summaries. */
export const CHAT_DIAGNOSTIC_MAX_TEXT_CHARS = 2_000;

/** Cap on the raw upstream body the diagnostic will read before projecting. */
const CHAT_DIAGNOSTIC_MAX_BODY_BYTES = 256 * 1024;

/** Typed, JSON-safe outcome of a chat completion diagnostic (never the raw body). */
export type ChatCompletionDiagnosticResult =
  | {
      outcome: "ok";
      status: number;
      model: string | null;
      finishReason: string | null;
      assistantText: string | null;
      usage: { promptTokens: number | null; completionTokens: number | null } | null;
    }
  | { outcome: "upstream-rejected"; status: number; errorType: string | null }
  | { outcome: "invalid-request"; reason: string }
  | { outcome: "unparseable-response"; status: number }
  | { outcome: "no-completion"; status: number }
  | { outcome: "error" };

interface ChatCompletionDiagnosticInput {
  /** OpenAI-compatible chat completion request body (model, messages, ...). */
  body: Record<string, unknown>;
}

/**
 * Run one chat completion through the production chat-test core
 * (`chatTestCompletionsHandler`) as `userId`, through the SINGLETON relay
 * manager, concurrency limiter, and the SHARED diagnostics capacity runtime.
 *
 * `stream` is forced to `false`: the diagnostic must terminate with one JSON
 * body (the MCP transport is JSON-response-mode only; an SSE completion would
 * be dropped mid-stream).
 *
 * The upstream body is read ONLY to project the bounded summary below — the
 * raw provider response, headers, and error messages never leave this
 * function. Upstream failures surface as the provider's OpenAI error
 * `type`/status (stable enums), never the provider's message text.
 */
export async function runChatCompletionDiagnostic({
  userId,
  body,
  signal,
  manager = relaySessionManager,
  concurrencyLimiter = modelApiConcurrencyLimiter,
  capacityRuntime,
}: {
  userId: string;
  /**
   * Caller-owned cancellation (G1): threaded into the synthetic Request so
   * the production chat-test core (which dispatches on `request.signal`)
   * tears the relay attempt down on client abort / shutdown.
   */
  signal?: AbortSignal;
} & DiagnosticCoreDependencies &
  ChatCompletionDiagnosticInput): Promise<ChatCompletionDiagnosticResult> {
  const request = new Request("http://diagnostic.internal/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new TextEncoder().encode(JSON.stringify({ ...body, stream: false })),
    signal,
  });
  const response = await chatTestCompletionsHandler({
    request,
    userId,
    manager,
    limiter: concurrencyLimiter,
    capacityRuntime: capacityRuntime ?? diagnosticsCapacityRuntime(),
    source: "MCP",
  });

  if (response.status === 400) {
    // G7: an upstream 400 is NOT necessarily local validation — a relayed
    // upstream rejection can carry a CAPACITY LEASE whose release requires
    // the response body reaching EOF, being cancelled, or the signal
    // aborting (holdCapacityLeaseForResponse). Consume/cancel the body on
    // this exit (and let the signal abort do the same) so the lease never
    // leaks with a heartbeat running. For the core's OWN app-authored 400
    // the cancel is a no-op on an already-terminal small body.
    await response.body?.cancel().catch(() => undefined);
    // The core's own request validation failure (missing model, malformed
    // body). Its error body is app-authored, but stay structural: a stable
    // reason is derived from whether a model field was present at all.
    return { outcome: "invalid-request", reason: "chat completion request rejected" };
  }

  const raw = await readResponseUtf8(response.body, {
    maxBytes: CHAT_DIAGNOSTIC_MAX_BODY_BYTES,
  });
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (parsed === null || typeof parsed !== "object") {
    return { outcome: "unparseable-response", status: response.status };
  }
  if (!response.ok) {
    const errorType = readErrorType(parsed);
    return { outcome: "upstream-rejected", status: response.status, errorType };
  }
  const completion = parsed as {
    model?: unknown;
    choices?: unknown;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  };
  const assistantText = extractAssistantTextFromChatCompletion(completion);
  if (assistantText === null) {
    return { outcome: "no-completion", status: response.status };
  }
  const firstChoice = Array.isArray(completion.choices)
    ? (completion.choices[0] as { finish_reason?: unknown } | undefined)
    : undefined;
  return {
    outcome: "ok",
    status: response.status,
    model: typeof completion.model === "string" ? completion.model : null,
    finishReason: typeof firstChoice?.finish_reason === "string" ? firstChoice.finish_reason : null,
    assistantText: assistantText.slice(0, CHAT_DIAGNOSTIC_MAX_TEXT_CHARS),
    usage:
      completion.usage && typeof completion.usage === "object"
        ? {
            promptTokens: numberOrNull(completion.usage.prompt_tokens),
            completionTokens: numberOrNull(completion.usage.completion_tokens),
          }
        : null,
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Provider error `type` values treated as stable enums (G2). Anything a
 * provider sends that is NOT in this set is mapped to the generic
 * `provider_error` kind — an arbitrary upstream string (which could carry
 * provider-internal detail) never crosses the diagnostic boundary as-is.
 */
const KNOWN_PROVIDER_ERROR_TYPES: ReadonlySet<string> = new Set([
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "rate_limit_error",
  "rate_limit_exceeded",
  "insufficient_quota",
  "server_error",
  "api_error",
  "overloaded_error",
  "context_length_exceeded",
  "request_too_large",
]);

/** Generic stable kind substituted for unknown provider error types (G2). */
export const GENERIC_PROVIDER_ERROR_TYPE = "provider_error";

/** OpenAI-style `error.type` from a non-2xx body (allowlisted enum only). */
function readErrorType(parsed: object): string | null {
  const error = (parsed as { error?: unknown }).error;
  if (error !== null && typeof error === "object" && error !== undefined) {
    const type = (error as { type?: unknown }).type;
    if (typeof type === "string") {
      return KNOWN_PROVIDER_ERROR_TYPES.has(type) ? type : GENERIC_PROVIDER_ERROR_TYPE;
    }
  }
  return null;
}
