/**
 * User-bound diagnostic cores shared by Hono and MCP. Member probes use
 * production pool routing, original physical capacity, final send permission
 * and usage settlement. Chat probes classify pong/reasoning replies; an
 * embedding-only member receives native vector inference, with no chat affinity.
 * Synthetic requests and responses are never persisted as content.
 */

import {
  openAiCapabilitiesFromCoarse,
  supportsChatCompletions,
} from "@ws-model-proxy/api/lib/openai-compatible-capabilities";
import prisma from "@ws-model-proxy/db";
import { type RelaySessionManager, relaySessionManager } from "../relay/session-manager.js";
import { PostgresCapacityAdmissionStore } from "./capacity/postgres-store.js";
import { withCapacityRequestScope } from "./capacity/request-scope.js";
import {
  type CapacityAdmissionRuntime,
  StoreCapacityAdmissionRuntime,
} from "./capacity/runtime.js";
import { type ModelApiConcurrencyLimiter, modelApiConcurrencyLimiter } from "./limits.js";
import { extractAssistantTextFromChatCompletion, readResponseUtf8 } from "./media-transform.js";
import { PROBE_MAX_TOKENS, probeReasoningFields } from "./probe-settings.js";
import { poolRoutes } from "./resolve.js";
import { poolMemberDiagnosticHandler } from "./routes.js";

const TEST_TIMEOUT_MS = 20_000;
const EXPECTED_PROBE_WORD = /\bpong\b/i;

export const REASONING_ONLY_PROBE_DETAIL =
  "Member is reachable, but the model spent the probe's token budget on reasoning and returned no visible text.";

export type ChatProbeReplyClass = "pong" | "reasoning-only" | "failed";

function nonEmptyReasoning(message: Record<string, unknown>): boolean {
  for (const key of ["reasoning_content", "reasoning"] as const) {
    const value = message[key];
    if (typeof value === "string" && value.trim() !== "") return true;
  }
  const details = message.reasoning_details;
  if (!Array.isArray(details)) return false;
  return details.some((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return false;
    return (["text", "summary"] as const).some((key) => {
      const value = (entry as Record<string, unknown>)[key];
      return typeof value === "string" && value.trim() !== "";
    });
  });
}

/**
 * Classify a probe reply. `pong`: visible text contains the expected word.
 * `reasoning-only`: a 200 that was cut off by the token limit after emitting
 * only reasoning text (the member answered; the model just did not finish).
 * Everything else, including non-JSON bodies and non-200 statuses, is `failed`.
 */
export function classifyChatProbeReply(status: number, rawText: string): ChatProbeReplyClass {
  if (status !== 200) return "failed";
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return "failed";
  }
  if (typeof parsed !== "object" || parsed === null) return "failed";
  const text = extractAssistantTextFromChatCompletion(parsed);
  if (text) return EXPECTED_PROBE_WORD.test(text) ? "pong" : "failed";
  const choice = (parsed as { choices?: unknown }).choices;
  const first: unknown = Array.isArray(choice) ? choice[0] : undefined;
  if (typeof first !== "object" || first === null) return "failed";
  const { finish_reason: finishReason, message } = first as Record<string, unknown>;
  if (
    finishReason === "length" &&
    typeof message === "object" &&
    message !== null &&
    nonEmptyReasoning(message as Record<string, unknown>)
  ) {
    return "reasoning-only";
  }
  return "failed";
}

function classifyEmbeddingProbeReply(status: number, raw: string): ChatProbeReplyClass {
  if (status !== 200) return "failed";
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      !("data" in value) ||
      !Array.isArray(value.data)
    )
      return "failed";
    return value.data.length === 1 &&
      value.data.every(
        (item: unknown) =>
          typeof item === "object" &&
          item !== null &&
          "embedding" in item &&
          Array.isArray(item.embedding) &&
          item.embedding.length > 0 &&
          item.embedding.every((v: unknown) => typeof v === "number" && Number.isFinite(v)),
      )
      ? "pong"
      : "failed";
  } catch {
    return "failed";
  }
}

type DiagnosticsManager = Pick<
  RelaySessionManager,
  | "getOnlineNodeIds"
  | "registerRelayResponseHandlers"
  | "sendRelayRequest"
  | "cancelRelayRequest"
  | "completeRelayRequest"
  | "supportsCountContext"
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
let sharedDiagnosticsCapacityRuntime: StoreCapacityAdmissionRuntime | undefined;
let diagnosticsClosed = false;

export function diagnosticsCapacityRuntime(): CapacityAdmissionRuntime {
  if (diagnosticsClosed) throw new Error("Diagnostics capacity runtime closed.");
  sharedDiagnosticsCapacityRuntime ??= new StoreCapacityAdmissionRuntime(
    new PostgresCapacityAdmissionStore(),
  );
  return sharedDiagnosticsCapacityRuntime;
}

export async function closeDiagnosticsCapacityRuntime(): Promise<void> {
  diagnosticsClosed = true;
  await sharedDiagnosticsCapacityRuntime?.close();
}

// ---------------------------------------------------------------------------
// Pool member chat probe core
// ---------------------------------------------------------------------------

/** Typed outcomes of a pool member test probe (mapped, never a raw error). */
export type PoolMemberTestResult =
  | { outcome: "ok"; status: number; latencyMs: number; detail?: string }
  | { outcome: "not-found" }
  | { outcome: "not-relay-capable" }
  | { outcome: "unpublished" }
  | { outcome: "not-chat-capable" }
  | { outcome: "cli-disconnected" }
  | { outcome: "rate-limited" }
  | { outcome: "probe-failed"; status: number; latencyMs: number; reason: string }
  | { outcome: "probe-error"; latencyMs: number; reason: string };

/**
 * Run the chat-completions probe against one pool member, owned by `userId`.
 * The `tokenId` used for the global concurrency lease is the SAME stable
 * diagnostic identity the original route used
 * (`pool-member-test:<userId>`); MCP callers inherit the identical lease
 * bucket and limits.
 */
export function runPoolMemberTest(
  input: Parameters<typeof poolMemberTest>[0],
): Promise<PoolMemberTestResult> {
  return withCapacityRequestScope(() => poolMemberTest(input));
}

async function poolMemberTest({
  userId,
  memberId,
  signal,
  manager = relaySessionManager,
  concurrencyLimiter = modelApiConcurrencyLimiter,
  capacityRuntime,
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
  const member = await prisma.poolMember.findUnique({
    where: { id: memberId },
    select: { id: true, poolId: true, kind: true, Pool: { select: { userId: true } } },
  });
  // G1: post-lookup cancellation check. The ownership lookup is the core's
  // first await — a caller (or the shutdown gate) that aborted while it was
  // parked must not let the resumed continuation proceed to capability
  // checks, lease acquisition, or a NEW relay dispatch. The boundary: work
  // that already started may finish; no new work starts after the abort.
  if (signal?.aborted) {
    return { outcome: "probe-error", latencyMs: 0, reason: "Member test was cancelled." };
  }
  if (!member || member.Pool.userId !== userId) {
    return { outcome: "not-found" };
  }
  // A LOCAL member is probed through its pool's routes (one per instance serving it).
  const routes =
    member.kind === "LOCAL"
      ? (await poolRoutes(member.poolId)).filter((route) => route.member.id === member.id)
      : [];
  const model = routes[0]?.model;
  if (!model) {
    return { outcome: "not-relay-capable" };
  }
  const effectiveCapabilities = openAiCapabilitiesFromCoarse(model.capabilities);
  const supportsChat = supportsChatCompletions({
    capabilities: effectiveCapabilities,
    coarse: model.capabilities,
  });
  const embeddings = !supportsChat && effectiveCapabilities.embeddings?.supported === true;
  if (!supportsChat && !embeddings) return { outcome: "not-chat-capable" };
  const online = new Set(manager.getOnlineNodeIds());
  if (
    !routes.some(
      (route) => route.instance.ready && route.instance.nodeId && online.has(route.instance.nodeId),
    )
  ) {
    return { outcome: "cli-disconnected" };
  }

  const startedAt = Date.now();
  const body = embeddings
    ? { model: "diagnostic", input: "pong" }
    : {
        model: "diagnostic",
        stream: false,
        max_tokens: PROBE_MAX_TOKENS,
        ...probeReasoningFields(effectiveCapabilities),
        messages: [{ role: "user", content: "Reply with the single word pong." }],
      };
  const request = new Request("http://diagnostic.internal/v1/probe", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-wsmp-chat-test-member-id": member.id,
      "x-wsmp-chat-test-routing-mode": embeddings ? "PREFER_NATIVE" : "REQUIRE_NATIVE",
    },
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(TEST_TIMEOUT_MS)])
      : AbortSignal.timeout(TEST_TIMEOUT_MS),
  });
  try {
    const response = await poolMemberDiagnosticHandler({
      request,
      userId,
      poolId: member.poolId,
      manager,
      limiter: concurrencyLimiter,
      capacityRuntime: capacityRuntime ?? diagnosticsCapacityRuntime(),
      embeddings,
    });
    const status = response.status;
    const rawText = await readResponseUtf8(
      response.body ??
        new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
    );
    if (status === 429) return { outcome: "rate-limited" };
    const latencyMs = Date.now() - startedAt;
    const replyClass = embeddings
      ? classifyEmbeddingProbeReply(status, rawText)
      : classifyChatProbeReply(status, rawText);
    if (replyClass === "failed") {
      return {
        outcome: "probe-failed",
        status,
        latencyMs,
        reason: "Member did not return a valid diagnostic response.",
      };
    }
    // Target health was already settled by the relay path that served the probe.
    return {
      outcome: "ok",
      status,
      latencyMs,
      ...(replyClass === "reasoning-only" ? { detail: REASONING_ONLY_PROBE_DETAIL } : {}),
    };
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
  }
}

/** Generic stable kind substituted for unknown provider error types (G2). */
export const GENERIC_PROVIDER_ERROR_TYPE = "provider_error";
