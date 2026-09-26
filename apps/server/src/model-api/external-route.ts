/**
 * Caller opt-in for external (provider) fallback.
 *
 * Request data leaves the deployment for a provider only when ALL of these
 * hold (the "egress gate"):
 *   1. the deployment switch WMP_PUBLIC_PROVIDER_EGRESS_ENABLED is on;
 *   2. the caller asked for it in the model name: `owner/pool:external`;
 *   3. the caller's credential consents: an API token with `allowExternal`
 *      (ALLOWLIST tokens also need the pool entry's `includeExternal`), or the
 *      signed-in user's own Chat Test session choosing the `:external` name;
 *   4. the pool owner enabled fallback (`fallbackEnabled`);
 *   5. the requester is the pool owner, or the owner pays for grantees
 *      (`fallbackForGrantees`).
 *
 * `evaluateExternalEgress` is the only way to obtain an
 * `ExternalEgressConsent`. Provider dispatch (`dispatchPublicOverflow`)
 * requires an issued consent for the exact pool and re-checks the switch and
 * the pool flags against fresh database state, so a missing or forged consent
 * fails closed.
 */
import type {
  VisibleDirectModelTarget,
  VisibleModelPoolTarget,
} from "@ws-model-proxy/api/lib/model-api-token-access";
import { env } from "@ws-model-proxy/env/server";
import { anthropicErrorResponse } from "./anthropic-protocol.js";
import { openAiErrorBody } from "./openai-errors.js";

/** The only v1 model-name variant. Lowercase only; never stacked. */
export const EXTERNAL_MODEL_VARIANT = "external";

export const ROUTE_HEADER = "x-wsmp-route";
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
export type FallbackRoute = "local" | "pool-external";

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
  | "external_unavailable";

export type ExternalRouteError = { code: ExternalRouteErrorCode; message: string };

const errorStatus: Record<ExternalRouteErrorCode, number> = {
  model_not_found: 404,
  external_providers_disabled: 403,
  external_not_permitted: 403,
  external_variant_unsupported: 400,
  external_not_supported_for_mcp: 400,
  forced_member_requires_external: 400,
  external_required: 400,
  external_unavailable: 503,
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
  | { kind: "direct"; target: VisibleDirectModelTarget }
  | { kind: "pool"; target: VisibleModelPoolTarget; externalRequested: boolean }
  | { kind: "error"; error: ExternalRouteError }
  | { kind: "not_found" };

/**
 * Resolves a requested model name against the caller's VISIBLE targets only,
 * so no error ever reveals whether an invisible pool exists. The grammar is
 * `user-slug/pool-slug[:external]`; a suffix is recognised only when the part
 * before it exactly matches a visible pool (pool-shaped by construction).
 */
export function resolveRequestedModelName(
  targets: {
    directModels: readonly VisibleDirectModelTarget[];
    modelPools: readonly VisibleModelPoolTarget[];
  },
  model: string,
): ModelNameResolution {
  const direct = targets.directModels.find((target) => target.modelId === model);
  if (direct) return { kind: "direct", target: direct };
  const pool = targets.modelPools.find((target) => target.modelId === model);
  if (pool) return { kind: "pool", target: pool, externalRequested: false };
  const { base, variant } = splitModelVariant(model);
  if (variant === null) return { kind: "not_found" };
  const basePool = targets.modelPools.find((target) => target.modelId === base);
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
  const baseDirect = targets.directModels.find((target) => target.modelId === base);
  if (baseDirect)
    return {
      kind: "error",
      error: {
        code: "model_not_found",
        message: `Model "${model}" was not found. Variants such as ":${EXTERNAL_MODEL_VARIANT}" apply only to pool model ids (owner/pool); direct model ids never take a suffix. Use "${baseDirect.modelId}".`,
      },
    };
  return { kind: "not_found" };
}

export type ExternalEgressDenial =
  | "NOT_REQUESTED"
  | "DEPLOYMENT_DISABLED"
  | "SOURCE_UNSUPPORTED"
  | "TOKEN_NOT_PERMITTED"
  | "POOL_FALLBACK_DISABLED"
  | "GRANTEE_NOT_COVERED";

export type ExternalEgressConsent = {
  readonly poolId: string;
  readonly ownerUserId: string;
  readonly requesterUserId: string;
  readonly requesterIsOwner: boolean;
  readonly modelApiTokenId: string | null;
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
  source: "API_TOKEN" | "CHAT_TEST" | "MCP" | "TRANSFORMER";
  modelApiTokenId: string | null;
};

export type ExternalEgressPool = Pick<
  VisibleModelPoolTarget,
  "id" | "ownerUserId" | "fallbackEnabled" | "fallbackForGrantees"
>;

export type ExternalEgressDecision =
  | { granted: true; consent: ExternalEgressConsent }
  | { granted: false; denial: ExternalEgressDenial };

/**
 * Evaluates the five egress conditions for one request. `tokenPermitsPool` is
 * the API token's consent for this pool (see
 * listVisibleModelTargetsWithExternalPermissionForToken); it is ignored for a
 * signed-in Chat Test session, where choosing the `:external` name is the
 * user's own explicit consent. MCP diagnostics have no consent channel in v1.
 */
export function evaluateExternalEgress(input: {
  requested: boolean;
  requester: ExternalEgressRequester;
  tokenPermitsPool: boolean;
  pool: ExternalEgressPool;
  deploymentSwitchEnabled?: boolean;
}): ExternalEgressDecision {
  if (!input.requested) return { granted: false, denial: "NOT_REQUESTED" };
  const switchEnabled = input.deploymentSwitchEnabled ?? env.WMP_PUBLIC_PROVIDER_EGRESS_ENABLED;
  if (switchEnabled !== true) return { granted: false, denial: "DEPLOYMENT_DISABLED" };
  if (input.requester.source === "API_TOKEN") {
    if (!input.requester.modelApiTokenId || input.tokenPermitsPool !== true)
      return { granted: false, denial: "TOKEN_NOT_PERMITTED" };
  } else if (input.requester.source !== "CHAT_TEST") {
    return { granted: false, denial: "SOURCE_UNSUPPORTED" };
  }
  if (input.pool.fallbackEnabled !== true)
    return { granted: false, denial: "POOL_FALLBACK_DISABLED" };
  const requesterIsOwner = input.requester.userId === input.pool.ownerUserId;
  if (!requesterIsOwner && input.pool.fallbackForGrantees !== true)
    return { granted: false, denial: "GRANTEE_NOT_COVERED" };
  const consent: ExternalEgressConsent = Object.freeze({
    poolId: input.pool.id,
    ownerUserId: input.pool.ownerUserId,
    requesterUserId: input.requester.userId,
    requesterIsOwner,
    modelApiTokenId: input.requester.modelApiTokenId,
  });
  issuedConsents.add(consent);
  return { granted: true, consent };
}

/** Caller-facing error for a denial that must stop the request (not serve local). */
export function externalDenialError(
  denial: ExternalEgressDenial,
  pool: Pick<VisibleModelPoolTarget, "modelId">,
): ExternalRouteError | null {
  if (denial === "DEPLOYMENT_DISABLED")
    return {
      code: "external_providers_disabled",
      message: `External providers are disabled on this deployment. Use "${pool.modelId}" to use local members only.`,
    };
  if (denial === "TOKEN_NOT_PERMITTED")
    return {
      code: "external_not_permitted",
      message: `This API token does not allow external providers for "${pool.modelId}". A person can enable "Allow external providers" on the token (and include this pool for allowlist tokens) in the dashboard, or use "${pool.modelId}" to use local members only.`,
    };
  if (denial === "SOURCE_UNSUPPORTED")
    return {
      code: "external_not_supported_for_mcp",
      message: `MCP diagnostics cannot use external providers. Use "${pool.modelId}".`,
    };
  return null;
}

/** Why no external plan exists for an allowed-but-unavailable request (D5 header path). */
export function externalUnavailableMessage(
  denial: ExternalEgressDenial | "NO_EXTERNAL_MEMBERS",
  pool: Pick<VisibleModelPoolTarget, "modelId">,
): string {
  if (denial === "POOL_FALLBACK_DISABLED")
    return `The owner of "${pool.modelId}" has not enabled external fallback, and the pool has no local members that can serve this request.`;
  if (denial === "GRANTEE_NOT_COVERED")
    return `The owner of "${pool.modelId}" has not enabled external fallback for people they share the pool with, and the pool has no local members that can serve this request.`;
  return `"${pool.modelId}" has no available external fallback members and no local members that can serve this request.`;
}
