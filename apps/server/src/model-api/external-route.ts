/**
 * Caller opt-in for external (provider) fallback.
 *
 * Request data leaves the deployment for a provider only when ALL of these
 * hold (the "egress gate"):
 *   1. the deployment switch WMP_PUBLIC_PROVIDER_EGRESS_ENABLED is on;
 *   2. the caller asked for it in the model name: `owner/pool:external` (an API key, or a
 *      person's own Test page request; agent tests have no consent channel);
 *   3. the pool's cloud mode covers the caller (`pool_fallback.mode`: OWNER for the owner,
 *      OWNER_AND_SHARES for share holders too; OFF: nobody). Own-key instead requires the
 *      owner's equivalent-model consent and the share holder's own provider model.
 *
 * `evaluateExternalEgress` is the only way to obtain an
 * `ExternalEgressConsent`. Provider dispatch (`dispatchPublicOverflow`)
 * requires an issued consent for the exact pool and requester, and re-checks
 * the switch, the cloud mode and the requester's share against fresh database
 * state immediately before sending, so a missing, forged, or withdrawn consent
 * fails closed.
 */
import { env } from "@ws-model-proxy/env/server";
import { anthropicErrorResponse } from "./anthropic-protocol.js";
import { openAiErrorBody } from "./openai-errors.js";
import type { CallablePool, TestTarget } from "./resolve.js";

/** The only v1 model-name variant. Lowercase only; never stacked. */
export const EXTERNAL_MODEL_VARIANT = "external";

export const ROUTE_HEADER = "x-wsmp-route";
/**
 * Why an external response was used: `local_wait_expired`,
 * `local_saturated_protected` (S-C: the only local members with an idle slot
 * hold protected warm sessions), `no_local_member`, `local_context_ceiling`,
 * or `local_failure`.
 */
export const FALLBACK_REASON_HEADER = "x-wsmp-fallback-reason";
export const SERVED_MODEL_HEADER = "x-wsmp-served-model";
export const FALLBACK_HEADER = "x-wsmp-fallback";
export const ROUTE_EXPOSE_HEADERS = [
  ROUTE_HEADER,
  FALLBACK_REASON_HEADER,
  SERVED_MODEL_HEADER,
  FALLBACK_HEADER,
] as const;

/** Durable, prompt-free route values (RelayRequest / stickiness `fallbackRoute`). */
export type FallbackRoute = "local" | "pool-external" | "own-key";

export function externalModelId(poolModelId: string): string {
  return `${poolModelId}:${EXTERNAL_MODEL_VARIANT}`;
}

type SplitModelName = { base: string; variant: string | null };

/** Splits at the first `:`. Canonical pool and direct ids never contain a raw `:`. */
export function splitModelVariant(model: string): SplitModelName {
  const index = model.indexOf(":");
  if (index < 0) return { base: model, variant: null };
  return { base: model.slice(0, index), variant: model.slice(index + 1) };
}

export type ExternalRouteErrorCode =
  | "model_not_found"
  | "external_providers_disabled"
  | "external_not_permitted"
  | "external_variant_unsupported"
  | "external_not_supported_for_mcp"
  | "forced_member_requires_external"
  | "external_required"
  | "external_unavailable"
  | "grantee_spend_cap"
  | "local_members_required"
  /** D9: OpenRouter has no upstream provider that accepts `data_collection: "deny"`. */
  | "provider_data_policy_unavailable";

export type ExternalRouteError = { code: ExternalRouteErrorCode; message: string };

/** Non-leaky refusal when a share holder's owner-paid spend cap is exhausted. */
export const GRANTEE_SPEND_CAP_MESSAGE = "External fallback is not available for this access.";

const errorStatus: Record<ExternalRouteErrorCode, number> = {
  model_not_found: 404,
  external_providers_disabled: 403,
  external_not_permitted: 403,
  external_variant_unsupported: 400,
  external_not_supported_for_mcp: 400,
  forced_member_requires_external: 400,
  external_required: 400,
  external_unavailable: 503,
  grantee_spend_cap: 429,
  local_members_required: 400,
  provider_data_policy_unavailable: 503,
};

/**
 * Renders the error in the requested surface's shape: an OpenAI error object,
 * or an Anthropic `{type:"error"}` envelope for the Messages surface.
 */
export function externalRouteErrorResponse(
  family: string,
  error: ExternalRouteError,
  extraHeaders?: Record<string, string>,
): Response {
  const status = errorStatus[error.code];
  const response =
    family === "messages"
      ? anthropicErrorResponse(
          status,
          error.message,
          status === 404
            ? "not_found_error"
            : status === 403
              ? "permission_error"
              : status === 429
                ? "rate_limit_error"
                : status >= 500
                  ? "api_error"
                  : "invalid_request_error",
        )
      : new Response(
          JSON.stringify(
            openAiErrorBody({
              message: error.message,
              type:
                status === 404
                  ? "invalid_request_error"
                  : status === 403
                    ? "permission_error"
                    : status === 429
                      ? "rate_limit_error"
                      : status >= 500
                        ? "api_error"
                        : "invalid_request_error",
              param: error.code === "model_not_found" ? "model" : null,
              code: error.code,
            }),
          ),
          { status, headers: { "content-type": "application/json; charset=utf-8" } },
        );
  if (!extraHeaders) return response;
  return withResponseHeaders(response, extraHeaders);
}

/** Adds headers (and exposes them to browsers) without touching the body stream. */
export function withResponseHeaders(
  response: Response,
  extraHeaders: Record<string, string>,
): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  const exposed = headers.get("access-control-expose-headers");
  const names = Object.keys(extraHeaders).filter((name) =>
    (ROUTE_EXPOSE_HEADERS as readonly string[]).includes(name),
  );
  if (names.length > 0) {
    const current = new Set(
      (exposed ?? "")
        .split(",")
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean),
    );
    const missing = names.filter((name) => !current.has(name));
    if (missing.length > 0)
      headers.set(
        "access-control-expose-headers",
        exposed ? `${exposed}, ${missing.join(", ")}` : missing.join(", "),
      );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export type ModelNameResolution =
  | { kind: "test"; target: TestTarget }
  | { kind: "pool"; target: CallablePool; externalRequested: boolean }
  | { kind: "error"; error: ExternalRouteError }
  | { kind: "not_found" };

/**
 * Resolves a requested model name against the caller's VISIBLE targets only,
 * so no error ever reveals whether an invisible pool exists. The grammar is
 * `user-slug/pool-slug[:external]`; a suffix is recognised only when the part
 * before it exactly matches a visible pool (pool-shaped by construction). TEST
 * targets (`runtime:<runtimeId>:<upstreamModelId>`) match exactly and take no suffix.
 */
export function resolveRequestedModelName(
  targets: {
    tests: readonly TestTarget[];
    pools: readonly CallablePool[];
    aliases?: readonly { name: string; poolId: string }[];
  },
  model: string,
): ModelNameResolution {
  const test = targets.tests.find((target) => target.modelId === model);
  if (test) return { kind: "test", target: test };
  const pool = targets.pools.find((target) => target.modelId === model);
  if (pool) return { kind: "pool", target: pool, externalRequested: false };
  // A caller's alias (only ever one of their callable pools; callable IDs win over it).
  const aliased = (name: string) => {
    // A callable ID always wins, in every form (also `name:external`).
    if (targets.pools.some((target) => target.modelId === name)) return undefined;
    const alias = targets.aliases?.find((entry) => entry.name === name);
    return alias ? targets.pools.find((target) => target.id === alias.poolId) : undefined;
  };
  const aliasPool = aliased(model);
  if (aliasPool) return { kind: "pool", target: aliasPool, externalRequested: false };
  // An alias may itself hold a colon (`qwen3:8b`): its `:external` form is the whole suffix.
  const externalSuffix = `:${EXTERNAL_MODEL_VARIANT}`;
  const externalAlias = model.endsWith(externalSuffix)
    ? aliased(model.slice(0, -externalSuffix.length))
    : undefined;
  if (externalAlias) return { kind: "pool", target: externalAlias, externalRequested: true };
  const { base, variant } = splitModelVariant(model);
  if (variant === null) return { kind: "not_found" };
  const basePool = targets.pools.find((target) => target.modelId === base) ?? aliased(base);
  if (basePool) {
    if (variant === EXTERNAL_MODEL_VARIANT)
      return { kind: "pool", target: basePool, externalRequested: true };
    return {
      kind: "error",
      error: {
        code: "model_not_found",
        message: `Unknown model variant ":${variant}". The only supported variant is ":${EXTERNAL_MODEL_VARIANT}" (lowercase, used once), for example "${externalModelId(basePool.modelId)}". Use "${basePool.modelId}" to stay on local members.`,
      },
    };
  }
  return { kind: "not_found" };
}

export type ExternalEgressDenial =
  | "NOT_REQUESTED"
  | "DEPLOYMENT_DISABLED"
  | "SOURCE_UNSUPPORTED"
  | "POOL_FALLBACK_DISABLED"
  | "SHARE_NOT_COVERED";

export type ExternalEgressConsent = {
  readonly poolId: string;
  readonly ownerUserId: string;
  readonly requesterUserId: string;
  readonly requesterIsOwner: boolean;
  readonly apiKeyId: string | null;
  /**
   * The exact share the request was resolved under (null for the pool owner). The send
   * boundary requires this same share row, so a replacement share never revives the request.
   */
  readonly shareId: string | null;
  readonly ownKeyProviderModelId?: string;
};

// Consents are minted only by evaluateExternalEgress. Provider dispatch
// verifies membership, so a structurally identical object never authorizes
// egress.
const issuedConsents = new WeakSet<ExternalEgressConsent>();

export function isIssuedExternalConsent(
  consent: ExternalEgressConsent | null | undefined,
): consent is ExternalEgressConsent {
  return consent !== null && consent !== undefined && issuedConsents.has(consent);
}

export type ExternalEgressRequester = {
  userId: string;
  source: "API_KEY" | "TEST" | "AGENT_TEST" | "SIDECAR";
  apiKeyId: string | null;
};

export type ExternalEgressPool = Pick<
  CallablePool,
  | "id"
  | "ownerUserId"
  | "shareId"
  | "fallbackMode"
  | "externalEquivalentModel"
  | "ownKeyProviderModelId"
>;

export type ExternalEgressDecision =
  | { granted: true; consent: ExternalEgressConsent }
  | { granted: false; denial: ExternalEgressDenial };

/**
 * Evaluates the egress conditions for one request. Asking for `:external` is the caller's
 * consent (an API key or a person's Test page request); agent tests and sidecar hops have no
 * consent channel.
 */
export function evaluateExternalEgress(input: {
  requested: boolean;
  requester: ExternalEgressRequester;
  pool: ExternalEgressPool;
}): ExternalEgressDecision {
  if (!input.requested) return { granted: false, denial: "NOT_REQUESTED" };
  if (env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED !== true)
    return { granted: false, denial: "DEPLOYMENT_DISABLED" };
  if (input.requester.source !== "API_KEY" && input.requester.source !== "TEST")
    return { granted: false, denial: "SOURCE_UNSUPPORTED" };
  const ownKey =
    input.requester.userId !== input.pool.ownerUserId &&
    input.pool.shareId &&
    input.pool.externalEquivalentModel &&
    input.pool.ownKeyProviderModelId;
  if (!ownKey && input.pool.fallbackMode === "OFF")
    return { granted: false, denial: "POOL_FALLBACK_DISABLED" };
  const requesterIsOwner = input.requester.userId === input.pool.ownerUserId;
  if (!ownKey && !requesterIsOwner && input.pool.fallbackMode !== "OWNER_AND_SHARES")
    return { granted: false, denial: "SHARE_NOT_COVERED" };
  const consent: ExternalEgressConsent = Object.freeze({
    poolId: input.pool.id,
    ownerUserId: input.pool.ownerUserId,
    requesterUserId: input.requester.userId,
    requesterIsOwner,
    apiKeyId: input.requester.apiKeyId,
    shareId: requesterIsOwner ? null : input.pool.shareId,
    ...(ownKey ? { ownKeyProviderModelId: ownKey } : {}),
  });
  issuedConsents.add(consent);
  return { granted: true, consent };
}

/** Caller-facing error for a denial that must stop the request (not serve local). */
export function externalDenialError(
  denial: ExternalEgressDenial,
  pool: Pick<CallablePool, "modelId">,
): ExternalRouteError | null {
  if (denial === "DEPLOYMENT_DISABLED")
    return {
      code: "external_providers_disabled",
      message: `Cloud providers are turned off on this server. Use "${pool.modelId}" to use local members only.`,
    };
  if (denial === "SOURCE_UNSUPPORTED")
    return {
      code: "external_not_supported_for_mcp",
      message: `Agent tests cannot use cloud providers. Use "${pool.modelId}".`,
    };
  return null;
}

/** Why no external plan exists for an allowed-but-unavailable request (D5 header path). */
export function externalUnavailableMessage(
  denial: ExternalEgressDenial | "NO_EXTERNAL_MEMBERS",
  pool: Pick<CallablePool, "modelId">,
): string {
  if (denial === "POOL_FALLBACK_DISABLED")
    return `The owner of "${pool.modelId}" has not turned on cloud fallback, and the pool has no local members that can serve this request.`;
  if (denial === "SHARE_NOT_COVERED")
    return `The owner of "${pool.modelId}" has not turned on cloud fallback for people they share the pool with, and the pool has no local members that can serve this request.`;
  return `"${pool.modelId}" has no available external fallback members and no local members that can serve this request.`;
}
