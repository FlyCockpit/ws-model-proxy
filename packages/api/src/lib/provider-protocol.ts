export type ProviderProtocol = "openai" | "anthropic";
export type ProviderInventoryProtocol = "openai-compatible" | "anthropic-compatible";

const PROVIDER_PROTOCOL_BY_TYPE = {
  anthropic: "anthropic",
  "anthropic-compatible": "anthropic",
  openai: "openai",
  "openai-compatible": "openai",
  // OpenRouter's Chat Completions API is OpenAI-compatible and the only
  // surface claimed (see PROVIDER_ALLOWED_SURFACES). Checked against docs, not
  // live (2026-09-26, no key used):
  // - Anthropic Messages (base https://openrouter.ai/api): authenticates with
  //   `Authorization: Bearer <key>` and `x-api-key` left blank; a non-blank
  //   `x-api-key` is treated as a direct-Anthropic credential
  //   (openrouter.ai/docs/cookbook/coding-agents/claude-code-integration).
  //   A BEARER account could therefore serve it, but it stays unclaimed.
  // - Responses API: documented as beta and stateless (no stored responses,
  //   so no previous_response_id follow-ups, retrieve or cancel;
  //   openrouter.ai/docs/api_reference/responses/overview). Unclaimed:
  //   Responses clients are adapted to Chat Completions.
  openrouter: "openai",
} as const satisfies Record<string, ProviderProtocol>;

export type ProviderType = keyof typeof PROVIDER_PROTOCOL_BY_TYPE;

/** `anthropic-version` WMP sends to Anthropic when the caller named none. */
export const ANTHROPIC_DEFAULT_API_VERSION = "2023-06-01";

/**
 * Preset base URL for provider types with one well-known endpoint. These are
 * API roots without a version segment: request paths such as
 * `/v1/chat/completions` are appended to them (see `providerRequestPathname`).
 */
export const PROVIDER_PRESET_BASE_URL = {
  openrouter: "https://openrouter.ai/api",
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
} as const satisfies Partial<Record<ProviderType, string>>;

/**
 * Join a provider base URL path with a request path such as
 * `/v1/chat/completions`. Request paths carry their own `/v1` version prefix,
 * while providers commonly document their base URL with it
 * (`https://api.openai.com/v1`). When the base path already ends in a `/v1`
 * segment, the request's leading `/v1` is dropped instead of doubled, so a
 * stored `.../v1` base keeps working. Other prefixes (`/openai`, `/api`,
 * `/v1beta`) are kept as-is. Mirrors the CLI relay's `endpoint_url`.
 */
export function providerRequestPathname(basePathname: string, requestPathname: string): string {
  const base = basePathname.replace(/\/+$/u, "");
  const request = requestPathname.startsWith("/") ? requestPathname : `/${requestPathname}`;
  const baseIsVersioned = base === "/v1" || base.endsWith("/v1");
  if (baseIsVersioned && (request === "/v1" || request.startsWith("/v1/"))) {
    return `${base}${request.slice("/v1".length)}`;
  }
  return `${base}${request}`;
}

type CredentialProbe = {
  path: string;
  headers?: Readonly<Record<string, string>>;
  /**
   * Whether the endpoint is known to require the key, so a 2xx proves the
   * key was accepted. False means a 2xx may only show the endpoint is public.
   */
  verifiesCredential: boolean;
};

/**
 * Authenticated endpoint used by "Test credential", relative to the account
 * base URL. API roots do not tell a valid key from an invalid one (OpenAI's
 * answers 421, Anthropic's and OpenRouter's 404, with or without a key; a
 * gateway's root may be a public landing or health page).
 * - openrouter `GET /v1/key`: 401 for a missing or bogus key (checked live).
 * - openai `GET /v1/models`: Bearer-authenticated model list; 401 for a bad key.
 * - anthropic `GET /v1/models`: needs `x-api-key` and `anthropic-version`;
 *   401 for a bad key.
 * - `-compatible` types probe their family's conventional `GET /v1/models`,
 *   but no endpoint is known to require a key on every implementation (many
 *   serve the model list publicly, some not at all). A 401 there still
 *   shows the key was not accepted; anything else is inconclusive, never a
 *   pass.
 * On every type a 403 is inconclusive: the key may only lack permission to
 * list models (see `classifyCredentialProbeStatus`).
 */
const PROVIDER_CREDENTIAL_PROBE = {
  openrouter: { path: "/v1/key", verifiesCredential: true },
  openai: { path: "/v1/models", verifiesCredential: true },
  anthropic: {
    path: "/v1/models",
    headers: { "anthropic-version": ANTHROPIC_DEFAULT_API_VERSION },
    verifiesCredential: true,
  },
  "openai-compatible": { path: "/v1/models", verifiesCredential: false },
  "anthropic-compatible": {
    path: "/v1/models",
    headers: { "anthropic-version": ANTHROPIC_DEFAULT_API_VERSION },
    verifiesCredential: false,
  },
} as const satisfies Record<ProviderType, CredentialProbe>;

/**
 * Request "Test credential" sends. It is always on the account's own base URL
 * (same origin and path prefix), so the key goes nowhere new. Unknown types
 * are refused before egress; if one reaches here it probes nothing new (the
 * base URL itself) and can never verify.
 */
export function providerCredentialProbe(
  providerType: string,
  baseUrl: string,
): { url: string; headers: Record<string, string>; verifiesCredential: boolean } {
  const headers: Record<string, string> = { accept: "application/json" };
  const normalized = normalizedType(providerType);
  if (!Object.hasOwn(PROVIDER_CREDENTIAL_PROBE, normalized))
    return { url: baseUrl, headers, verifiesCredential: false };
  const probe: CredentialProbe =
    PROVIDER_CREDENTIAL_PROBE[normalized as keyof typeof PROVIDER_CREDENTIAL_PROBE];
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    // The egress layer rejects the invalid base URL itself.
    return { url: baseUrl, headers, verifiesCredential: probe.verifiesCredential };
  }
  url.pathname = providerRequestPathname(url.pathname, probe.path);
  return {
    url: url.toString(),
    headers: { ...headers, ...probe.headers },
    verifiesCredential: probe.verifiesCredential,
  };
}

/**
 * Credential-test result from the probe's HTTP status.
 * - SUCCESS: 2xx from an endpoint known to require the key.
 * - FAILURE / INVALID_CREDENTIAL: 401, the key was not accepted.
 * - FAILURE / UNEXPECTED_STATUS: another status from an endpoint known to
 *   require the key.
 * - INCONCLUSIVE / INSUFFICIENT_PERMISSION: 403, the request was recognised but
 *   this key may not list models (an inference-only, restricted or project
 *   key); it may still work for inference. Applies to every provider type.
 * - INCONCLUSIVE / UNVERIFIED or UNEXPECTED_STATUS: the endpoint is not known
 *   to require a key, so a 2xx or another status says nothing about the key.
 */
export type CredentialProbeResult =
  | { ok: true; outcome: "SUCCESS"; reason: null }
  | { ok: false; outcome: "FAILURE"; reason: "INVALID_CREDENTIAL" | "UNEXPECTED_STATUS" }
  | {
      ok: false;
      outcome: "INCONCLUSIVE";
      reason: "INSUFFICIENT_PERMISSION" | "UNVERIFIED" | "UNEXPECTED_STATUS";
    };

export function classifyCredentialProbeStatus(
  statusCode: number | null,
  verifiesCredential: boolean,
): CredentialProbeResult {
  if (statusCode === 401) return { ok: false, outcome: "FAILURE", reason: "INVALID_CREDENTIAL" };
  if (statusCode === 403)
    return { ok: false, outcome: "INCONCLUSIVE", reason: "INSUFFICIENT_PERMISSION" };
  const success = statusCode !== null && statusCode >= 200 && statusCode < 300;
  if (verifiesCredential)
    return success
      ? { ok: true, outcome: "SUCCESS", reason: null }
      : { ok: false, outcome: "FAILURE", reason: "UNEXPECTED_STATUS" };
  return {
    ok: false,
    outcome: "INCONCLUSIVE",
    reason: success ? "UNVERIFIED" : "UNEXPECTED_STATUS",
  };
}

/**
 * Native inventory surfaces a provider type may declare. Types absent here
 * accept every surface their protocol allows. Restricted types must use the
 * v4 inventory, whose shape cannot claim surfaces through legacy fields.
 */
const PROVIDER_ALLOWED_SURFACES = {
  openrouter: ["openaiChatCompletions"],
} as const satisfies Partial<Record<ProviderType, readonly string[]>>;

function normalizedType(providerType: string): string {
  return providerType.trim().toLowerCase();
}

/** Resolve only explicitly supported provider types. Unknown types fail closed. */
export function providerProtocolForType(providerType: string): ProviderProtocol | null {
  const normalized = normalizedType(providerType);
  return Object.hasOwn(PROVIDER_PROTOCOL_BY_TYPE, normalized)
    ? PROVIDER_PROTOCOL_BY_TYPE[normalized as ProviderType]
    : null;
}

export function inventoryProtocolForProviderType(
  providerType: string,
): ProviderInventoryProtocol | null {
  const protocol = providerProtocolForType(providerType);
  return protocol === null ? null : `${protocol}-compatible`;
}

/**
 * Whether an inventory declares only surfaces this provider type may serve.
 * Unknown provider types fail closed; the protocol match is checked separately.
 */
export function providerInventorySurfacesAllowed(
  providerType: string,
  inventory: { version: number; surfaces?: Record<string, unknown> },
): boolean {
  const normalized = normalizedType(providerType);
  if (providerProtocolForType(normalized) === null) return false;
  if (!Object.hasOwn(PROVIDER_ALLOWED_SURFACES, normalized)) return true;
  const allowed: readonly string[] =
    PROVIDER_ALLOWED_SURFACES[normalized as keyof typeof PROVIDER_ALLOWED_SURFACES];
  if (inventory.version !== 4 || !inventory.surfaces) return false;
  return Object.entries(inventory.surfaces).every(
    ([surface, value]) => value === undefined || allowed.includes(surface),
  );
}
